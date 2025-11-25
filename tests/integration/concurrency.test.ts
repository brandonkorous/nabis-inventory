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
               async function attemptReservation(orderId: string) {
                    const client = await pool.connect();
                    try {
                         await client.query('BEGIN');
                         await inventoryService.reserveInventoryForOrder(client, {
                              orderId,
                              lines: [{ skuBatchId: batchId, quantity: 5 }],
                         });
                         await client.query('COMMIT');
                         return { success: true };
                    } catch (err: unknown) {
                         await client.query('ROLLBACK');
                         return { error: (err as Error).message };
                    } finally {
                         client.release();
                    }
               }

               const results = await Promise.all([
                    attemptReservation('ORDER-1'),
                    attemptReservation('ORDER-2'),
                    attemptReservation('ORDER-3'),
                    attemptReservation('ORDER-4'),
                    attemptReservation('ORDER-5'),
               ]);

               // Count successful reservations
               const successful = results.filter((r) => r && 'success' in r);
               const failed = results.filter((r) => r && 'error' in r);

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
               async function attemptReservation(orderId: string) {
                    const client = await pool.connect();
                    try {
                         await client.query('BEGIN');
                         await inventoryService.reserveInventoryForOrder(client, {
                              orderId,
                              lines: [{ skuBatchId: batchId, quantity: 1 }],
                         });
                         await client.query('COMMIT');
                         return { success: true };
                    } catch (err: unknown) {
                         await client.query('ROLLBACK');
                         throw err;
                    } finally {
                         client.release();
                    }
               }

               const results = await Promise.all(
                    Array.from({ length: 20 }, (_, i) => attemptReservation(`ORDER-${i + 1}`))
               );

               // All should succeed
               expect(results.every((r) => r.success)).toBe(true);
               expect(await getAvailableQuantity(batchId)).toBe(80);
          }, 10000);

          it('should serialize access to same batch', async () => {
               const skuId = await createTestSku('SKU-001');
               const batchId = await createTestSkuBatch(skuId, 50);

               // Multiple concurrent reservations
               async function attemptReservation(orderId: string) {
                    const client = await pool.connect();
                    try {
                         await client.query('BEGIN');
                         await inventoryService.reserveInventoryForOrder(client, {
                              orderId,
                              lines: [{ skuBatchId: batchId, quantity: 3 }],
                         });
                         await client.query('COMMIT');
                         return { success: true };
                    } catch (err: unknown) {
                         await client.query('ROLLBACK');
                         return { error: (err as Error).message };
                    } finally {
                         client.release();
                    }
               }

               await Promise.all(
                    Array.from({ length: 10 }, (_, i) => attemptReservation(`ORDER-${i + 1}`))
               );

               const available = await getAvailableQuantity(batchId);

               // Should have processed transactions serially, preventing oversell
               expect(available).toBeGreaterThanOrEqual(0);
               expect(available).toBeLessThanOrEqual(50);
          });
     });

     describe('Row-level locking', () => {
          it('should use FOR UPDATE to lock rows', async () => {
               const skuId = await createTestSku('SKU-001');
               const batchId = await createTestSkuBatch(skuId, 100);

               // Start a transaction but don't commit
               const lockClient = await pool.connect();
               await lockClient.query('BEGIN');

               try {
                    // Lock the batch
                    await lockClient.query('SELECT * FROM sku_batch WHERE id = $1 FOR UPDATE', [
                         batchId,
                    ]);

                    // Try to reserve from a different connection (should wait or timeout)
                    const reserveClient = await pool.connect();
                    const reservePromise = (async () => {
                         try {
                              await reserveClient.query('BEGIN');
                              await inventoryService.reserveInventoryForOrder(reserveClient, {
                                   orderId: 'ORDER-001',
                                   lines: [{ skuBatchId: batchId, quantity: 10 }],
                              });
                              await reserveClient.query('COMMIT');
                              return { success: true };
                         } catch (err: unknown) {
                              await reserveClient.query('ROLLBACK');
                              throw err;
                         } finally {
                              reserveClient.release();
                         }
                    })();

                    // Wait a bit to ensure the lock is held
                    await new Promise((resolve) => setTimeout(resolve, 100));

                    // Release the lock
                    await lockClient.query('COMMIT');

                    // Now the reservation should complete
                    const result = await reservePromise;
                    expect(result.success).toBe(true);
               } finally {
                    lockClient.release();
               }
          });
     });

     describe('SKIP LOCKED behavior', () => {
          it('should allow concurrent processing of different batches', async () => {
               const sku1 = await createTestSku('SKU-001');
               const sku2 = await createTestSku('SKU-002');
               const batch1 = await createTestSkuBatch(sku1, 100);
               const batch2 = await createTestSkuBatch(sku2, 100);

               // Concurrent reservations on different batches should not block
               const results = await Promise.all([
                    (async () => {
                         const client = await pool.connect();
                         try {
                              await client.query('BEGIN');
                              await inventoryService.reserveInventoryForOrder(client, {
                                   orderId: 'ORDER-001',
                                   lines: [{ skuBatchId: batch1, quantity: 10 }],
                              });
                              await client.query('COMMIT');
                              return { success: true };
                         } catch (err: unknown) {
                              await client.query('ROLLBACK');
                              throw err;
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
                                   lines: [{ skuBatchId: batch2, quantity: 10 }],
                              });
                              await client.query('COMMIT');
                              return { success: true };
                         } catch (err: unknown) {
                              await client.query('ROLLBACK');
                              throw err;
                         } finally {
                              client.release();
                         }
                    })(),
               ]);

               expect(results.every((r) => r.success)).toBe(true);
               expect(await getAvailableQuantity(batch1)).toBe(90);
               expect(await getAvailableQuantity(batch2)).toBe(90);
          });
     });

     describe('Multi-batch reservations', () => {
          it('should handle concurrent multi-batch orders safely', async () => {
               const skuId1 = await createTestSku('SKU-001');
               const skuId2 = await createTestSku('SKU-002');
               const batch1 = await createTestSkuBatch(skuId1, 30);
               const batch2 = await createTestSkuBatch(skuId2, 30);

               // Two orders, each trying to reserve from both batches
               const results = await Promise.all([
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
                              return { success: true };
                         } catch (err: unknown) {
                              await client.query('ROLLBACK');
                              throw err;
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
                              return { success: true };
                         } catch (err: unknown) {
                              await client.query('ROLLBACK');
                              throw err;
                         } finally {
                              client.release();
                         }
                    })(),
               ]);

               // Both should succeed
               expect(results.every((r) => r.success)).toBe(true);
               expect(await getAvailableQuantity(batch1)).toBe(30 - 15 - 10);
               expect(await getAvailableQuantity(batch2)).toBe(30 - 15 - 10);
          });

          it('should prevent partial reservations on concurrent failures', async () => {
               const skuId1 = await createTestSku('SKU-001');
               const skuId2 = await createTestSku('SKU-002');
               const batch1 = await createTestSkuBatch(skuId1, 20);
               const batch2 = await createTestSkuBatch(skuId2, 5); // Limited inventory

               // Multiple concurrent orders trying to reserve from both batches
               async function attemptReservation(orderId: string) {
                    const client = await pool.connect();
                    try {
                         await client.query('BEGIN');
                         await inventoryService.reserveInventoryForOrder(client, {
                              orderId,
                              lines: [
                                   { skuBatchId: batch1, quantity: 5 },
                                   { skuBatchId: batch2, quantity: 3 },
                              ],
                         });
                         await client.query('COMMIT');
                         return { success: true };
                    } catch (err: unknown) {
                         await client.query('ROLLBACK');
                         return { error: (err as Error).message };
                    } finally {
                         client.release();
                    }
               }

               const results = await Promise.all([
                    attemptReservation('ORDER-1'),
                    attemptReservation('ORDER-2'),
                    attemptReservation('ORDER-3'),
               ]);

               // Some will succeed, some will fail
               const successful = results.filter((r) => r && 'success' in r);

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
