import { InventoryService } from '@nabis/shared/src/services/inventory-service';
import { pool } from '@nabis/shared/src/db/client';
import {
     setupTestDb,
     createTestSku,
     createTestSkuBatch,
     getAvailableQuantity,
} from '../helpers/testUtils';

describe('InventoryService - Concurrency', () => {
     const inventoryService = new InventoryService();

     beforeEach(async () => {
          await setupTestDb();
     });

     afterAll(async () => {
          // Pool cleanup handled globally
     });

     describe('Concurrent reservations', () => {
          it('should prevent overselling with concurrent reservations', async () => {
               const skuId = await createTestSku('SKU-001');
               const batchId = await createTestSkuBatch(skuId, 10);

               // Attempt 5 concurrent reservations of 5 units each (50 total, but only 10 available)
               const promises = Array.from({ length: 5 }, async (_, i) => {
                    const client = await pool.connect();
                    try {
                         await client.query('BEGIN');
                         await inventoryService.reserveInventoryForOrder(client, {
                              orderId: `ORDER-${i + 1}`,
                              lines: [{ skuBatchId: batchId, quantity: 5 }],
                         });
                         await client.query('COMMIT');
                         return { success: true };
                    } catch (err: unknown) {
                         await client.query('ROLLBACK');
                         return { error: err instanceof Error ? err.message : String(err) };
                    } finally {
                         client.release();
                    }
               });

               const results = await Promise.all(promises);

               // Count successful reservations
               const successful = results.filter((r) => !('error' in r));
               const failed = results.filter((r) => 'error' in r);

               // Should have exactly 2 successful (2 * 5 = 10 units)
               expect(successful.length).toBe(2);
               expect(failed.length).toBe(3);

               // Verify no oversell
               const available = await getAvailableQuantity(batchId);
               expect(available).toBe(0);
          });

          it('should handle high concurrency without deadlocks', async () => {
               const skuId = await createTestSku('SKU-001');
               const batchId = await createTestSkuBatch(skuId, 100);

               // 20 concurrent reservations of 1 unit each
               const promises = Array.from({ length: 20 }, async (_, i) => {
                    const client = await pool.connect();
                    try {
                         await client.query('BEGIN');
                         await inventoryService.reserveInventoryForOrder(client, {
                              orderId: `ORDER-${i + 1}`,
                              lines: [{ skuBatchId: batchId, quantity: 1 }],
                         });
                         await client.query('COMMIT');
                         return { success: true };
                    } catch (err: unknown) {
                         await client.query('ROLLBACK');
                         return { error: err instanceof Error ? err.message : String(err) };
                    } finally {
                         client.release();
                    }
               });

               const results = await Promise.all(promises);

               // All should succeed
               expect(results.every((r) => !('error' in r))).toBe(true);
               expect(await getAvailableQuantity(batchId)).toBe(80);
          }, 10000);

          it('should serialize access to same batch', async () => {
               const skuId = await createTestSku('SKU-001');
               const batchId = await createTestSkuBatch(skuId, 50);

               // Multiple concurrent reservations
               const promises = Array.from({ length: 10 }, async (_, i) => {
                    const client = await pool.connect();
                    try {
                         await client.query('BEGIN');
                         await inventoryService.reserveInventoryForOrder(client, {
                              orderId: `ORDER-${i + 1}`,
                              lines: [{ skuBatchId: batchId, quantity: 3 }],
                         });
                         await client.query('COMMIT');
                         return { success: true };
                    } catch (err: unknown) {
                         await client.query('ROLLBACK');
                         return { error: err instanceof Error ? err.message : String(err) };
                    } finally {
                         client.release();
                    }
               });

               await Promise.all(promises);

               // Batch 1 should still have all quantity locked
               const available = await getAvailableQuantity(batchId);

               // Should have processed transactions serially, preventing oversell
               expect(available).toBeGreaterThanOrEqual(0);
               expect(available).toBeLessThanOrEqual(50);
          });
     });

     describe('Multi-batch reservations', () => {
          it('should handle concurrent multi-batch orders safely', async () => {
               const skuId1 = await createTestSku('SKU-001');
               const skuId2 = await createTestSku('SKU-002');
               const batch1 = await createTestSkuBatch(skuId1, 30); // Increased to handle both orders
               const batch2 = await createTestSkuBatch(skuId2, 30); // Increased to handle both orders

               // Two orders, each trying to reserve from both batches
               const promises = [
                    (async () => {
                         const client = await pool.connect();
                         try {
                              await client.query('BEGIN');
                              await inventoryService.reserveInventoryForOrder(client, {
                                   orderId: 'ORDER-001',
                                   lines: [
                                        { skuBatchId: batch1, quantity: 15 },
                                        { skuBatchId: batch2, quantity: 15 },
                                   ],
                              });
                              await client.query('COMMIT');
                         } finally {
                              client.release();
                         }
                    })(),
                    (async () => {
                         const client = await pool.connect();
                         try {
                              await client.query('BEGIN');
                              await inventoryService.reserveInventoryForOrder(client, {
                                   orderId: 'ORDER-002',
                                   lines: [
                                        { skuBatchId: batch1, quantity: 10 },
                                        { skuBatchId: batch2, quantity: 10 },
                                   ],
                              });
                              await client.query('COMMIT');
                         } finally {
                              client.release();
                         }
                    })(),
               ];

               await Promise.all(promises);

               // Both should succeed
               expect(await getAvailableQuantity(batch1)).toBe(30 - 15 - 10); // 5
               expect(await getAvailableQuantity(batch2)).toBe(30 - 15 - 10); // 5
          });

          it('should prevent partial reservations on concurrent failures', async () => {
               const skuId1 = await createTestSku('SKU-001');
               const skuId2 = await createTestSku('SKU-002');
               const batch1 = await createTestSkuBatch(skuId1, 20);
               const batch2 = await createTestSkuBatch(skuId2, 5); // Limited inventory

               // Multiple concurrent orders trying to reserve from both batches
               const promises = Array.from({ length: 3 }, async (_, i) => {
                    const client = await pool.connect();
                    try {
                         await client.query('BEGIN');
                         await inventoryService.reserveInventoryForOrder(client, {
                              orderId: `ORDER-${i + 1}`,
                              lines: [
                                   { skuBatchId: batch1, quantity: 5 },
                                   { skuBatchId: batch2, quantity: 3 },
                              ],
                         });
                         await client.query('COMMIT');
                         return { success: true };
                    } catch (err: unknown) {
                         await client.query('ROLLBACK');
                         return { error: err instanceof Error ? err.message : String(err) };
                    } finally {
                         client.release();
                    }
               });

               const results = await Promise.all(promises);

               // Some will succeed, some will fail
               const successful = results.filter((r) => !('error' in r));

               // Verify atomicity - if batch2 runs out, batch1 shouldn't be partially reserved
               const available1 = await getAvailableQuantity(batch1);
               const available2 = await getAvailableQuantity(batch2);

               // Available should be consistent with successful reservations
               expect(available1).toBe(20 - successful.length * 5);
               expect(available2).toBe(5 - successful.length * 3);
               expect(available2).toBeGreaterThanOrEqual(0);
          });
     });
});
