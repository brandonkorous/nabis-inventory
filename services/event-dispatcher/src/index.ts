import dotenv from 'dotenv';
import { withTransaction } from '@nabis/shared/src/db/client';
import { getChannel, INVENTORY_EVENTS_EXCHANGE } from '@nabis/shared/src/messaging/client';
import { logger } from '@nabis/shared/src/utils/logger';

dotenv.config();

const BATCH_SIZE = parseInt(process.env.EVENT_BATCH_SIZE || '100', 10);
const POLL_INTERVAL_MS = parseInt(process.env.EVENT_POLL_INTERVAL_MS || '200', 10);

class EventDispatcher {
     private running = false;

     async start() {
          this.running = true;
          logger.info(
               { batchSize: BATCH_SIZE, pollIntervalMs: POLL_INTERVAL_MS },
               'Starting event dispatcher'
          );

          while (this.running) {
               try {
                    await this.processBatch();
               } catch (error) {
                    logger.error({ error }, 'Error processing event batch');
               }

               await this.sleep(POLL_INTERVAL_MS);
          }
     }

     async processBatch(): Promise<void> {
          await withTransaction(async (client) => {
               // Get pending events with row-level locking
               const { rows: events } = await client.query<{
                    id: number;
                    type: string;
                    payload: any;
                    created_at: Date;
               }>(
                    `
        SELECT id, type, payload, created_at
        FROM domain_event
        WHERE status = 'PENDING'
        ORDER BY created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `,
                    [BATCH_SIZE]
               );

               if (events.length === 0) {
                    return;
               }

               logger.debug({ eventCount: events.length }, 'Processing event batch');

               const channel = await getChannel();

               for (const event of events) {
                    try {
                         const routingKey = `inventory.${event.type}`;

                         // Publish to RabbitMQ
                         channel.publish(
                              INVENTORY_EVENTS_EXCHANGE,
                              routingKey,
                              Buffer.from(JSON.stringify(event.payload)),
                              {
                                   persistent: true,
                                   contentType: 'application/json',
                                   timestamp: Date.now(),
                                   messageId: event.id.toString(),
                              }
                         );

                         // Mark as sent
                         await client.query(
                              `
            UPDATE domain_event
            SET status = 'SENT', updated_at = NOW()
            WHERE id = $1
          `,
                              [event.id]
                         );

                         logger.debug({ eventId: event.id, type: event.type }, 'Event dispatched');
                    } catch (error) {
                         logger.error({ error, eventId: event.id }, 'Failed to dispatch event');

                         // Mark as failed
                         await client.query(
                              `
            UPDATE domain_event
            SET status = 'FAILED',
                updated_at = NOW(),
                retry_count = retry_count + 1,
                error = $2
            WHERE id = $1
          `,
                              [event.id, error instanceof Error ? error.message : 'Unknown error']
                         );
                    }
               }

               logger.info({ dispatched: events.length }, 'Event batch processed');
          });
     }

     stop() {
          logger.info('Stopping event dispatcher');
          this.running = false;
     }

     private sleep(ms: number): Promise<void> {
          return new Promise((resolve) => setTimeout(resolve, ms));
     }
}

async function main() {
     const dispatcher = new EventDispatcher();

     // Graceful shutdown
     const shutdown = async () => {
          logger.info('Shutting down gracefully...');
          dispatcher.stop();
          await new Promise((resolve) => setTimeout(resolve, 1000));
          process.exit(0);
     };

     process.on('SIGINT', shutdown);
     process.on('SIGTERM', shutdown);

     await dispatcher.start();
}

main().catch((err) => {
     logger.error({ err }, 'Fatal error in event dispatcher');
     process.exit(1);
});
