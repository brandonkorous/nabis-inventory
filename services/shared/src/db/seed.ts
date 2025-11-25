import { pool, withTransaction } from './client';
import { logger } from '../utils/logger';

async function seedDatabase() {
     try {
          logger.info('Seeding database with test data');

          await withTransaction(async (client) => {
               // Insert test SKUs
               const { rows: skus } = await client.query(`
        INSERT INTO sku (sku_code, name) VALUES
        ('SKU-FLOWER-001', 'Premium Flower - Strain A'),
        ('SKU-FLOWER-002', 'Premium Flower - Strain B'),
        ('SKU-EDIBLE-001', 'Gummy Bears 10mg'),
        ('SKU-CONCENTRATE-001', 'Live Resin Cartridge')
        ON CONFLICT (sku_code) DO NOTHING
        RETURNING id, sku_code
      `);

               logger.info({ count: skus.length }, 'Inserted SKUs');

               // Insert test batches for each SKU
               for (const sku of skus) {
                    await client.query(
                         `
          INSERT INTO sku_batch (
            sku_id, 
            external_batch_id, 
            lot_number,
            total_quantity, 
            unallocatable_quantity, 
            available_quantity,
            expires_at
          ) VALUES
          ($1, $2, $3, 1000, 0, 1000, NOW() + INTERVAL '1 year'),
          ($1, $4, $5, 500, 50, 450, NOW() + INTERVAL '6 months')
          ON CONFLICT DO NOTHING
        `,
                         [
                              sku.id,
                              `EXT-${sku.sku_code}-BATCH-1`,
                              `LOT-${sku.sku_code}-001`,
                              `EXT-${sku.sku_code}-BATCH-2`,
                              `LOT-${sku.sku_code}-002`,
                         ]
                    );
               }

               logger.info('Inserted test batches');

               // Insert initial ledger entries
               const { rows: batches } = await client.query(`
        SELECT id FROM sku_batch LIMIT 10
      `);

               for (const batch of batches) {
                    await client.query(
                         `
          INSERT INTO inventory_ledger (
            sku_batch_id,
            type,
            quantity_delta,
            source,
            reference_id
          ) VALUES ($1, 'RECEIPT', (SELECT total_quantity FROM sku_batch WHERE id = $1), 'WMS_SYNC', 'INITIAL_LOAD')
        `,
                         [batch.id]
                    );
               }

               logger.info('Inserted initial ledger entries');
          });

          logger.info('Database seeding completed successfully');
     } catch (error) {
          logger.error({ error }, 'Seeding failed');
          throw error;
     } finally {
          await pool.end();
     }
}

// Run if executed directly
if (require.main === module) {
     seedDatabase().catch((err) => {
          console.error('Seed error:', err);
          process.exit(1);
     });
}

export { seedDatabase };
