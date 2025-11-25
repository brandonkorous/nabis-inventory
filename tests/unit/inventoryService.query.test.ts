import { InventoryService } from '@nabis/shared/src/services/inventory-service';
import { PoolClient } from 'pg';

describe('InventoryService - Query Inventory (Unit)', () => {
     let inventoryService: InventoryService;
     let mockClient: jest.Mocked<PoolClient>;

     beforeEach(() => {
          inventoryService = new InventoryService();
          mockClient = {
               query: jest.fn(),
          } as unknown as jest.Mocked<PoolClient>;
     });

     describe('Get available inventory', () => {
          it('should return batches for SKU', async () => {
               const mockBatches = [
                    {
                         id: 1,
                         sku_id: 100,
                         sku_code: 'SKU-001',
                         external_batch_id: 'BATCH-1',
                         lot_number: 'LOT-1',
                         total_quantity: 100,
                         unallocatable_quantity: 0,
                         available_quantity: 90,
                         expires_at: null,
                    },
                    {
                         id: 2,
                         sku_id: 100,
                         sku_code: 'SKU-001',
                         external_batch_id: 'BATCH-2',
                         lot_number: 'LOT-2',
                         total_quantity: 50,
                         unallocatable_quantity: 5,
                         available_quantity: 45,
                         expires_at: new Date('2026-12-31'),
                    },
               ];

               mockClient.query.mockResolvedValueOnce({
                    rows: mockBatches,
               } as never);

               const result = await inventoryService.getAvailableInventory(mockClient, 'SKU-001');

               expect(result).toHaveLength(2);
               expect(result[0]).toEqual({
                    id: 1,
                    skuId: 100,
                    skuCode: 'SKU-001',
                    externalBatchId: 'BATCH-1',
                    lotNumber: 'LOT-1',
                    totalQuantity: 100,
                    unallocatableQuantity: 0,
                    availableQuantity: 90,
                    expiresAt: undefined,
               });
               expect(result[1].availableQuantity).toBe(45);
               expect(result[1].expiresAt).toEqual(new Date('2026-12-31'));
          });

          it('should return empty array for non-existent SKU', async () => {
               mockClient.query.mockResolvedValueOnce({
                    rows: [],
               } as never);

               const result = await inventoryService.getAvailableInventory(mockClient, 'SKU-999');

               expect(result).toEqual([]);
          });

          it('should query with correct SQL', async () => {
               mockClient.query.mockResolvedValueOnce({ rows: [] } as never);

               await inventoryService.getAvailableInventory(mockClient, 'SKU-001');

               expect(mockClient.query).toHaveBeenCalledWith(
                    expect.stringContaining('JOIN sku s ON'),
                    ['SKU-001']
               );
          });

          it('should order by expiry date', async () => {
               mockClient.query.mockResolvedValueOnce({ rows: [] } as never);

               await inventoryService.getAvailableInventory(mockClient, 'SKU-001');

               expect(mockClient.query).toHaveBeenCalledWith(
                    expect.stringContaining('ORDER BY b.expires_at'),
                    expect.anything()
               );
          });
     });
});
