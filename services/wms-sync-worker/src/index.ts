import dotenv from 'dotenv';
import { withTransaction } from '@nabis/shared/src/db/client';
import { getChannel, WMS_SYNC_QUEUE, ConsumeMessage } from '@nabis/shared/src/messaging/client';
import { createWmsClient } from '@nabis/shared/src/clients/wms-client';
import { WmsSyncService } from '@nabis/shared/src/services/wms-sync-service';
import { logger } from '@nabis/shared/src/utils/logger';

dotenv.config();

const PREFETCH = parseInt(process.env.AMQP_PREFETCH || '5', 10);

class WmsSyncWorker {
     private wmsClient = createWmsClient();
     private syncService = new WmsSyncService();

     async start() {
          logger.info({ prefetch: PREFETCH }, 'Starting WMS sync worker');

          const channel = await getChannel();
          channel.prefetch(PREFETCH);

          channel.consume(WMS_SYNC_QUEUE, async (msg) => {
               if (!msg) return;

               try {
                    await this.processMessage(msg);
                    channel.ack(msg);
               } catch (error) {
                    logger.error({ error }, 'Failed to process sync message');
                    channel.nack(msg, false, false); // Send to DLQ
               }
          });

          logger.info('WMS sync worker started');
     }

     private async processMessage(msg: ConsumeMessage): Promise<void> {
          const payload = JSON.parse(msg.content.toString());
          logger.info({ payload }, 'Processing WMS sync command');

          if (payload.type === 'ForceWmsSync') {
               await this.handleForceSync(payload);
          } else {
               logger.warn({ type: payload.type }, 'Unknown command type');
          }
     }

     private async handleForceSync(payload: {
          syncRequestId: string;
          skuBatchId?: number;
     }): Promise<void> {
          const { syncRequestId, skuBatchId } = payload;

          logger.info({ syncRequestId, skuBatchId }, 'Handling force sync');

          try {
               // Fetch inventory from WMS
               const filter = skuBatchId ? { skuBatchId } : undefined;
               const snapshots = await this.wmsClient.getInventory(filter);

               logger.info(
                    { syncRequestId, snapshotCount: snapshots.length },
                    'Fetched WMS snapshots'
               );

               // Process in transaction
               await withTransaction(async (client) => {
                    await this.syncService.processSyncRequest(client, syncRequestId, snapshots);
               });

               logger.info({ syncRequestId }, 'WMS sync completed successfully');
          } catch (error) {
               logger.error({ error, syncRequestId }, 'WMS sync failed');

               // Mark sync request as failed
               await withTransaction(async (client) => {
                    await client.query(
                         `
          UPDATE wms_sync_request
          SET status = 'FAILED',
              updated_at = NOW(),
              error = $2
          WHERE id = $1
        `,
                         [syncRequestId, error instanceof Error ? error.message : 'Unknown error']
                    );
               });

               throw error;
          }
     }
}

async function main() {
     const worker = new WmsSyncWorker();

     process.on('SIGINT', () => {
          logger.info('Shutting down gracefully...');
          process.exit(0);
     });

     process.on('SIGTERM', () => {
          logger.info('Shutting down gracefully...');
          process.exit(0);
     });

     await worker.start();
}

main().catch((err) => {
     logger.error({ err }, 'Fatal error in WMS sync worker');
     process.exit(1);
});
