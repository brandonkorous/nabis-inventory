import { WmsSyncService } from '@nabis/shared/src/services/wms-sync-service';
import { PoolClient } from 'pg';
import { WmsSnapshot } from '@nabis/shared/src/types/inventory.types';

describe('WmsSyncService (Unit)', () => {
     let wmsSyncService: WmsSyncService;
     let mockClient: jest.Mocked<PoolClient>;

     beforeEach(() => {
          mockClient = {
               query: jest.fn(),
          } as unknown as jest.Mocked<PoolClient>;

          wmsSyncService = new WmsSyncService();
     });

     describe('processSyncRequest', () => {
          it('should update sync request status to IN_PROGRESS then DONE', async () => {
               const requestId = 1;
               const wmsSnapshots: WmsSnapshot[] = [
                    {
                         wmsSkuBatchId: 'WMS-001',
                         skuBatchId: 1,
                         orderableQuantity: 90,
                         unallocatableQuantity: 0,
                    },
               ];

               // Mock all queries
               mockClient.query.mockResolvedValue({ rows: [] } as never);

               await wmsSyncService.processSyncRequest(mockClient, requestId, wmsSnapshots);

               // Should update status to IN_PROGRESS
               expect(mockClient.query).toHaveBeenCalledWith(
                    expect.stringContaining("SET status = 'IN_PROGRESS'"),
                    [requestId]
               );

               // Should update status to DONE at the end
               expect(mockClient.query).toHaveBeenCalledWith(
                    expect.stringContaining("SET status = 'DONE'"),
                    [requestId]
               );
          });

          it('should process each snapshot', async () => {
               const wmsSnapshots: WmsSnapshot[] = [
                    {
                         wmsSkuBatchId: 'WMS-001',
                         skuBatchId: 1,
                         orderableQuantity: 90,
                         unallocatableQuantity: 0,
                    },
                    {
                         wmsSkuBatchId: 'WMS-002',
                         skuBatchId: 2,
                         orderableQuantity: 50,
                         unallocatableQuantity: 5,
                    },
               ];

               mockClient.query.mockResolvedValue({
                    rows: [{ available_quantity: 100, total_quantity: 100 }],
               } as never);

               await wmsSyncService.processSyncRequest(mockClient, 1, wmsSnapshots);

               // Should insert snapshot for each WMS batch
               const insertCalls = (mockClient.query as jest.Mock).mock.calls.filter((call) =>
                    call[0].includes('INSERT INTO wms_inventory_snapshot')
               );

               expect(insertCalls.length).toBe(2);
          });

          it('should handle empty snapshots', async () => {
               mockClient.query.mockResolvedValue({ rows: [] } as never);

               await wmsSyncService.processSyncRequest(mockClient, 1, []);

               // Should still update status
               expect(mockClient.query).toHaveBeenCalledWith(
                    expect.stringContaining('IN_PROGRESS'),
                    [1]
               );

               expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('DONE'), [1]);
          });
     });

     describe('reconcileBatch', () => {
          it('should insert wms snapshot', async () => {
               const snapshot: WmsSnapshot = {
                    wmsSkuBatchId: 'WMS-001',
                    skuBatchId: 1,
                    orderableQuantity: 90,
                    unallocatableQuantity: 0,
               };

               mockClient.query.mockResolvedValue({
                    rows: [{ available_quantity: 100, total_quantity: 100 }],
               } as never);

               await wmsSyncService.reconcileBatch(mockClient, snapshot);

               expect(mockClient.query).toHaveBeenCalledWith(
                    expect.stringContaining('INSERT INTO wms_inventory_snapshot'),
                    expect.arrayContaining(['WMS-001', 1, 90])
               );
          });

          it('should skip reconciliation when skuBatchId is null', async () => {
               const snapshot: WmsSnapshot = {
                    wmsSkuBatchId: 'WMS-UNKNOWN',
                    skuBatchId: null as any,
                    orderableQuantity: 50,
                    unallocatableQuantity: 0,
               };

               mockClient.query.mockResolvedValue({ rows: [] } as never);

               await wmsSyncService.reconcileBatch(mockClient, snapshot);

               // Should only insert snapshot, not lock or update batch
               expect(mockClient.query).toHaveBeenCalledTimes(1);
          });
     });
});
