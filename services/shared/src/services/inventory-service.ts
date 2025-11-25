import { PoolClient } from 'pg';
import {
     ReserveInventoryRequest,
     ReleaseInventoryRequest,
     InventoryBatch,
} from '../types/inventory.types';
import {
     InsufficientInventoryError,
     BatchNotFoundError,
     InvalidQuantityError,
     OrderNotFoundError,
} from '../utils/errors';
import { logger } from '../utils/logger';

export class InventoryService {
     /**
      * Reserve inventory for an order with oversell prevention
      */
     async reserveInventoryForOrder(
          client: PoolClient,
          request: ReserveInventoryRequest
     ): Promise<void> {
          const { orderId, lines } = request;

          logger.info({ orderId, lineCount: lines.length }, 'Reserving inventory for order');

          // Validate input
          if (!lines || lines.length === 0) {
               throw new InvalidQuantityError('Order must have at least one line');
          }

          for (const line of lines) {
               if (line.quantity <= 0) {
                    throw new InvalidQuantityError(
                         `Quantity must be positive for batch ${line.skuBatchId}`
                    );
               }
          }

          // Get unique batch IDs and lock rows
          const batchIds = [...new Set(lines.map((l) => l.skuBatchId))].sort();

          const { rows: batches } = await client.query<{
               id: number;
               available_quantity: number;
          }>(
               `
      SELECT id, available_quantity
      FROM sku_batch
      WHERE id = ANY($1::bigint[])
      FOR UPDATE
    `,
               [batchIds]
          );

          // Build lookup map - parse ID to number since PostgreSQL returns bigint as string
          const batchMap = new Map(
               batches.map((b) => [
                    parseInt(String(b.id), 10),
                    parseInt(String(b.available_quantity), 10),
               ])
          ); // Validate all batches exist and have sufficient inventory
          for (const line of lines) {
               const available = batchMap.get(line.skuBatchId);

               if (available === undefined) {
                    throw new BatchNotFoundError(line.skuBatchId);
               }

               if (available < line.quantity) {
                    throw new InsufficientInventoryError(
                         `Insufficient inventory for batch ${line.skuBatchId}: requested ${line.quantity}, available ${available}`,
                         line.skuBatchId,
                         line.quantity,
                         available
                    );
               }
          }

          // All validations passed - apply updates
          for (const line of lines) {
               const currentAvailable = batchMap.get(line.skuBatchId)!;
               const newAvailable = currentAvailable - line.quantity;

               // Update sku_batch
               await client.query(
                    `
        UPDATE sku_batch
        SET available_quantity = $1,
            updated_at = NOW()
        WHERE id = $2
      `,
                    [newAvailable, line.skuBatchId]
               );

               // Insert ledger entry
               await client.query(
                    `
        INSERT INTO inventory_ledger (
          sku_batch_id,
          type,
          quantity_delta,
          source,
          reference_id
        ) VALUES ($1, 'ORDER_ALLOCATE', $2, 'NABIS_ORDER', $3)
      `,
                    [line.skuBatchId, -line.quantity, orderId]
               );

               // Insert reservation
               await client.query(
                    `
        INSERT INTO order_reservation (
          order_id,
          sku_batch_id,
          quantity,
          status
        ) VALUES ($1, $2, $3, 'PENDING')
      `,
                    [orderId, line.skuBatchId, line.quantity]
               );

               // Insert domain event for async processing
               await client.query(
                    `
        INSERT INTO domain_event (type, payload)
        VALUES ($1, $2::jsonb)
      `,
                    [
                         'InventoryAllocated',
                         JSON.stringify({
                              orderId,
                              skuBatchId: line.skuBatchId,
                              quantity: line.quantity,
                              timestamp: new Date().toISOString(),
                         }),
                    ]
               );

               logger.debug(
                    { orderId, skuBatchId: line.skuBatchId, quantity: line.quantity, newAvailable },
                    'Batch allocated'
               );
          }

          logger.info({ orderId }, 'Inventory reserved successfully');
     }

     /**
      * Release inventory for an order (e.g., cancellation)
      */
     async releaseInventoryForOrder(
          client: PoolClient,
          request: ReleaseInventoryRequest
     ): Promise<void> {
          const { orderId, reason } = request;

          logger.info({ orderId, reason }, 'Releasing inventory for order');

          // Get all pending reservations for this order
          const { rows: reservations } = await client.query<{
               id: number;
               sku_batch_id: number;
               quantity: number;
          }>(
               `
      SELECT id, sku_batch_id, quantity
      FROM order_reservation
      WHERE order_id = $1 AND status = 'PENDING'
      FOR UPDATE
    `,
               [orderId]
          );

          if (reservations.length === 0) {
               throw new OrderNotFoundError(orderId);
          }

          // Get unique batch IDs and lock
          const batchIds = [...new Set(reservations.map((r) => r.sku_batch_id))];
          await client.query(`SELECT id FROM sku_batch WHERE id = ANY($1::bigint[]) FOR UPDATE`, [
               batchIds,
          ]);

          // Release each reservation
          for (const reservation of reservations) {
               // Return quantity to available
               await client.query(
                    `
        UPDATE sku_batch
        SET available_quantity = available_quantity + $1,
            updated_at = NOW()
        WHERE id = $2
      `,
                    [reservation.quantity, reservation.sku_batch_id]
               );

               // Insert ledger entry
               await client.query(
                    `
        INSERT INTO inventory_ledger (
          sku_batch_id,
          type,
          quantity_delta,
          source,
          reference_id
        ) VALUES ($1, 'ORDER_RELEASE', $2, 'NABIS_ORDER', $3)
      `,
                    [reservation.sku_batch_id, reservation.quantity, orderId]
               );

               // Cancel reservation
               await client.query(
                    `
        UPDATE order_reservation
        SET status = 'CANCELLED',
            updated_at = NOW()
        WHERE id = $1
      `,
                    [reservation.id]
               );

               // Domain event
               await client.query(
                    `
        INSERT INTO domain_event (type, payload)
        VALUES ($1, $2::jsonb)
      `,
                    [
                         'InventoryReleased',
                         JSON.stringify({
                              orderId,
                              skuBatchId: reservation.sku_batch_id,
                              quantity: reservation.quantity,
                              reason: reason || 'ORDER_CANCELLED',
                              timestamp: new Date().toISOString(),
                         }),
                    ]
               );
          }

          logger.info({ orderId, releasedCount: reservations.length }, 'Inventory released');
     }

     /**
      * Get available inventory for a SKU
      */
     async getAvailableInventory(client: PoolClient, skuCode: string): Promise<InventoryBatch[]> {
          const { rows } = await client.query<{
               id: number;
               sku_id: number;
               sku_code: string;
               external_batch_id: string | null;
               lot_number: string | null;
               total_quantity: number;
               unallocatable_quantity: number;
               available_quantity: number;
               expires_at: Date | null;
          }>(
               `
      SELECT 
        b.id,
        b.sku_id,
        s.sku_code,
        b.external_batch_id,
        b.lot_number,
        b.total_quantity,
        b.unallocatable_quantity,
        b.available_quantity,
        b.expires_at
      FROM sku_batch b
      JOIN sku s ON s.id = b.sku_id
      WHERE s.sku_code = $1
      ORDER BY b.expires_at NULLS LAST, b.id
    `,
               [skuCode]
          );

          return rows.map((row) => ({
               id: row.id,
               skuId: row.sku_id,
               skuCode: row.sku_code,
               externalBatchId: row.external_batch_id || undefined,
               lotNumber: row.lot_number || undefined,
               totalQuantity: row.total_quantity,
               unallocatableQuantity: row.unallocatable_quantity,
               availableQuantity: row.available_quantity,
               expiresAt: row.expires_at || undefined,
          }));
     }
}
