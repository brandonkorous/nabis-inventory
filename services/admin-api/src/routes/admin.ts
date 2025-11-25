import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '@nabis/shared/src/db/client';
import { getChannel, WMS_COMMANDS_EXCHANGE } from '@nabis/shared/src/messaging/client';
import { DomainError } from '@nabis/shared/src/utils/errors';
import { forceSyncSchema, getSyncStatusSchema } from '../schemas/admin.schemas';

export async function registerAdminRoutes(app: FastifyInstance) {
     // Force WMS sync
     app.post<{
          Body: {
               skuBatchId?: number;
               reason?: string;
          };
     }>(
          '/wms/sync',
          { schema: forceSyncSchema },
          async (request: FastifyRequest, reply: FastifyReply) => {
               const body = request.body as {
                    skuBatchId?: number;
                    reason?: string;
               };

               try {
                    // Insert sync request
                    const { rows } = await pool.query<{ id: number }>(
                         `
          INSERT INTO wms_sync_request (
            requested_by,
            reason,
            sku_batch_id,
            priority,
            status
          ) VALUES ($1, $2, $3, 1, 'PENDING')
          RETURNING id
        `,
                         [
                              'admin-api',
                              body.reason || 'Manual sync requested',
                              body.skuBatchId || null,
                         ]
                    );

                    const syncRequestId = rows[0].id;

                    // Publish command to RabbitMQ
                    const channel = await getChannel();
                    await channel.publish(
                         WMS_COMMANDS_EXCHANGE,
                         'wms.forceSync',
                         Buffer.from(
                              JSON.stringify({
                                   type: 'ForceWmsSync',
                                   syncRequestId,
                                   skuBatchId: body.skuBatchId || null,
                              })
                         ),
                         { persistent: true }
                    );

                    request.log.info(
                         { syncRequestId, skuBatchId: body.skuBatchId },
                         'WMS sync queued'
                    );

                    reply.code(202).send({
                         requestId: syncRequestId,
                         status: 'queued',
                         message: 'WMS sync request queued successfully',
                    });
               } catch (error) {
                    request.log.error({ error }, 'Failed to queue WMS sync');
                    reply.code(500).send({
                         error: 'INTERNAL_ERROR',
                         message: 'Failed to queue sync request',
                    });
               }
          }
     );

     // Get sync request status
     app.get<{
          Params: {
               requestId: string;
          };
     }>(
          '/wms/sync/:requestId',
          { schema: getSyncStatusSchema },
          async (request: FastifyRequest, reply: FastifyReply) => {
               const params = request.params as { requestId: string };

               try {
                    const { rows } = await pool.query(
                         `
          SELECT 
            id,
            requested_by,
            reason,
            sku_batch_id,
            priority,
            status,
            created_at,
            updated_at,
            completed_at,
            error
          FROM wms_sync_request
          WHERE id = $1
        `,
                         [parseInt(params.requestId, 10)]
                    );

                    if (rows.length === 0) {
                         reply.code(404).send({
                              error: 'NOT_FOUND',
                              message: `Sync request ${params.requestId} not found`,
                         });
                         return;
                    }

                    const request_data = rows[0];
                    reply.send({
                         requestId: request_data.id,
                         status: request_data.status,
                         requestedBy: request_data.requested_by,
                         reason: request_data.reason,
                         skuBatchId: request_data.sku_batch_id,
                         createdAt: request_data.created_at,
                         updatedAt: request_data.updated_at,
                         completedAt: request_data.completed_at,
                         error: request_data.error,
                    });
               } catch (error) {
                    request.log.error({ error }, 'Failed to get sync status');
                    reply.code(500).send({
                         error: 'INTERNAL_ERROR',
                         message: 'Failed to retrieve sync status',
                    });
               }
          }
     );

     // Manual inventory adjustment
     app.post<{
          Body: {
               skuBatchId: number;
               quantityDelta: number;
               reason: string;
          };
     }>(
          '/inventory/adjust',
          {
               schema: {
                    tags: ['inventory-admin'],
                    summary: 'Manually adjust inventory',
                    description: 'Create a manual adjustment to inventory (use with caution)',
                    body: {
                         type: 'object',
                         required: ['skuBatchId', 'quantityDelta', 'reason'],
                         properties: {
                              skuBatchId: {
                                   type: 'integer',
                                   description: 'Batch to adjust',
                                   example: 123,
                              },
                              quantityDelta: {
                                   type: 'integer',
                                   description: 'Change in quantity (positive or negative)',
                                   example: -10,
                              },
                              reason: {
                                   type: 'string',
                                   description: 'Reason for adjustment',
                                   example: 'Damaged inventory correction',
                              },
                         },
                    },
                    response: {
                         200: {
                              type: 'object',
                              properties: {
                                   status: { type: 'string', example: 'ok' },
                                   message: { type: 'string' },
                                   newAvailableQuantity: { type: 'integer' },
                              },
                         },
                    },
               },
          },
          async (request: FastifyRequest, reply: FastifyReply) => {
               const body = request.body as {
                    skuBatchId: number;
                    quantityDelta: number;
                    reason: string;
               };

               try {
                    const client = await pool.connect();
                    try {
                         await client.query('BEGIN');

                         // Lock and update batch
                         const { rows } = await client.query(
                              `
            UPDATE sku_batch
            SET available_quantity = available_quantity + $1,
                updated_at = NOW()
            WHERE id = $2
            RETURNING available_quantity
          `,
                              [body.quantityDelta, body.skuBatchId]
                         );

                         if (rows.length === 0) {
                              throw new DomainError('Batch not found', 'BATCH_NOT_FOUND', 404);
                         }

                         const newAvailable = rows[0].available_quantity;

                         // Insert ledger entry
                         await client.query(
                              `
            INSERT INTO inventory_ledger (
              sku_batch_id,
              type,
              quantity_delta,
              source,
              reference_id,
              metadata
            ) VALUES ($1, 'ADJUSTMENT', $2, 'MANUAL_ADJUSTMENT', $3, $4::jsonb)
          `,
                              [
                                   body.skuBatchId,
                                   body.quantityDelta,
                                   'ADMIN_API',
                                   JSON.stringify({ reason: body.reason }),
                              ]
                         );

                         await client.query('COMMIT');

                         request.log.info(
                              { skuBatchId: body.skuBatchId, quantityDelta: body.quantityDelta },
                              'Manual adjustment applied'
                         );

                         reply.send({
                              status: 'ok',
                              message: 'Adjustment applied successfully',
                              newAvailableQuantity: newAvailable,
                         });
                    } catch (err) {
                         await client.query('ROLLBACK');
                         throw err;
                    } finally {
                         client.release();
                    }
               } catch (error) {
                    if (error instanceof DomainError) {
                         reply.code(error.statusCode).send({
                              error: error.code,
                              message: error.message,
                         });
                    } else {
                         request.log.error({ error }, 'Failed to apply adjustment');
                         reply.code(500).send({
                              error: 'INTERNAL_ERROR',
                              message: 'Failed to apply adjustment',
                         });
                    }
               }
          }
     );
}
