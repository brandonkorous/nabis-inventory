import {
     DomainError,
     InsufficientInventoryError,
     BatchNotFoundError,
     InvalidQuantityError,
     OrderNotFoundError,
     WmsApiError,
} from '@nabis/shared/src/utils/errors';

describe('Error Classes', () => {
     describe('DomainError', () => {
          it('should create a domain error with message and code', () => {
               const error = new DomainError('Test error', 'TEST_CODE');
               expect(error.message).toBe('Test error');
               expect(error.code).toBe('TEST_CODE');
               expect(error.statusCode).toBe(400);
               expect(error.name).toBe('DomainError');
               expect(error instanceof Error).toBe(true);
          });

          it('should accept custom status code', () => {
               const error = new DomainError('Test error', 'TEST_CODE', 500);
               expect(error.statusCode).toBe(500);
          });
     });

     describe('InsufficientInventoryError', () => {
          it('should create error with message and details', () => {
               const error = new InsufficientInventoryError(
                    'Insufficient inventory for SKU-001',
                    1,
                    10,
                    5
               );
               expect(error.message).toContain('SKU-001');
               expect(error.code).toBe('INSUFFICIENT_INVENTORY');
               expect(error.statusCode).toBe(409);
               expect(error.skuBatchId).toBe(1);
               expect(error.requested).toBe(10);
               expect(error.available).toBe(5);
               expect(error.name).toBe('InsufficientInventoryError');
          });
     });

     describe('BatchNotFoundError', () => {
          it('should create error with batch ID', () => {
               const error = new BatchNotFoundError(123);
               expect(error.message).toContain('123');
               expect(error.code).toBe('BATCH_NOT_FOUND');
               expect(error.statusCode).toBe(404);
               expect(error.skuBatchId).toBe(123);
          });
     });

     describe('InvalidQuantityError', () => {
          it('should create error with message', () => {
               const error = new InvalidQuantityError('Quantity must be positive');
               expect(error.message).toBe('Quantity must be positive');
               expect(error.code).toBe('INVALID_QUANTITY');
               expect(error.statusCode).toBe(400);
          });
     });

     describe('OrderNotFoundError', () => {
          it('should create error with order ID', () => {
               const error = new OrderNotFoundError('ORD-001');
               expect(error.message).toContain('ORD-001');
               expect(error.code).toBe('ORDER_NOT_FOUND');
               expect(error.statusCode).toBe(404);
               expect(error.orderId).toBe('ORD-001');
          });
     });

     describe('WmsApiError', () => {
          it('should create error with status code and message', () => {
               const error = new WmsApiError(500, 'Internal server error');
               expect(error.message).toBe('Internal server error');
               expect(error.statusCode).toBe(500);
               expect(error.retriable).toBe(false);
               expect(error.name).toBe('WmsApiError');
          });

          it('should mark 429 errors as retriable', () => {
               const error = new WmsApiError(429, 'Rate limit exceeded');
               expect(error.retriable).toBe(true);
          });

          it('should mark 503 errors as retriable', () => {
               const error = new WmsApiError(503, 'Service unavailable');
               expect(error.retriable).toBe(true);
          });

          it('should mark 504 errors as retriable', () => {
               const error = new WmsApiError(504, 'Gateway timeout');
               expect(error.retriable).toBe(true);
          });

          it('should mark 500 errors as not retriable', () => {
               const error = new WmsApiError(500, 'Internal error');
               expect(error.retriable).toBe(false);
          });
     });

     describe('Error inheritance', () => {
          it('should maintain error stack traces', () => {
               const error = new DomainError('Test', 'TEST');
               expect(error.stack).toBeDefined();
               expect(error.stack).toContain('DomainError');
          });

          it('should be catchable as Error', () => {
               try {
                    throw new InsufficientInventoryError('Test', 1, 10, 5);
               } catch (error) {
                    expect(error instanceof Error).toBe(true);
                    expect(error instanceof DomainError).toBe(true);
               }
          });

          it('should preserve error type information', () => {
               const error = new WmsApiError(500, 'Test');
               expect(error).toBeInstanceOf(Error);
               expect(error).toBeInstanceOf(WmsApiError);
          });
     });
});
