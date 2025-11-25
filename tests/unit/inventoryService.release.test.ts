import { InventoryService } from '@nabis/shared/src/services/inventory-service';
import { PoolClient } from 'pg';
import { OrderNotFoundError } from '@nabis/shared/src/utils/errors';

describe('InventoryService - Release Inventory (Unit)', () => {
     let inventoryService: InventoryService;
     let mockClient: jest.Mocked<PoolClient>;

     beforeEach(() => {
          inventoryService = new InventoryService();
          mockClient = {
               query: jest.fn(),
          } as unknown as jest.Mocked<PoolClient>;
     });

     describe('Order not found', () => {
          it('should throw when no reservations exist', async () => {
               mockClient.query.mockResolvedValueOnce({
                    rows: [], // No reservations
               } as never);

               await expect(
                    inventoryService.releaseInventoryForOrder(mockClient, {
                         orderId: 'ORDER-999',
                    })
               ).rejects.toThrow(OrderNotFoundError);
          });
     });

     describe('Successful release', () => {
          it('should release single reservation', async () => {
               // Mock get reservations
               mockClient.query.mockResolvedValueOnce({
                    rows: [{ id: 1, sku_batch_id: 10, quantity: 50 }],
               } as never);

               // Mock lock batches
               mockClient.query.mockResolvedValueOnce({ rows: [] } as never);

               // Mock per-reservation queries (UPDATE batch, INSERT ledger, UPDATE reservation, INSERT event)
               mockClient.query.mockResolvedValueOnce({ rows: [] } as never);
               mockClient.query.mockResolvedValueOnce({ rows: [] } as never);
               mockClient.query.mockResolvedValueOnce({ rows: [] } as never);
               mockClient.query.mockResolvedValueOnce({ rows: [] } as never);

               await inventoryService.releaseInventoryForOrder(mockClient, {
                    orderId: 'ORDER-001',
                    reason: 'CANCELLED',
               });

               expect(mockClient.query).toHaveBeenCalledTimes(6);

               // Verify UPDATE sku_batch (return quantity)
               expect(mockClient.query).toHaveBeenCalledWith(
                    expect.stringContaining('UPDATE sku_batch'),
                    [50, 10]
               );

               // Verify UPDATE order_reservation (set to CANCELLED)
               expect(mockClient.query).toHaveBeenCalledWith(
                    expect.stringContaining('UPDATE order_reservation'),
                    [1]
               );
          });

          it('should release multiple reservations', async () => {
               // Mock get reservations
               mockClient.query.mockResolvedValueOnce({
                    rows: [
                         { id: 1, sku_batch_id: 10, quantity: 50 },
                         { id: 2, sku_batch_id: 20, quantity: 30 },
                    ],
               } as never);

               // Mock lock batches
               mockClient.query.mockResolvedValueOnce({ rows: [] } as never);

               // Mock 4 queries per reservation * 2 reservations
               for (let i = 0; i < 8; i++) {
                    mockClient.query.mockResolvedValueOnce({ rows: [] } as never);
               }

               await inventoryService.releaseInventoryForOrder(mockClient, {
                    orderId: 'ORDER-001',
               });

               expect(mockClient.query).toHaveBeenCalledTimes(10); // 1 SELECT + 1 lock + 4*2
          });
     });

     describe('Locking behavior', () => {
          it('should lock reservations and batches', async () => {
               mockClient.query.mockResolvedValueOnce({
                    rows: [{ id: 1, sku_batch_id: 10, quantity: 50 }],
               } as never);
               mockClient.query.mockResolvedValue({ rows: [] } as never);

               await inventoryService.releaseInventoryForOrder(mockClient, {
                    orderId: 'ORDER-001',
               });

               // First query locks reservations
               expect(mockClient.query).toHaveBeenNthCalledWith(
                    1,
                    expect.stringContaining('FOR UPDATE'),
                    ['ORDER-001']
               );

               // Second query locks batches
               expect(mockClient.query).toHaveBeenNthCalledWith(
                    2,
                    expect.stringContaining('FOR UPDATE'),
                    [[10]]
               );
          });
     });
});
