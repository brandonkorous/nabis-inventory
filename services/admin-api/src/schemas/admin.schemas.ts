export const forceSyncSchema = {
     tags: ['wms-sync'],
     summary: 'Force WMS sync',
     description:
          'Trigger an immediate synchronization with the WMS for all batches or a specific batch',
     security: [{ adminApiKey: [] }],
     body: {
          type: 'object',
          properties: {
               skuBatchId: {
                    type: 'integer',
                    description: 'Optional: specific batch to sync. If omitted, syncs all batches',
                    example: 123,
               },
               reason: {
                    type: 'string',
                    description: 'Reason for manual sync',
                    example: 'Correcting inventory discrepancy after warehouse count',
               },
          },
     },
     response: {
          202: {
               description: 'Sync request accepted and queued',
               type: 'object',
               properties: {
                    requestId: { type: 'integer', example: 456 },
                    status: { type: 'string', example: 'queued' },
                    message: { type: 'string', example: 'WMS sync request queued successfully' },
               },
          },
          500: {
               description: 'Internal server error',
               type: 'object',
               properties: {
                    error: { type: 'string', example: 'INTERNAL_ERROR' },
                    message: { type: 'string', example: 'Failed to queue sync request' },
               },
          },
     },
};

export const getSyncStatusSchema = {
     tags: ['wms-sync'],
     summary: 'Get sync request status',
     description: 'Check the status of a WMS sync request',
     security: [{ adminApiKey: [] }],
     params: {
          type: 'object',
          required: ['requestId'],
          properties: {
               requestId: {
                    type: 'string',
                    description: 'Sync request ID',
                    example: '456',
               },
          },
     },
     response: {
          200: {
               description: 'Sync request details',
               type: 'object',
               properties: {
                    requestId: { type: 'integer', example: 456 },
                    status: {
                         type: 'string',
                         enum: ['PENDING', 'IN_PROGRESS', 'DONE', 'FAILED'],
                         example: 'DONE',
                    },
                    requestedBy: { type: 'string', example: 'admin-api' },
                    reason: { type: 'string', example: 'Manual sync' },
                    skuBatchId: { type: 'integer', nullable: true, example: 123 },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' },
                    completedAt: { type: 'string', format: 'date-time', nullable: true },
                    error: { type: 'string', nullable: true },
               },
          },
          404: {
               description: 'Sync request not found',
               type: 'object',
               properties: {
                    error: { type: 'string', example: 'NOT_FOUND' },
                    message: { type: 'string', example: 'Sync request 456 not found' },
               },
          },
          500: {
               description: 'Internal server error',
               type: 'object',
               properties: {
                    error: { type: 'string', example: 'INTERNAL_ERROR' },
                    message: { type: 'string', example: 'Failed to retrieve sync status' },
               },
          },
     },
};
