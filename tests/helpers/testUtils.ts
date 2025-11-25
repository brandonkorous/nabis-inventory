import { pool } from '@nabis/shared/src/db/client';
import type { PoolClient } from 'pg';

/**
 * Test utilities for database setup and teardown
 */

export async function setupTestDb(): Promise<void> {
     const client = await pool.connect();
     try {
          // Use advisory lock to prevent concurrent test setup
          await client.query('SELECT pg_advisory_lock(123456789)');

          // Clear all tables in reverse dependency order
          await client.query('TRUNCATE TABLE domain_event CASCADE');
          await client.query('TRUNCATE TABLE wms_sync_request CASCADE');
          await client.query('TRUNCATE TABLE wms_sync_state CASCADE');
          await client.query('TRUNCATE TABLE wms_inventory_snapshot CASCADE');
          await client.query('TRUNCATE TABLE order_reservation CASCADE');
          await client.query('TRUNCATE TABLE inventory_ledger CASCADE');
          await client.query('TRUNCATE TABLE sku_batch CASCADE');
          await client.query('TRUNCATE TABLE sku CASCADE');

          // Reset sequences
          await client.query('ALTER SEQUENCE sku_id_seq RESTART WITH 1');
          await client.query('ALTER SEQUENCE sku_batch_id_seq RESTART WITH 1');
          await client.query('ALTER SEQUENCE inventory_ledger_id_seq RESTART WITH 1');
          await client.query('ALTER SEQUENCE order_reservation_id_seq RESTART WITH 1');
          await client.query('ALTER SEQUENCE wms_inventory_snapshot_id_seq RESTART WITH 1');
          await client.query('ALTER SEQUENCE wms_sync_state_id_seq RESTART WITH 1');
          await client.query('ALTER SEQUENCE domain_event_id_seq RESTART WITH 1');
          await client.query('ALTER SEQUENCE wms_sync_request_id_seq RESTART WITH 1');

          // Release advisory lock
          await client.query('SELECT pg_advisory_unlock(123456789)');
     } finally {
          client.release();
     }
}

export async function teardownTestDb(): Promise<void> {
     await pool.end();
}

/**
 * Create a test SKU
 */
export async function createTestSku(skuCode: string = 'TEST-SKU-001'): Promise<number> {
     const client = await pool.connect();
     try {
          const result = await client.query(
               `INSERT INTO sku (sku_code, name)
       VALUES ($1, $2)
       RETURNING id`,
               [skuCode, `Test Product ${skuCode}`]
          );
          return parseInt(result.rows[0].id, 10);
     } finally {
          client.release();
     }
}

/**
 * Create a test SKU batch
 */
export async function createTestSkuBatch(
     skuId: number,
     totalQuantity: number = 100,
     externalBatchId: string = 'BATCH-001',
     lotNumber: string = 'LOT-001'
): Promise<number> {
     const result = await pool.query(
          `INSERT INTO sku_batch (sku_id, external_batch_id, lot_number, total_quantity, available_quantity)
     VALUES ($1, $2, $3, $4, $4)
     RETURNING id`,
          [skuId, externalBatchId, lotNumber, totalQuantity]
     );
     return parseInt(result.rows[0].id, 10);
}

/**
 * Get current available quantity for a SKU batch
 */
export async function getAvailableQuantity(skuBatchId: number): Promise<number> {
     const result = await pool.query(
          `SELECT available_quantity as available
     FROM sku_batch
     WHERE id = $1`,
          [skuBatchId]
     );
     return parseInt(result.rows[0].available, 10);
}

/**
 * Get reservation count for an order
 */
export async function getReservationCount(orderId: string): Promise<number> {
     const result = await pool.query(
          `SELECT COUNT(*) as count
     FROM order_reservation
     WHERE order_id = $1`,
          [orderId]
     );
     return parseInt(result.rows[0].count, 10);
}

/**
 * Get domain events for an aggregate
 */
export async function getDomainEvents(
     status: string = 'PENDING'
): Promise<Array<Record<string, unknown>>> {
     const result = await pool.query(
          `SELECT * FROM domain_event
     WHERE status = $1
     ORDER BY created_at ASC`,
          [status]
     );
     return result.rows;
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
     condition: () => Promise<boolean>,
     timeoutMs: number = 5000,
     intervalMs: number = 100
): Promise<void> {
     const startTime = Date.now();

     while (Date.now() - startTime < timeoutMs) {
          if (await condition()) {
               return;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
     }

     throw new Error('Timeout waiting for condition');
}

/**
 * Execute a function with a PoolClient from the pool
 */
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
     const client = await pool.connect();
     try {
          return await fn(client);
     } finally {
          client.release();
     }
}
