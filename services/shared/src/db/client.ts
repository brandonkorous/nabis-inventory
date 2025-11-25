import { Pool, PoolClient, PoolConfig } from 'pg';
import { logger } from '../utils/logger';

const config: PoolConfig = {
     connectionString: process.env.DATABASE_URL,
     // In test mode, use minimal connections and short timeouts
     min: process.env.NODE_ENV === 'test' ? 0 : parseInt(process.env.DB_POOL_MIN || '2', 10),
     max: process.env.NODE_ENV === 'test' ? 2 : parseInt(process.env.DB_POOL_MAX || '10', 10),
     idleTimeoutMillis:
          process.env.NODE_ENV === 'test'
               ? 100
               : parseInt(process.env.DB_IDLE_TIMEOUT_MS || '10000', 10),
     connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '5000', 10),
};
export const pool = new Pool(config);

// Log pool errors
pool.on('error', (err) => {
     logger.error({ err }, 'Unexpected PostgreSQL pool error');
});

// Connection health check
export async function checkConnection(): Promise<boolean> {
     try {
          const client = await pool.connect();
          await client.query('SELECT 1');
          client.release();
          return true;
     } catch (error) {
          logger.error({ error }, 'Database connection check failed');
          return false;
     }
}

// Transaction helper
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
     const client = await pool.connect();
     try {
          await client.query('BEGIN');
          const result = await fn(client);
          await client.query('COMMIT');
          return result;
     } catch (err) {
          await client.query('ROLLBACK');
          throw err;
     } finally {
          client.release();
     }
}

// Connection helper for non-transactional queries
export async function withConnection<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
     const client = await pool.connect();
     try {
          return await fn(client);
     } finally {
          client.release();
     }
}

// Graceful shutdown
export async function closePool(): Promise<void> {
     await pool.end();
     logger.info('Database pool closed');
}

// Handle shutdown signals (disabled in test mode)
if (process.env.NODE_ENV !== 'test') {
     process.on('SIGINT', async () => {
          await closePool();
          process.exit(0);
     });

     process.on('SIGTERM', async () => {
          await closePool();
          process.exit(0);
     });
}
