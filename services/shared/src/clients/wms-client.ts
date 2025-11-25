import { WmsSnapshot } from '../types/inventory.types';
import { WmsApiError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface WmsClient {
     allocate(request: AllocateRequest): Promise<void>;
     release(request: ReleaseRequest): Promise<void>;
     getInventory(filter?: InventoryFilter): Promise<WmsSnapshot[]>;
}

export interface AllocateRequest {
     skuBatchId: number;
     externalBatchId?: string;
     quantity: number;
     orderRef: string;
}

export interface ReleaseRequest {
     skuBatchId: number;
     externalBatchId?: string;
     quantity: number;
     orderRef: string;
}

export interface InventoryFilter {
     skuBatchId?: number;
     externalBatchId?: string;
}

export class WmsHttpClient implements WmsClient {
     constructor(
          private baseUrl: string,
          private apiKey: string
     ) {}

     async allocate(request: AllocateRequest): Promise<void> {
          logger.info(
               { orderRef: request.orderRef, quantity: request.quantity },
               'WMS allocate call'
          );

          const response = await fetch(`${this.baseUrl}/allocate`, {
               method: 'POST',
               headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
               },
               body: JSON.stringify({
                    batchId: request.externalBatchId,
                    quantity: request.quantity,
                    orderReference: request.orderRef,
               }),
          });

          if (!response.ok) {
               throw new WmsApiError(response.status, await response.text());
          }

          logger.info({ orderRef: request.orderRef }, 'WMS allocate successful');
     }

     async release(request: ReleaseRequest): Promise<void> {
          logger.info(
               { orderRef: request.orderRef, quantity: request.quantity },
               'WMS release call'
          );

          const response = await fetch(`${this.baseUrl}/release`, {
               method: 'POST',
               headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
               },
               body: JSON.stringify({
                    batchId: request.externalBatchId,
                    quantity: request.quantity,
                    orderReference: request.orderRef,
               }),
          });

          if (!response.ok) {
               throw new WmsApiError(response.status, await response.text());
          }

          logger.info({ orderRef: request.orderRef }, 'WMS release successful');
     }

     async getInventory(filter?: InventoryFilter): Promise<WmsSnapshot[]> {
          logger.info({ filter }, 'WMS getInventory call');

          const params = new URLSearchParams();
          if (filter?.externalBatchId) {
               params.append('batchId', filter.externalBatchId);
          }

          const response = await fetch(`${this.baseUrl}/inventory?${params.toString()}`, {
               headers: {
                    Authorization: `Bearer ${this.apiKey}`,
               },
          });

          if (!response.ok) {
               throw new WmsApiError(response.status, await response.text());
          }

          const data = (await response.json()) as {
               batches: Array<{
                    batchId: string;
                    internalId: number;
                    available: number;
                    damaged?: number;
               }>;
          };

          return data.batches.map((batch) => ({
               wmsSkuBatchId: batch.batchId,
               skuBatchId: batch.internalId,
               orderableQuantity: batch.available,
               unallocatableQuantity: batch.damaged || 0,
               metadata: batch,
          }));
     }
}

export class WmsMockClient implements WmsClient {
     private inventory = new Map<number, number>();

     async allocate(request: AllocateRequest): Promise<void> {
          logger.debug({ request }, 'Mock WMS allocate');

          // Simulate occasional rate limiting (not in test mode)
          if (process.env.NODE_ENV !== 'test' && Math.random() < 0.05) {
               throw new WmsApiError(429, 'Rate limit exceeded');
          }

          // Simulate latency
          await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));

          const current = this.inventory.get(request.skuBatchId) || 10000;
          this.inventory.set(request.skuBatchId, Math.max(0, current - request.quantity));

          logger.debug({ orderRef: request.orderRef }, 'Mock WMS allocate completed');
     }

     async release(request: ReleaseRequest): Promise<void> {
          logger.debug({ request }, 'Mock WMS release');

          await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));

          const current = this.inventory.get(request.skuBatchId) || 10000;
          this.inventory.set(request.skuBatchId, current + request.quantity);

          logger.debug({ orderRef: request.orderRef }, 'Mock WMS release completed');
     }

     async getInventory(filter?: InventoryFilter): Promise<WmsSnapshot[]> {
          logger.debug({ filter }, 'Mock WMS getInventory');

          await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 200));

          // Return mock data
          if (filter?.skuBatchId) {
               return [
                    {
                         wmsSkuBatchId: `EXT-BATCH-${filter.skuBatchId}`,
                         skuBatchId: filter.skuBatchId,
                         orderableQuantity: this.inventory.get(filter.skuBatchId) || 1000,
                         unallocatableQuantity: 0,
                         metadata: { source: 'mock' },
                    },
               ];
          }

          // Return multiple batches
          return [1, 2, 3, 4, 5].map((id) => ({
               wmsSkuBatchId: `EXT-BATCH-${id}`,
               skuBatchId: id,
               orderableQuantity: this.inventory.get(id) || 1000,
               unallocatableQuantity: 0,
               metadata: { source: 'mock' },
          }));
     }
}

export function createWmsClient(): WmsClient {
     const clientType = process.env.WMS_CLIENT_TYPE || 'mock';

     if (clientType === 'mock') {
          logger.info('Using mock WMS client');
          return new WmsMockClient();
     }

     const baseUrl = process.env.WMS_API_URL;
     const apiKey = process.env.WMS_API_KEY;

     if (!baseUrl || !apiKey) {
          throw new Error('WMS_API_URL and WMS_API_KEY must be set for HTTP client');
     }

     logger.info({ baseUrl }, 'Using HTTP WMS client');
     return new WmsHttpClient(baseUrl, apiKey);
}
