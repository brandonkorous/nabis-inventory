import Fastify, { FastifyInstance } from 'fastify';
import { registerInventoryRoutes } from '../../services/inventory-api/src/routes/inventory';
import {
     setupTestDb,
     createTestSku,
     createTestSkuBatch,
     getAvailableQuantity,
} from '../helpers/testUtils';

describe('Inventory API - Integration Tests', () => {
     let app: FastifyInstance;

     beforeAll(async () => {
          app = Fastify({
               logger: false,
               ajv: {
                    customOptions: {
                         removeAdditional: 'all',
                         coerceTypes: true,
                         useDefaults: true,
                         strict: false,
                    },
               },
          });
          await app.register(registerInventoryRoutes, { prefix: '/inventory' });
          await app.ready();
     });

     afterAll(async () => {
          await app.close();
     });

     beforeEach(async () => {
          await setupTestDb();
     });

     describe('POST /inventory/reserve', () => {
          it('should reserve inventory successfully', async () => {
               const skuId = await createTestSku('SKU-001');
               const batchId = await createTestSkuBatch(skuId, 100);

               const response = await app.inject({
                    method: 'POST',
                    url: '/inventory/reserve',
                    payload: {
                         orderId: 'ORDER-001',
                         lines: [{ skuBatchId: batchId, quantity: 10 }],
                    },
               });

               expect(response.statusCode).toBe(201);
               const body = JSON.parse(response.body);
               expect(body.status).toBe('ok');
               expect(body.orderId).toBe('ORDER-001');
               const available = await getAvailableQuantity(batchId);
               expect(available).toBe(90);
          });

          it('should return 409 when insufficient inventory', async () => {
               const skuId = await createTestSku('SKU-001');
               const batchId = await createTestSkuBatch(skuId, 5);

               const response = await app.inject({
                    method: 'POST',
                    url: '/inventory/reserve',
                    payload: {
                         orderId: 'ORDER-001',
                         lines: [{ skuBatchId: batchId, quantity: 10 }],
                    },
               });

               expect(response.statusCode).toBe(409);
               const body = JSON.parse(response.body);
               expect(body.message).toContain('Insufficient inventory');
          });

          it('should return 400 for invalid request', async () => {
               const response = await app.inject({
                    method: 'POST',
                    url: '/inventory/reserve',
                    payload: {
                         orderId: 'ORDER-001',
                         lines: [],
                    },
               });

               expect(response.statusCode).toBe(400);
          });

          it('should handle multi-line reservations', async () => {
               const sku1 = await createTestSku('SKU-001');
               const sku2 = await createTestSku('SKU-002');
               const batch1 = await createTestSkuBatch(sku1, 100);
               const batch2 = await createTestSkuBatch(sku2, 50);

               const response = await app.inject({
                    method: 'POST',
                    url: '/inventory/reserve',
                    payload: {
                         orderId: 'ORDER-001',
                         lines: [
                              { skuBatchId: batch1, quantity: 10 },
                              { skuBatchId: batch2, quantity: 5 },
                         ],
                    },
               });

               expect(response.statusCode).toBe(201);
               expect(await getAvailableQuantity(batch1)).toBe(90);
               expect(await getAvailableQuantity(batch2)).toBe(45);
          });
     });

     describe('POST /inventory/release', () => {
          it('should release reserved inventory', async () => {
               const skuId = await createTestSku('SKU-001');
               const batchId = await createTestSkuBatch(skuId, 100);

               // Reserve first
               await app.inject({
                    method: 'POST',
                    url: '/inventory/reserve',
                    payload: {
                         orderId: 'ORDER-001',
                         lines: [{ skuBatchId: batchId, quantity: 10 }],
                    },
               });

               // Then release
               const response = await app.inject({
                    method: 'POST',
                    url: '/inventory/release',
                    payload: {
                         orderId: 'ORDER-001',
                         reason: 'Customer cancellation',
                    },
               });

               expect(response.statusCode).toBe(200);
               const body = JSON.parse(response.body);
               expect(body.status).toBe('ok');

               const available = await getAvailableQuantity(batchId);
               expect(available).toBe(100);
          });

          it('should return 404 for non-existent order', async () => {
               const response = await app.inject({
                    method: 'POST',
                    url: '/inventory/release',
                    payload: {
                         orderId: 'ORDER-999',
                         reason: 'Test',
                    },
               });

               expect(response.statusCode).toBe(404);
          });
     });

     describe('GET /inventory/:sku', () => {
          it('should return available inventory for SKU', async () => {
               const skuId = await createTestSku('SKU-FLOWER-001');
               await createTestSkuBatch(skuId, 100, 'WH-001', 'BATCH-001');
               await createTestSkuBatch(skuId, 50, 'WH-002', 'BATCH-002');

               const response = await app.inject({
                    method: 'GET',
                    url: '/inventory/SKU-FLOWER-001',
               });

               expect(response.statusCode).toBe(200);
               const body = JSON.parse(response.body);
               expect(body.skuCode).toBe('SKU-FLOWER-001');
               expect(body.batches).toHaveLength(2);
               expect(body.totalAvailable).toBe(150);
          });

          it('should return empty result for non-existent SKU', async () => {
               const response = await app.inject({
                    method: 'GET',
                    url: '/inventory/SKU-NONEXISTENT',
               });

               expect(response.statusCode).toBe(200);
               const body = JSON.parse(response.body);
               expect(body.totalAvailable).toBe(0);
               expect(body.batches).toHaveLength(0);
          });

          it('should reflect reservations in available quantity', async () => {
               const skuId = await createTestSku('SKU-001');
               const batchId = await createTestSkuBatch(skuId, 100);

               // Reserve some
               await app.inject({
                    method: 'POST',
                    url: '/inventory/reserve',
                    payload: {
                         orderId: 'ORDER-001',
                         lines: [{ skuBatchId: batchId, quantity: 30 }],
                    },
               });

               const response = await app.inject({
                    method: 'GET',
                    url: '/inventory/SKU-001',
               });

               const body = JSON.parse(response.body);
               expect(body.totalAvailable).toBe(70);
          });
     });

     describe('Error handling', () => {
          it('should handle database errors gracefully', async () => {
               const response = await app.inject({
                    method: 'POST',
                    url: '/inventory/reserve',
                    payload: {
                         orderId: 'ORDER-001',
                         lines: [{ skuBatchId: 999999, quantity: 10 }],
                    },
               });

               expect(response.statusCode).toBeGreaterThanOrEqual(400);
          });

          it('should validate request schema', async () => {
               const response = await app.inject({
                    method: 'POST',
                    url: '/inventory/reserve',
                    payload: {
                         // Missing orderId
                         lines: [{ skuBatchId: 1, quantity: 10 }],
                    },
               });

               expect(response.statusCode).toBe(400);
          });

          it('should handle unexpected errors in reserve endpoint', async () => {
               const { InventoryService: InventoryServiceClass } = await import(
                    '@nabis/shared/src/services/inventory-service'
               );
               const originalReserve = InventoryServiceClass.prototype.reserveInventoryForOrder;

               // Mock to throw a non-DomainError
               InventoryServiceClass.prototype.reserveInventoryForOrder = jest
                    .fn()
                    .mockRejectedValue(new Error('Unexpected database error'));

               const response = await app.inject({
                    method: 'POST',
                    url: '/inventory/reserve',
                    payload: {
                         orderId: 'ORDER-001',
                         lines: [{ skuBatchId: 1, quantity: 10 }],
                    },
               });

               expect(response.statusCode).toBe(500);
               const body = JSON.parse(response.body);
               expect(body.error).toBe('INTERNAL_ERROR');
               expect(body.message).toBe('An unexpected error occurred');

               // Restore original method
               InventoryServiceClass.prototype.reserveInventoryForOrder = originalReserve;
          });

          it('should handle unexpected errors in release endpoint', async () => {
               const { InventoryService: InventoryServiceClass } = await import(
                    '@nabis/shared/src/services/inventory-service'
               );
               const originalRelease = InventoryServiceClass.prototype.releaseInventoryForOrder;

               // Mock to throw a non-DomainError
               InventoryServiceClass.prototype.releaseInventoryForOrder = jest
                    .fn()
                    .mockRejectedValue(new Error('Unexpected database error'));

               const response = await app.inject({
                    method: 'POST',
                    url: '/inventory/release',
                    payload: {
                         orderId: 'ORDER-001',
                         reason: 'Test',
                    },
               });

               expect(response.statusCode).toBe(500);
               const body = JSON.parse(response.body);
               expect(body.error).toBe('INTERNAL_ERROR');
               expect(body.message).toBe('An unexpected error occurred');

               // Restore original method
               InventoryServiceClass.prototype.releaseInventoryForOrder = originalRelease;
          });

          it('should handle unexpected errors in get inventory endpoint', async () => {
               const { InventoryService: InventoryServiceClass } = await import(
                    '@nabis/shared/src/services/inventory-service'
               );
               const originalGet = InventoryServiceClass.prototype.getAvailableInventory;

               // Mock to throw a non-DomainError
               InventoryServiceClass.prototype.getAvailableInventory = jest
                    .fn()
                    .mockRejectedValue(new Error('Database connection lost'));

               const response = await app.inject({
                    method: 'GET',
                    url: '/inventory/SKU-001',
               });

               expect(response.statusCode).toBe(500);
               const body = JSON.parse(response.body);
               expect(body.error).toBe('INTERNAL_ERROR');
               expect(body.message).toBe('An unexpected error occurred');

               // Restore original method
               InventoryServiceClass.prototype.getAvailableInventory = originalGet;
          });
     });
});
