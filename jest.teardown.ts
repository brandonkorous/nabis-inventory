// Global teardown - close database pool after all tests
export default async function globalTeardown() {
     const { pool } = await import('./services/shared/src/db/client');
     await pool.end();
     console.log('Database pool closed');
}
