// Type definitions for domain models

export interface OrderLine {
     skuBatchId: number;
     quantity: number;
}

export interface ReserveInventoryRequest {
     orderId: string;
     lines: OrderLine[];
}

export interface ReleaseInventoryRequest {
     orderId: string;
     reason?: string;
}

export interface InventoryBatch {
     id: number;
     skuId: number;
     skuCode: string;
     externalBatchId?: string;
     lotNumber?: string;
     totalQuantity: number;
     unallocatableQuantity: number;
     availableQuantity: number;
     expiresAt?: Date;
}

export interface InventoryLedgerEntry {
     id: number;
     skuBatchId: number;
     type: 'RECEIPT' | 'ORDER_ALLOCATE' | 'ORDER_RELEASE' | 'ADJUSTMENT';
     quantityDelta: number;
     source: 'NABIS_ORDER' | 'WMS_SYNC' | 'MANUAL_ADJUSTMENT' | 'WMS_OUTBOUND';
     referenceId?: string;
     createdAt: Date;
}

export interface OrderReservation {
     id: number;
     orderId: string;
     skuBatchId: number;
     quantity: number;
     status: 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED';
     createdAt: Date;
     expiresAt?: Date;
}

// Domain events
export interface DomainEvent {
     id: number;
     type: string;
     payload: Record<string, any>;
     status: 'PENDING' | 'SENT' | 'FAILED';
     createdAt: Date;
}

export interface InventoryAllocatedEvent {
     orderId: string;
     skuBatchId: number;
     quantity: number;
     timestamp: string;
}

export interface InventoryReleasedEvent {
     orderId: string;
     skuBatchId: number;
     quantity: number;
     reason?: string;
     timestamp: string;
}

export interface InventoryAdjustedEvent {
     skuBatchId: number;
     quantityDelta: number;
     newAvailable: number;
     source: string;
     reason: string;
     timestamp: string;
}

// WMS types
export interface WmsSnapshot {
     wmsSkuBatchId: string;
     skuBatchId?: number;
     orderableQuantity: number;
     unallocatableQuantity?: number;
     metadata?: Record<string, any>;
}

export interface WmsSyncRequest {
     id: number;
     requestedBy?: string;
     reason?: string;
     skuBatchId?: number;
     priority: number;
     status: 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'FAILED';
}
