export const reserveInventorySchema = {
     tags: ['inventory'],
     summary: 'Reserve inventory for an order',
     description:
          'Atomically reserves inventory for all lines in an order. Prevents overselling through database-level locking.',
     body: {
          type: 'object',
          required: ['orderId', 'lines'],
          properties: {
               orderId: {
                    type: 'string',
                    description: 'Unique order identifier',
                    example: 'ORD-2024-12345',
               },
               lines: {
                    type: 'array',
                    description: 'Array of order lines to reserve',
                    minItems: 1,
                    items: {
                         type: 'object',
                         required: ['skuBatchId', 'quantity'],
                         properties: {
                              skuBatchId: {
                                   type: 'integer',
                                   description: 'ID of the SKU batch to allocate from',
                                   minimum: 1,
                                   example: 123,
                              },
                              quantity: {
                                   type: 'integer',
                                   description: 'Quantity to reserve',
                                   minimum: 1,
                                   example: 10,
                              },
                         },
                    },
               },
          },
     },
     response: {
          201: {
               description: 'Inventory reserved successfully',
               type: 'object',
               properties: {
                    status: { type: 'string', example: 'ok' },
                    message: { type: 'string', example: 'Inventory reserved successfully' },
                    orderId: { type: 'string', example: 'ORD-2024-12345' },
               },
          },
          400: {
               description: 'Invalid request',
               type: 'object',
               properties: {
                    error: { type: 'string', example: 'INVALID_QUANTITY' },
                    message: { type: 'string', example: 'Quantity must be positive' },
               },
          },
          404: {
               description: 'Batch not found',
               type: 'object',
               properties: {
                    error: { type: 'string', example: 'BATCH_NOT_FOUND' },
                    message: { type: 'string', example: 'SKU batch 123 not found' },
               },
          },
          409: {
               description: 'Insufficient inventory',
               type: 'object',
               properties: {
                    error: { type: 'string', example: 'INSUFFICIENT_INVENTORY' },
                    message: {
                         type: 'string',
                         example: 'Insufficient inventory for batch 123: requested 100, available 50',
                    },
               },
          },
          500: {
               description: 'Internal server error',
               type: 'object',
               properties: {
                    error: { type: 'string', example: 'INTERNAL_ERROR' },
                    message: { type: 'string', example: 'An unexpected error occurred' },
               },
          },
     },
};

export const releaseInventorySchema = {
     tags: ['inventory'],
     summary: 'Release reserved inventory',
     description: 'Releases inventory previously reserved for an order (e.g., on cancellation)',
     body: {
          type: 'object',
          required: ['orderId'],
          properties: {
               orderId: {
                    type: 'string',
                    description: 'Order ID to release inventory for',
                    example: 'ORD-2024-12345',
               },
               reason: {
                    type: 'string',
                    description: 'Reason for release',
                    example: 'Order cancelled by customer',
               },
          },
     },
     response: {
          200: {
               description: 'Inventory released successfully',
               type: 'object',
               properties: {
                    status: { type: 'string', example: 'ok' },
                    message: { type: 'string', example: 'Inventory released successfully' },
                    orderId: { type: 'string', example: 'ORD-2024-12345' },
               },
          },
          404: {
               description: 'Order not found',
               type: 'object',
               properties: {
                    error: { type: 'string', example: 'ORDER_NOT_FOUND' },
                    message: { type: 'string', example: 'Order ORD-2024-12345 not found' },
               },
          },
          500: {
               description: 'Internal server error',
               type: 'object',
               properties: {
                    error: { type: 'string', example: 'INTERNAL_ERROR' },
                    message: { type: 'string', example: 'An unexpected error occurred' },
               },
          },
     },
};

export const getInventorySchema = {
     tags: ['inventory'],
     summary: 'Get available inventory for a SKU',
     description: 'Returns all batches and total available quantity for a given SKU',
     params: {
          type: 'object',
          required: ['sku'],
          properties: {
               sku: {
                    type: 'string',
                    description: 'SKU code to query',
                    example: 'SKU-FLOWER-001',
               },
          },
     },
     response: {
          200: {
               description: 'Inventory details',
               type: 'object',
               properties: {
                    skuCode: { type: 'string', example: 'SKU-FLOWER-001' },
                    totalAvailable: { type: 'integer', example: 1450 },
                    batches: {
                         type: 'array',
                         items: {
                              type: 'object',
                              properties: {
                                   id: { type: 'integer', example: 123 },
                                   externalBatchId: { type: 'string', example: 'EXT-BATCH-001' },
                                   lotNumber: { type: 'string', example: 'LOT-2024-001' },
                                   availableQuantity: { type: 'integer', example: 1000 },
                                   totalQuantity: { type: 'integer', example: 1000 },
                                   expiresAt: {
                                        type: 'string',
                                        format: 'date-time',
                                        nullable: true,
                                   },
                              },
                         },
                    },
               },
          },
          500: {
               description: 'Internal server error',
               type: 'object',
               properties: {
                    error: { type: 'string', example: 'INTERNAL_ERROR' },
                    message: { type: 'string', example: 'An unexpected error occurred' },
               },
          },
     },
};
