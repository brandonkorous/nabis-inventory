// Custom error classes for domain-specific errors

export class DomainError extends Error {
     constructor(
          message: string,
          public readonly code: string,
          public readonly statusCode: number = 400
     ) {
          super(message);
          this.name = this.constructor.name;
          Error.captureStackTrace(this, this.constructor);
     }
}

export class InsufficientInventoryError extends DomainError {
     constructor(
          message: string,
          public readonly skuBatchId: number,
          public readonly requested: number,
          public readonly available: number
     ) {
          super(message, 'INSUFFICIENT_INVENTORY', 409);
     }
}

export class BatchNotFoundError extends DomainError {
     constructor(public readonly skuBatchId: number) {
          super(`SKU batch ${skuBatchId} not found`, 'BATCH_NOT_FOUND', 404);
     }
}

export class InvalidQuantityError extends DomainError {
     constructor(message: string) {
          super(message, 'INVALID_QUANTITY', 400);
     }
}

export class OrderNotFoundError extends DomainError {
     constructor(public readonly orderId: string) {
          super(`Order ${orderId} not found`, 'ORDER_NOT_FOUND', 404);
     }
}

export class OrderAlreadyReservedError extends DomainError {
     constructor(
          public readonly orderId: string,
          message: string = 'Order is already reserved with different lines'
     ) {
          super(message, 'ORDER_ALREADY_RESERVED', 409);
     }
}

export class WmsApiError extends Error {
     constructor(
          public readonly statusCode: number,
          message: string,
          public readonly retriable: boolean = false
     ) {
          super(message);
          this.name = 'WmsApiError';

          // 429, 503, 504 are retriable
          if ([429, 503, 504].includes(statusCode)) {
               this.retriable = true;
          }
     }
}
