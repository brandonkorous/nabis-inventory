import { InventoryService } from '@nabis/shared/src/services/inventory-service';
import { PoolClient } from 'pg';
import {
     InsufficientInventoryError,
     BatchNotFoundError,
     InvalidQuantityError,
} from '@nabis/shared/src/utils/errors';

describe('InventoryService - Reserve Inventory (Unit)', () => {
     let inventoryService: InventoryService;
     let mockClient: jest.Mocked<PoolClient>;

     beforeEach(() => {
          inventoryService = new InventoryService();
          mockClient = {
               query: jest.fn(),
          } as unknown as jest.Mocked<PoolClient>;
     });

     describe('Input validation', () => {
          it('should reject order with no lines', async () => {
               await expect(
                    inventoryService.reserveInventoryForOrder(mockClient, {
                         orderId: 'ORDER-001',
                         lines: [],
                    })
               ).rejects.toThrow(InvalidQuantityError);
          });

          it('should reject order with negative quantity', async () => {
               await expect(
                    inventoryService.reserveInventoryForOrder(mockClient, {
                         orderId: 'ORDER-001',
                         lines: [{ skuBatchId: 1, quantity: -10 }],
                    })
               ).rejects.toThrow(InvalidQuantityError);
          });

          it('should reject order with zero quantity', async () => {
               await expect(
                    inventoryService.reserveInventoryForOrder(mockClient, {
                         orderId: 'ORDER-001',
                         lines: [{ skuBatchId: 1, quantity: 0 }],
                    })
               ).rejects.toThrow(InvalidQuantityError);
          });
     });

     describe('Batch validation', () => {
          it('should throw when batch does not exist', async () => {
               mockClient.query.mockResolvedValueOnce({
                    rows: [], // No batches found
               } as never);

               await expect(
                    inventoryService.reserveInventoryForOrder(mockClient, {
                         orderId: 'ORDER-001',
                         lines: [{ skuBatchId: 999, quantity: 10 }],
                    })
               ).rejects.toThrow(BatchNotFoundError);
          });

          it('should throw when insufficient inventory', async () => {
               mockClient.query.mockResolvedValueOnce({
                    rows: [{ id: 1, available_quantity: 5 }],
               } as never);

               await expect(
                    inventoryService.reserveInventoryForOrder(mockClient, {
                         orderId: 'ORDER-001',
                         lines: [{ skuBatchId: 1, quantity: 10 }],
                    })
               ).rejects.toThrow(InsufficientInventoryError);
          });
     });

     describe('Successful reservation', () => {
          it('should reserve inventory and create all records', async () => {
               // Mock batch query
               mockClient.query.mockResolvedValueOnce({
                    rows: [{ id: 1, available_quantity: 100 }],
               } as never);

               // Mock UPDATE sku_batch
               mockClient.query.mockResolvedValueOnce({ rows: [] } as never);

               // Mock INSERT inventory_ledger
               mockClient.query.mockResolvedValueOnce({ rows: [] } as never);

               // Mock INSERT order_reservation
               mockClient.query.mockResolvedValueOnce({ rows: [] } as never);

               // Mock INSERT domain_event
               mockClient.query.mockResolvedValueOnce({ rows: [] } as never);

               await inventoryService.reserveInventoryForOrder(mockClient, {
                    orderId: 'ORDER-001',
                    lines: [{ skuBatchId: 1, quantity: 10 }],
               });

               expect(mockClient.query).toHaveBeenCalledTimes(5);

               // Verify UPDATE sku_batch call
               expect(mockClient.query).toHaveBeenCalledWith(
                    expect.stringContaining('UPDATE sku_batch'),
                    [90, 1] // new available = 90, batch id = 1
               );

               // Verify ledger entry
               expect(mockClient.query).toHaveBeenCalledWith(
                    expect.stringContaining('INSERT INTO inventory_ledger'),
                    [1, -10, 'ORDER-001']
               );

               // Verify reservation
               expect(mockClient.query).toHaveBeenCalledWith(
                    expect.stringContaining('INSERT INTO order_reservation'),
                    ['ORDER-001', 1, 10]
               );
          });

          it('should handle multiple lines in one order', async () => {
               // Mock batch query - two batches
               mockClient.query.mockResolvedValueOnce({
                    rows: [
                         { id: 1, available_quantity: 100 },
                         { id: 2, available_quantity: 50 },
                    ],
               } as never);

               // Mock updates for batch 1
               mockClient.query.mockResolvedValueOnce({ rows: [] } as never); // UPDATE sku_batch
               mockClient.query.mockResolvedValueOnce({ rows: [] } as never); // INSERT ledger
               mockClient.query.mockResolvedValueOnce({ rows: [] } as never); // INSERT reservation
               mockClient.query.mockResolvedValueOnce({ rows: [] } as never); // INSERT domain_event

               // Mock updates for batch 2
               mockClient.query.mockResolvedValueOnce({ rows: [] } as never); // UPDATE sku_batch
               mockClient.query.mockResolvedValueOnce({ rows: [] } as never); // INSERT ledger
               mockClient.query.mockResolvedValueOnce({ rows: [] } as never); // INSERT reservation
               mockClient.query.mockResolvedValueOnce({ rows: [] } as never); // INSERT domain_event

               await inventoryService.reserveInventoryForOrder(mockClient, {
                    orderId: 'ORDER-001',
                    lines: [
                         { skuBatchId: 1, quantity: 10 },
                         { skuBatchId: 2, quantity: 5 },
                    ],
               });

               expect(mockClient.query).toHaveBeenCalledTimes(9); // 1 SELECT + 4*2 per line
          });
     });

     describe('Pessimistic locking', () => {
          it('should use FOR UPDATE when querying batches', async () => {
               mockClient.query.mockResolvedValueOnce({
                    rows: [{ id: 1, available_quantity: 100 }],
               } as never);
               mockClient.query.mockResolvedValue({ rows: [] } as never);

               await inventoryService.reserveInventoryForOrder(mockClient, {
                    orderId: 'ORDER-001',
                    lines: [{ skuBatchId: 1, quantity: 10 }],
               });

               // First query should include FOR UPDATE
               expect(mockClient.query).toHaveBeenNthCalledWith(
                    1,
                    expect.stringContaining('FOR UPDATE'),
                    expect.anything()
               );
          });
     });
});
