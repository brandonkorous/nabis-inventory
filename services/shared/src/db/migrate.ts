import { promises as fs } from 'fs';
import { join } from 'path';
import { pool } from './client';
import { logger } from '../utils/logger';

async function runMigrations() {
     const migrationsDir = join(__dirname, 'migrations');

     try {
          const files = await fs.readdir(migrationsDir);
          const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();

          logger.info({ count: sqlFiles.length }, 'Running database migrations');

          for (const file of sqlFiles) {
               const filePath = join(migrationsDir, file);
               const sql = await fs.readFile(filePath, 'utf-8');

               logger.info({ file }, 'Executing migration');
               await pool.query(sql);
               logger.info({ file }, 'Migration completed');
          }

          logger.info('All migrations completed successfully');
     } catch (error) {
          logger.error({ error }, 'Migration failed');
          throw error;
     } finally {
          await pool.end();
     }
}

// Run if executed directly
if (require.main === module) {
     runMigrations().catch((err) => {
          console.error('Migration error:', err);
          process.exit(1);
     });
}

export { runMigrations };
