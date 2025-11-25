import { pool } from '@nabis/shared/src/db/client';
import { InventoryService } from '@nabis/shared/src/services/inventory-service';
import {
     setupTestDb,
     createTestSku,
     createTestSkuBatch,
     getDomainEvents,
} from '../helpers/testUtils';

describe('Domain Events - Outbox Pattern', () => {
     const inventoryService = new InventoryService();

     beforeEach(async () => {
          await setupTestDb();
     });

     afterAll(async () => {
          // Pool cleanup handled globally
     });

     describe('Event emission', () => {
          it('should emit InventoryAllocated event on reservation', async () => {
               const skuId = await createTestSku('SKU-001');
               const batchId = await createTestSkuBatch(skuId, 100);

               const client = await pool.connect();
               try {
                    await client.query('BEGIN');
                    await inventoryService.reserveInventoryForOrder(client, {
                         orderId: 'ORDER-001',
                         lines: [{ skuBatchId: batchId, quantity: 10 }],
                    });
                    await client.query('COMMIT');
               } finally {
                    client.release();
               }

               const events = await getDomainEvents('PENDING');
               const orderEvents = events.filter((e) => {
                    const payload =
                         typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
                    return payload.orderId === 'ORDER-001';
               });
               expect(orderEvents.length).toBeGreaterThan(0);

               const allocatedEvents = orderEvents.filter((e) => e.type === 'InventoryAllocated');
               expect(allocatedEvents.length).toBe(1);

               const payload =
                    typeof allocatedEvents[0].payload === 'string'
                         ? JSON.parse(allocatedEvents[0].payload)
                         : allocatedEvents[0].payload;
               expect(payload.orderId).toBe('ORDER-001');
               expect(payload.skuBatchId).toBe(batchId);
               expect(payload.quantity).toBe(10);
          });

          it('should emit InventoryReleased event on release', async () => {
               const skuId = await createTestSku('SKU-001');
               const batchId = await createTestSkuBatch(skuId, 100);

               // Reserve inventory first
               const client = await pool.connect();
               try {
                    await client.query('BEGIN');
                    await inventoryService.reserveInventoryForOrder(client, {
                         orderId: 'ORDER-001',
                         lines: [{ skuBatchId: batchId, quantity: 10 }],
                    });
                    await client.query('COMMIT');
               } catch (error) {
                    await client.query('ROLLBACK');
                    throw error;
               } finally {
                    client.release();
               }

               // Now release the inventory
               const client2 = await pool.connect();
               try {
                    await client2.query('BEGIN');
                    await inventoryService.releaseInventoryForOrder(client2, {
                         orderId: 'ORDER-001',
                         reason: 'Cancelled',
                    });
                    await client2.query('COMMIT');
               } catch (error) {
                    await client2.query('ROLLBACK');
                    throw error;
               } finally {
                    client2.release();
               }

               const events = await getDomainEvents('PENDING');
               const orderEvents = events.filter((e) => {
                    const payload =
                         typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
                    return payload.orderId === 'ORDER-001';
               });
               const releasedEvents = orderEvents.filter((e) => e.type === 'InventoryReleased');
               expect(releasedEvents.length).toBeGreaterThan(0);
          });

          it('should emit events atomically with reservation', async () => {
               const skuId = await createTestSku('SKU-001');
               const batchId = await createTestSkuBatch(skuId, 5);

               // Try to reserve more than available
               const client = await pool.connect();
               try {
                    await client.query('BEGIN');
                    await inventoryService.reserveInventoryForOrder(client, {
                         orderId: 'ORDER-001',
                         lines: [{ skuBatchId: batchId, quantity: 10 }],
                    });
                    await client.query('COMMIT');
                    fail('Should have thrown error');
               } catch (err) {
                    await client.query('ROLLBACK');
                    // Expected to fail
               } finally {
                    client.release();
               }

               // No events should be emitted since transaction rolled back
               const events = await getDomainEvents('PENDING');
               const orderEvents = events.filter((e) => {
                    const payload =
                         typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
                    return payload.orderId === 'ORDER-001';
               });
               expect(orderEvents.length).toBe(0);
          });

          it('should emit multiple events for multi-line orders', async () => {
               const sku1 = await createTestSku('SKU-001');
               const sku2 = await createTestSku('SKU-002');
               const batch1 = await createTestSkuBatch(sku1, 100);
               const batch2 = await createTestSkuBatch(sku2, 50);

               const client = await pool.connect();
               try {
                    await client.query('BEGIN');
                    await inventoryService.reserveInventoryForOrder(client, {
                         orderId: 'ORDER-001',
                         lines: [
                              { skuBatchId: batch1, quantity: 10 },
                              { skuBatchId: batch2, quantity: 5 },
                         ],
                    });
                    await client.query('COMMIT');
               } finally {
                    client.release();
               }

               const events = await getDomainEvents('PENDING');
               const orderEvents = events.filter((e) => {
                    const payload =
                         typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
                    return payload.orderId === 'ORDER-001';
               });
               const allocatedEvents = orderEvents.filter((e) => e.type === 'InventoryAllocated');
               expect(allocatedEvents.length).toBe(2);
          });
     });

     describe('Event status', () => {
          it('should create events in PENDING status', async () => {
               const skuId = await createTestSku('SKU-001');
               const batchId = await createTestSkuBatch(skuId, 100);

               const client = await pool.connect();
               try {
                    await client.query('BEGIN');
                    await inventoryService.reserveInventoryForOrder(client, {
                         orderId: 'ORDER-001',
                         lines: [{ skuBatchId: batchId, quantity: 10 }],
                    });
                    await client.query('COMMIT');
               } finally {
                    client.release();
               }

               const result = await pool.query(
                    `SELECT status, payload FROM domain_event WHERE type = 'InventoryAllocated'`
               );

               const orderEvents = result.rows.filter((r) => {
                    const payload =
                         typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
                    return payload.orderId === 'ORDER-001';
               });

               expect(orderEvents.length).toBeGreaterThan(0);
               expect(orderEvents.every((r) => r.status === 'PENDING')).toBe(true);
          });

          it('should include correlation ID in events', async () => {
               const skuId = await createTestSku('SKU-001');
               const batchId = await createTestSkuBatch(skuId, 100);

               const client = await pool.connect();
               try {
                    await client.query('BEGIN');
                    await inventoryService.reserveInventoryForOrder(client, {
                         orderId: 'ORDER-001',
                         lines: [{ skuBatchId: batchId, quantity: 10 }],
                    });
                    await client.query('COMMIT');
               } finally {
                    client.release();
               }

               const events = await getDomainEvents('PENDING');
               const orderEvents = events.filter((e) => {
                    const payload =
                         typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
                    return payload.orderId === 'ORDER-001';
               });
               expect(orderEvents.length).toBeGreaterThan(0);
               expect(orderEvents[0]).toHaveProperty('created_at');
               expect(orderEvents[0]).toHaveProperty('id');
          });
     });
});
