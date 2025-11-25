import Fastify, { FastifyInstance } from 'fastify';
import { registerAdminRoutes } from '../../services/admin-api/src/routes/admin';
import { pool } from '@nabis/shared/src/db/client';
import { setupTestDb, createTestSku, createTestSkuBatch } from '../helpers/testUtils';

// Mock the messaging client
jest.mock('@nabis/shared/src/messaging/client', () => ({
     getChannel: jest.fn().mockResolvedValue({
          publish: jest.fn().mockResolvedValue(true),
     }),
     closeConnection: jest.fn().mockResolvedValue(undefined),
     WMS_COMMANDS_EXCHANGE: 'wms.commands',
}));

describe('Admin API - Integration Tests', () => {
     let app: FastifyInstance;

     beforeAll(async () => {
          await setupTestDb();

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

          await app.register(registerAdminRoutes, { prefix: '/admin' });
          await app.ready();
     });

     afterAll(async () => {
          await app.close();
          await pool.end();
     });
     describe('POST /admin/wms/sync', () => {
          it('should queue a WMS sync request with specific skuBatchId', async () => {
               const skuId = await createTestSku('ADMIN-SKU-001');
               const batchId = await createTestSkuBatch(skuId, 100);

               const response = await app.inject({
                    method: 'POST',
                    url: '/admin/wms/sync',
                    payload: {
                         reason: 'Manual sync test',
                         skuBatchId: batchId,
                    },
               });

               expect(response.statusCode).toBe(202);
               const body = JSON.parse(response.body);
               expect(body).toHaveProperty('requestId');
               expect(body).toHaveProperty('status', 'queued');
               expect(body).toHaveProperty('message');
               expect(typeof body.requestId).toBe('number');
          });

          it('should queue a full inventory sync without skuBatchId', async () => {
               const response = await app.inject({
                    method: 'POST',
                    url: '/admin/wms/sync',
                    payload: {
                         reason: 'Full sync test',
                    },
               });

               expect(response.statusCode).toBe(202);
               const body = JSON.parse(response.body);
               expect(body).toHaveProperty('requestId');
               expect(body).toHaveProperty('status', 'queued');
               expect(body.message).toBe('WMS sync request queued successfully');
          });

          it('should allow empty payload', async () => {
               const response = await app.inject({
                    method: 'POST',
                    url: '/admin/wms/sync',
                    payload: {},
               });

               expect(response.statusCode).toBe(202);
               const body = JSON.parse(response.body);
               expect(body.requestId).toBeDefined();
          });

          it('should store sync request in database', async () => {
               const response = await app.inject({
                    method: 'POST',
                    url: '/admin/wms/sync',
                    payload: {
                         reason: 'Database verification test',
                    },
               });

               const body = JSON.parse(response.body);
               const { rows } = await pool.query('SELECT * FROM wms_sync_request WHERE id = $1', [
                    body.requestId,
               ]);

               expect(rows.length).toBe(1);
               expect(rows[0].reason).toBe('Database verification test');
               expect(rows[0].status).toBe('PENDING');
               expect(rows[0].requested_by).toBe('admin-api');
          });
     });

     describe('GET /admin/wms/sync/:requestId', () => {
          it('should return sync request status', async () => {
               // Create a sync request first
               const createResponse = await app.inject({
                    method: 'POST',
                    url: '/admin/wms/sync',
                    payload: {
                         reason: 'Test for status check',
                    },
               });

               const { requestId } = JSON.parse(createResponse.body);

               // Check the status
               const response = await app.inject({
                    method: 'GET',
                    url: `/admin/wms/sync/${requestId}`,
               });

               expect(response.statusCode).toBe(200);
               const body = JSON.parse(response.body);
               expect(body.requestId).toBe(requestId);
               expect(body.status).toBe('PENDING');
               expect(body.reason).toBe('Test for status check');
               expect(body.requestedBy).toBe('admin-api');
               expect(body.createdAt).toBeDefined();
          });

          it('should return 404 for non-existent request', async () => {
               const response = await app.inject({
                    method: 'GET',
                    url: '/admin/wms/sync/999999',
               });

               expect(response.statusCode).toBe(404);
               const body = JSON.parse(response.body);
               expect(body.error).toBe('NOT_FOUND');
               expect(body.message).toContain('999999');
          });
     });

     describe('POST /admin/inventory/adjust', () => {
          it('should adjust inventory for a SKU batch with positive delta', async () => {
               const skuCode = `ADMIN-SKU-ADJ-${Date.now()}-1`;
               const skuId = await createTestSku(skuCode);
               const batchId = await createTestSkuBatch(skuId, 100);

               const response = await app.inject({
                    method: 'POST',
                    url: '/admin/inventory/adjust',
                    payload: {
                         skuBatchId: batchId,
                         quantityDelta: -10,
                         reason: 'Inventory correction',
                    },
               });

               expect(response.statusCode).toBe(200);
               const body = JSON.parse(response.body);
               expect(body.status).toBe('ok');
               expect(body.newAvailableQuantity).toBe(90);
               expect(body.message).toContain('successfully');
          });

          it('should adjust inventory with negative delta', async () => {
               const skuCode = `ADMIN-SKU-ADJ-${Date.now()}-2`;
               const skuId = await createTestSku(skuCode);
               const batchId = await createTestSkuBatch(skuId, 100);

               const response = await app.inject({
                    method: 'POST',
                    url: '/admin/inventory/adjust',
                    payload: {
                         skuBatchId: batchId,
                         quantityDelta: -30,
                         reason: 'Damaged inventory removal',
                    },
               });

               expect(response.statusCode).toBe(200);
               const body = JSON.parse(response.body);
               expect(body.status).toBe('ok');
               expect(body.newAvailableQuantity).toBe(70);
          });

          it('should create ledger entry for adjustment', async () => {
               const skuCode = `ADMIN-SKU-ADJ-${Date.now()}-3`;
               const skuId = await createTestSku(skuCode);
               const batchId = await createTestSkuBatch(skuId, 100);

               await app.inject({
                    method: 'POST',
                    url: '/admin/inventory/adjust',
                    payload: {
                         skuBatchId: batchId,
                         quantityDelta: -15,
                         reason: 'Cycle count adjustment',
                    },
               });

               const { rows } = await pool.query(
                    `SELECT * FROM inventory_ledger 
         WHERE sku_batch_id = $1 AND type = 'ADJUSTMENT'
         ORDER BY created_at DESC LIMIT 1`,
                    [batchId]
               );

               expect(rows.length).toBe(1);
               expect(rows[0].quantity_delta).toBe(-15);
               expect(rows[0].source).toBe('MANUAL_ADJUSTMENT');
               expect(rows[0].reference_id).toBe('ADMIN_API');
               expect(rows[0].metadata.reason).toBe('Cycle count adjustment');
          });

          it('should return 400 for missing required fields', async () => {
               const response = await app.inject({
                    method: 'POST',
                    url: '/admin/inventory/adjust',
                    payload: {
                         skuBatchId: 123,
                         // Missing quantityDelta and reason
                    },
               });

               expect(response.statusCode).toBe(400);
          });

          it('should return 404 for non-existent SKU batch', async () => {
               const response = await app.inject({
                    method: 'POST',
                    url: '/admin/inventory/adjust',
                    payload: {
                         skuBatchId: 999999,
                         quantityDelta: 10,
                         reason: 'Test',
                    },
               });

               expect(response.statusCode).toBe(404);
               const body = JSON.parse(response.body);
               expect(body.error).toBe('BATCH_NOT_FOUND');
          });

          it('should handle concurrent adjustments correctly', async () => {
               const skuCode = `ADMIN-SKU-CONC-${Date.now()}`;
               const skuId = await createTestSku(skuCode);
               const batchId = await createTestSkuBatch(skuId, 100);

               // Make two concurrent adjustments
               const [response1, response2] = await Promise.all([
                    app.inject({
                         method: 'POST',
                         url: '/admin/inventory/adjust',
                         payload: {
                              skuBatchId: batchId,
                              quantityDelta: -10,
                              reason: 'Adjustment 1',
                         },
                    }),
                    app.inject({
                         method: 'POST',
                         url: '/admin/inventory/adjust',
                         payload: {
                              skuBatchId: batchId,
                              quantityDelta: -20,
                              reason: 'Adjustment 2',
                         },
                    }),
               ]);

               expect(response1.statusCode).toBe(200);
               expect(response2.statusCode).toBe(200);

               // Verify final quantity is correct (100 - 10 - 20 = 70)
               const { rows } = await pool.query(
                    'SELECT available_quantity FROM sku_batch WHERE id = $1',
                    [batchId]
               );
               expect(rows[0].available_quantity).toBe(70);
          });
     });

     describe('Error handling', () => {
          it('should handle unexpected errors in WMS sync endpoint', async () => {
               const messagingClientModule = await import('@nabis/shared/src/messaging/client');
               const originalGetChannel = messagingClientModule.getChannel;

               // Mock to throw a non-standard error
               (messagingClientModule as { getChannel: unknown }).getChannel = jest
                    .fn()
                    .mockRejectedValue(new Error('RabbitMQ connection lost'));

               const response = await app.inject({
                    method: 'POST',
                    url: '/admin/wms/sync',
                    payload: {
                         skuBatchId: 1,
                         requestedBy: 'admin',
                         reason: 'Test',
                    },
               });

               expect(response.statusCode).toBe(500);
               const body = JSON.parse(response.body);
               expect(body.error).toBe('INTERNAL_ERROR');
               expect(body.message).toBe('Failed to queue sync request');

               // Restore original method
               (messagingClientModule as { getChannel: unknown }).getChannel = originalGetChannel;
          });

          it('should handle unexpected errors in sync status endpoint', async () => {
               const { pool } = await import('@nabis/shared/src/db/client');
               const originalQuery = pool.query;

               // Mock to throw a database error
               pool.query = jest.fn().mockRejectedValue(new Error('Database connection failed'));

               const response = await app.inject({
                    method: 'GET',
                    url: '/admin/wms/sync/some-request-id',
               });

               expect(response.statusCode).toBe(500);
               const body = JSON.parse(response.body);
               expect(body.error).toBe('INTERNAL_ERROR');
               expect(body.message).toBe('Failed to retrieve sync status');

               // Restore original method
               pool.query = originalQuery;
          });

          it('should handle unexpected errors in inventory adjustment endpoint', async () => {
               const { pool } = await import('@nabis/shared/src/db/client');
               const originalConnect = pool.connect;

               // Mock to throw a non-DomainError
               pool.connect = jest.fn().mockRejectedValue(new Error('Connection pool exhausted'));

               const response = await app.inject({
                    method: 'POST',
                    url: '/admin/inventory/adjust',
                    payload: {
                         skuBatchId: 1,
                         quantityDelta: -10,
                         reason: 'Test',
                         adjustedBy: 'admin',
                    },
               });

               expect(response.statusCode).toBe(500);
               const body = JSON.parse(response.body);
               expect(body.error).toBe('INTERNAL_ERROR');
               expect(body.message).toBe('Failed to apply adjustment');

               // Restore original method
               pool.connect = originalConnect;
          });
     });
});
