import dotenv from 'dotenv';
import { getChannel, WMS_OUTBOUND_QUEUE, ConsumeMessage } from '@nabis/shared/src/messaging/client';
import { pool } from '@nabis/shared/src/db/client';
import { createWmsClient } from '@nabis/shared/src/clients/wms-client';
import { WmsApiError } from '@nabis/shared/src/utils/errors';
import { logger } from '@nabis/shared/src/utils/logger';

dotenv.config();

const PREFETCH = parseInt(process.env.AMQP_PREFETCH || '10', 10);

class WmsOutboundWorker {
     private wmsClient = createWmsClient();

     async start() {
          logger.info({ prefetch: PREFETCH }, 'Starting WMS outbound worker');

          const channel = await getChannel();
          channel.prefetch(PREFETCH);

          channel.consume(WMS_OUTBOUND_QUEUE, async (msg) => {
               if (!msg) return;

               try {
                    await this.processMessage(msg);
                    channel.ack(msg);
               } catch (error) {
                    logger.error({ error }, 'Failed to process message');
                    await this.handleError(channel, msg, error);
               }
          });

          logger.info('WMS outbound worker started');
     }

     private async processMessage(msg: ConsumeMessage): Promise<void> {
          const payload = JSON.parse(msg.content.toString());
          logger.info({ payload }, 'Processing WMS outbound message');

          const eventType = payload.type || msg.fields.routingKey?.split('.').pop();

          if (eventType === 'InventoryAllocated') {
               await this.handleAllocated(payload);
          } else if (eventType === 'InventoryReleased') {
               await this.handleReleased(payload);
          } else {
               logger.warn({ eventType }, 'Unknown event type');
          }
     }

     private async handleAllocated(payload: any): Promise<void> {
          const { orderId, skuBatchId, quantity } = payload;

          // Get external batch ID
          const { rows } = await pool.query(
               `SELECT external_batch_id FROM sku_batch WHERE id = $1`,
               [skuBatchId]
          );

          if (rows.length === 0) {
               throw new Error(`Batch ${skuBatchId} not found`);
          }

          const externalBatchId = rows[0].external_batch_id;

          // Call WMS
          await this.wmsClient.allocate({
               skuBatchId,
               externalBatchId,
               quantity,
               orderRef: orderId,
          });

          // Optional: record WMS call in ledger for audit
          await pool.query(
               `
      INSERT INTO inventory_ledger (
        sku_batch_id,
        type,
        quantity_delta,
        source,
        reference_id,
        metadata
      ) VALUES ($1, 'ADJUSTMENT', 0, 'WMS_OUTBOUND', $2, $3::jsonb)
    `,
               [skuBatchId, orderId, JSON.stringify({ action: 'allocate', wmsCall: true })]
          );

          logger.info({ orderId, skuBatchId }, 'WMS allocation completed');
     }

     private async handleReleased(payload: any): Promise<void> {
          const { orderId, skuBatchId, quantity } = payload;

          const { rows } = await pool.query(
               `SELECT external_batch_id FROM sku_batch WHERE id = $1`,
               [skuBatchId]
          );

          if (rows.length === 0) {
               throw new Error(`Batch ${skuBatchId} not found`);
          }

          const externalBatchId = rows[0].external_batch_id;

          await this.wmsClient.release({
               skuBatchId,
               externalBatchId,
               quantity,
               orderRef: orderId,
          });

          await pool.query(
               `
      INSERT INTO inventory_ledger (
        sku_batch_id,
        type,
        quantity_delta,
        source,
        reference_id,
        metadata
      ) VALUES ($1, 'ADJUSTMENT', 0, 'WMS_OUTBOUND', $2, $3::jsonb)
    `,
               [skuBatchId, orderId, JSON.stringify({ action: 'release', wmsCall: true })]
          );

          logger.info({ orderId, skuBatchId }, 'WMS release completed');
     }

     private async handleError(channel: any, msg: ConsumeMessage, error: unknown): Promise<void> {
          if (error instanceof WmsApiError) {
               if (error.retriable) {
                    // Requeue with delay for retriable errors (429, 503, 504)
                    logger.warn(
                         { statusCode: error.statusCode },
                         'Retriable WMS error, requeueing'
                    );
                    channel.nack(msg, false, true);
               } else {
                    // Send to DLQ for non-retriable errors
                    logger.error(
                         { statusCode: error.statusCode },
                         'Non-retriable WMS error, sending to DLQ'
                    );
                    channel.nack(msg, false, false);
               }
          } else {
               // Unknown error - send to DLQ
               logger.error({ error }, 'Unknown error, sending to DLQ');
               channel.nack(msg, false, false);
          }
     }
}

async function main() {
     const worker = new WmsOutboundWorker();

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
     logger.error({ err }, 'Fatal error in WMS outbound worker');
     process.exit(1);
});
