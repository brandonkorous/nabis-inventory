import { PoolClient } from 'pg';
import { WmsSnapshot } from '../types/inventory.types';
import { logger } from '../utils/logger';

export class WmsSyncService {
     async processSyncRequest(
          client: PoolClient,
          syncRequestId: number,
          wmsSnapshots: WmsSnapshot[]
     ): Promise<void> {
          logger.info({ syncRequestId, snapshotCount: wmsSnapshots.length }, 'Processing WMS sync');

          // Mark sync request as in progress
          await client.query(
               `
      UPDATE wms_sync_request
      SET status = 'IN_PROGRESS', updated_at = NOW()
      WHERE id = $1
    `,
               [syncRequestId]
          );

          // Process each snapshot
          for (const snapshot of wmsSnapshots) {
               await this.reconcileBatch(client, snapshot);
          }

          // Mark sync request as done
          await client.query(
               `
      UPDATE wms_sync_request
      SET status = 'DONE', updated_at = NOW(), completed_at = NOW()
      WHERE id = $1
    `,
               [syncRequestId]
          );

          logger.info({ syncRequestId }, 'WMS sync completed');
     }

     async reconcileBatch(client: PoolClient, snapshot: WmsSnapshot): Promise<void> {
          // Insert or update WMS snapshot
          await client.query(
               `
      INSERT INTO wms_inventory_snapshot (
        wms_sku_batch_id,
        sku_batch_id,
        reported_orderable_quantity,
        reported_unallocatable,
        reported_at,
        raw_payload
      ) VALUES ($1, $2, $3, $4, NOW(), $5::jsonb)
    `,
               [
                    snapshot.wmsSkuBatchId,
                    snapshot.skuBatchId || null,
                    snapshot.orderableQuantity,
                    snapshot.unallocatableQuantity || null,
                    JSON.stringify(snapshot.metadata || {}),
               ]
          );

          if (!snapshot.skuBatchId) {
               logger.warn(
                    { wmsSkuBatchId: snapshot.wmsSkuBatchId },
                    'No matching sku_batch_id for WMS batch'
               );
               return;
          }

          // Lock and get current batch state
          const { rows } = await client.query<{
               available_quantity: number;
               total_quantity: number;
          }>(
               `
      SELECT available_quantity, total_quantity
      FROM sku_batch
      WHERE id = $1
      FOR UPDATE
    `,
               [snapshot.skuBatchId]
          );

          if (rows.length === 0) {
               logger.warn({ skuBatchId: snapshot.skuBatchId }, 'SKU batch not found');
               return;
          }

          const currentAvailable = rows[0].available_quantity;
          const delta = snapshot.orderableQuantity - currentAvailable;

          if (delta === 0) {
               logger.debug({ skuBatchId: snapshot.skuBatchId }, 'No adjustment needed');
               return;
          }

          // Apply adjustment
          await client.query(
               `
      UPDATE sku_batch
      SET available_quantity = $1,
          updated_at = NOW()
      WHERE id = $2
    `,
               [snapshot.orderableQuantity, snapshot.skuBatchId]
          );

          // Record ledger entry
          await client.query(
               `
      INSERT INTO inventory_ledger (
        sku_batch_id,
        type,
        quantity_delta,
        source,
        reference_id,
        metadata
      ) VALUES ($1, 'ADJUSTMENT', $2, 'WMS_SYNC', $3, $4::jsonb)
    `,
               [
                    snapshot.skuBatchId,
                    delta,
                    snapshot.wmsSkuBatchId,
                    JSON.stringify({
                         previousAvailable: currentAvailable,
                         newAvailable: snapshot.orderableQuantity,
                    }),
               ]
          );

          // Emit domain event
          await client.query(
               `
      INSERT INTO domain_event (type, payload)
      VALUES ('InventoryAdjusted', $1::jsonb)
    `,
               [
                    JSON.stringify({
                         skuBatchId: snapshot.skuBatchId,
                         quantityDelta: delta,
                         newAvailable: snapshot.orderableQuantity,
                         source: 'WMS_SYNC',
                         reason: 'WMS reconciliation',
                         timestamp: new Date().toISOString(),
                    }),
               ]
          );

          logger.info(
               {
                    skuBatchId: snapshot.skuBatchId,
                    delta,
                    previousAvailable: currentAvailable,
                    newAvailable: snapshot.orderableQuantity,
               },
               'Inventory adjusted from WMS sync'
          );
     }
}
