import Fastify, { FastifyInstance } from 'fastify';
import { registerInventoryRoutes } from '../../services/inventory-api/src/routes/inventory';
import { pool } from '@nabis/shared/src/db/client';
import { setupTestDb, createTestSku, createTestSkuBatch } from '../helpers/testUtils';

describe('Idempotency Integration Tests', () => {
     let app: FastifyInstance;
     let batchId1: number;
     let batchId2: number;

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
          await pool.end();
     });

     beforeEach(async () => {
          await setupTestDb();
          // Create test SKUs and batches
          const sku1Id = await createTestSku('SKU-001');
          const sku2Id = await createTestSku('SKU-002');
          batchId1 = await createTestSkuBatch(sku1Id, 1000, 'BATCH-001');
          batchId2 = await createTestSkuBatch(sku2Id, 500, 'BATCH-002');
     });

     describe('Reserve Idempotency', () => {
          it('should return success on duplicate reserve request with identical lines', async () => {
               const reserveRequest = {
                    orderId: 'ORDER-IDEMPOTENT-001',
                    lines: [{ skuBatchId: batchId1, quantity: 10 }],
               };

               // First request
               const response1 = await app.inject({
                    method: 'POST',
                    url: '/inventory/reserve',
                    payload: reserveRequest,
               });

               expect(response1.statusCode).toBe(201);
               expect(response1.json()).toMatchObject({
                    status: 'ok',
                    orderId: 'ORDER-IDEMPOTENT-001',
               });

               // Second request - should be idempotent
               const response2 = await app.inject({
                    method: 'POST',
                    url: '/inventory/reserve',
                    payload: reserveRequest,
               });

               expect(response2.statusCode).toBe(201);
               expect(response2.json()).toMatchObject({
                    status: 'ok',
                    orderId: 'ORDER-IDEMPOTENT-001',
               });

               // Verify inventory was only reserved once
               const inventoryResponse = await app.inject({
                    method: 'GET',
                    url: '/inventory/SKU-001',
               });

               expect(inventoryResponse.statusCode).toBe(200);
               const inventoryData = inventoryResponse.json();
               expect(inventoryData.totalAvailable).toBe(990); // 1000 - 10 (not 1000 - 20)
          });

          it('should return success on duplicate reserve with multiple lines', async () => {
               const reserveRequest = {
                    orderId: 'ORDER-MULTI-IDEMPOTENT',
                    lines: [
                         { skuBatchId: batchId1, quantity: 10 },
                         { skuBatchId: batchId2, quantity: 20 },
                    ],
               };

               // First request
               const response1 = await app.inject({
                    method: 'POST',
                    url: '/inventory/reserve',
                    payload: reserveRequest,
               });

               expect(response1.statusCode).toBe(201);

               // Second request - should be idempotent
               const response2 = await app.inject({
                    method: 'POST',
                    url: '/inventory/reserve',
                    payload: reserveRequest,
               });

               expect(response2.statusCode).toBe(201);

               // Verify inventory
               const sku1Response = await app.inject({
                    method: 'GET',
                    url: '/inventory/SKU-001',
               });
               const sku1Data = sku1Response.json();
               expect(sku1Data.totalAvailable).toBe(990); // Only reserved once

               const sku2Response = await app.inject({
                    method: 'GET',
                    url: '/inventory/SKU-002',
               });
               const sku2Data = sku2Response.json();
               expect(sku2Data.totalAvailable).toBe(480); // 500 - 20
          });

          it('should reject reserve request with different lines for same order', async () => {
               const firstRequest = {
                    orderId: 'ORDER-CONFLICT-001',
                    lines: [{ skuBatchId: batchId1, quantity: 10 }],
               };

               // First request
               const response1 = await app.inject({
                    method: 'POST',
                    url: '/inventory/reserve',
                    payload: firstRequest,
               });

               expect(response1.statusCode).toBe(201);

               // Second request with different quantity - should fail
               const conflictRequest = {
                    orderId: 'ORDER-CONFLICT-001',
                    lines: [{ skuBatchId: batchId1, quantity: 20 }],
               };

               const response2 = await app.inject({
                    method: 'POST',
                    url: '/inventory/reserve',
                    payload: conflictRequest,
               });

               expect(response2.statusCode).toBe(409);
               expect(response2.json()).toMatchObject({
                    error: 'ORDER_ALREADY_RESERVED',
               });
          });

          it('should reject reserve request with different batches for same order', async () => {
               const firstRequest = {
                    orderId: 'ORDER-CONFLICT-002',
                    lines: [{ skuBatchId: batchId1, quantity: 10 }],
               };

               const response1 = await app.inject({
                    method: 'POST',
                    url: '/inventory/reserve',
                    payload: firstRequest,
               });

               expect(response1.statusCode).toBe(201);

               // Try to reserve different batch
               const conflictRequest = {
                    orderId: 'ORDER-CONFLICT-002',
                    lines: [{ skuBatchId: batchId2, quantity: 10 }],
               };

               const response2 = await app.inject({
                    method: 'POST',
                    url: '/inventory/reserve',
                    payload: conflictRequest,
               });

               expect(response2.statusCode).toBe(409);
               expect(response2.json()).toMatchObject({
                    error: 'ORDER_ALREADY_RESERVED',
               });
          });
     });

     describe('Release Idempotency', () => {
          it('should return success on duplicate release request', async () => {
               // First, reserve some inventory
               const reserveRequest = {
                    orderId: 'ORDER-RELEASE-IDEMPOTENT-001',
                    lines: [{ skuBatchId: batchId1, quantity: 10 }],
               };

               await app.inject({
                    method: 'POST',
                    url: '/inventory/reserve',
                    payload: reserveRequest,
               });

               // First release
               const response1 = await app.inject({
                    method: 'POST',
                    url: '/inventory/release',
                    payload: {
                         orderId: 'ORDER-RELEASE-IDEMPOTENT-001',
                         reason: 'CANCELLED',
                    },
               });

               expect(response1.statusCode).toBe(200);
               expect(response1.json()).toMatchObject({
                    status: 'ok',
                    orderId: 'ORDER-RELEASE-IDEMPOTENT-001',
               });

               // Second release - should be idempotent
               const response2 = await app.inject({
                    method: 'POST',
                    url: '/inventory/release',
                    payload: {
                         orderId: 'ORDER-RELEASE-IDEMPOTENT-001',
                         reason: 'CANCELLED',
                    },
               });

               expect(response2.statusCode).toBe(200);
               expect(response2.json()).toMatchObject({
                    status: 'ok',
                    orderId: 'ORDER-RELEASE-IDEMPOTENT-001',
               });

               // Verify inventory was only released once
               const inventoryResponse = await app.inject({
                    method: 'GET',
                    url: '/inventory/SKU-001',
               });

               expect(inventoryResponse.statusCode).toBe(200);
               const inventoryData = inventoryResponse.json();
               expect(inventoryData.totalAvailable).toBe(1000); // Back to original
          });

          it('should handle concurrent release requests gracefully', async () => {
               // Reserve inventory first
               const reserveRequest = {
                    orderId: 'ORDER-CONCURRENT-RELEASE',
                    lines: [{ skuBatchId: batchId1, quantity: 50 }],
               };

               await app.inject({
                    method: 'POST',
                    url: '/inventory/reserve',
                    payload: reserveRequest,
               });

               // Make concurrent release requests
               const releaseRequests = Array(5)
                    .fill(null)
                    .map(() =>
                         app.inject({
                              method: 'POST',
                              url: '/inventory/release',
                              payload: {
                                   orderId: 'ORDER-CONCURRENT-RELEASE',
                                   reason: 'CANCELLED',
                              },
                         })
                    );

               const responses = await Promise.all(releaseRequests);

               // All should succeed
               responses.forEach((response) => {
                    expect(response.statusCode).toBe(200);
               });

               // Verify inventory is back to original - only released once
               const inventoryResponse = await app.inject({
                    method: 'GET',
                    url: '/inventory/SKU-001',
               });

               const inventoryData = inventoryResponse.json();
               expect(inventoryData.totalAvailable).toBe(1000);
          });
     });

     describe('Reserve-Release-Reserve Cycle', () => {
          it('should allow reserve after release', async () => {
               const reserveRequest = {
                    orderId: 'ORDER-CYCLE-001',
                    lines: [{ skuBatchId: batchId1, quantity: 100 }],
               };

               // First reserve
               const reserve1 = await app.inject({
                    method: 'POST',
                    url: '/inventory/reserve',
                    payload: reserveRequest,
               });
               expect(reserve1.statusCode).toBe(201);

               // Release
               const release = await app.inject({
                    method: 'POST',
                    url: '/inventory/release',
                    payload: { orderId: 'ORDER-CYCLE-001' },
               });
               expect(release.statusCode).toBe(200);

               // Try to reserve again with same order ID - should fail as conflicting
               const reserve2 = await app.inject({
                    method: 'POST',
                    url: '/inventory/reserve',
                    payload: reserveRequest,
               });
               expect(reserve2.statusCode).toBe(409);
               expect(reserve2.json().error).toBe('ORDER_ALREADY_RESERVED');
          });
     });
});
