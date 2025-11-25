import { WmsMockClient } from '@nabis/shared/src/clients/wms-client';

describe('WmsMockClient (Unit)', () => {
     let wmsClient: WmsMockClient;

     beforeEach(() => {
          jest.useFakeTimers();
          wmsClient = new WmsMockClient();
     });

     afterEach(() => {
          jest.useRealTimers();
     });

     describe('allocate', () => {
          it('should successfully allocate inventory', async () => {
               const promise = wmsClient.allocate({
                    skuBatchId: 1,
                    externalBatchId: 'BATCH-1',
                    quantity: 10,
                    orderRef: 'ORDER-001',
               });

               jest.runAllTimers();
               await expect(promise).resolves.toBeUndefined();
          });

          it('should update internal inventory state', async () => {
               const promise = wmsClient.allocate({
                    skuBatchId: 1,
                    quantity: 100,
                    orderRef: 'ORDER-001',
               });

               jest.runAllTimers();
               await promise;

               const invPromise = wmsClient.getInventory({ skuBatchId: 1 });
               jest.runAllTimers();
               const inventory = await invPromise;

               expect(inventory[0].orderableQuantity).toBe(9900); // 10000 - 100
          });
     });

     describe('release', () => {
          it('should successfully release inventory', async () => {
               const promise = wmsClient.release({
                    skuBatchId: 1,
                    quantity: 50,
                    orderRef: 'ORDER-001',
               });

               jest.runAllTimers();
               await expect(promise).resolves.toBeUndefined();
          });
     });

     describe('getInventory', () => {
          it('should return inventory for specific batch', async () => {
               const promise = wmsClient.getInventory({ skuBatchId: 1 });
               jest.runAllTimers();
               const result = await promise;

               expect(result).toHaveLength(1);
               expect(result[0].skuBatchId).toBe(1);
               expect(result[0].wmsSkuBatchId).toBe('EXT-BATCH-1');
               expect(result[0].orderableQuantity).toBeGreaterThan(0);
          });

          it('should return multiple batches when no filter', async () => {
               const promise = wmsClient.getInventory();
               jest.runAllTimers();
               const result = await promise;

               expect(result.length).toBeGreaterThan(1);
               expect(result.every((item) => item.orderableQuantity >= 0)).toBe(true);
          });
     });
});
