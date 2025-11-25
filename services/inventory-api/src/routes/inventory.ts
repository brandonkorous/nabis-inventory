import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { withTransaction } from '@nabis/shared/src/db/client';
import { InventoryService } from '@nabis/shared/src/services/inventory-service';
import { DomainError } from '@nabis/shared/src/utils/errors';
import { logger } from '@nabis/shared/src/utils/logger';
import type { InventoryBatch } from '@nabis/shared/src/types/inventory.types';
import {
    reserveInventorySchema,
    releaseInventorySchema,
    getInventorySchema,
} from '../schemas/inventory.schemas';

const inventoryService = new InventoryService();

export async function registerInventoryRoutes(app: FastifyInstance) {
    // Reserve inventory for an order
    app.post<{
        Body: {
            orderId: string;
            lines: Array<{ skuBatchId: number; quantity: number }>;
        };
    }>(
        '/reserve',
        { schema: reserveInventorySchema },
        async (request: FastifyRequest, reply: FastifyReply) => {
            const body = request.body as {
                orderId: string;
                lines: Array<{ skuBatchId: number; quantity: number }>;
            };

            try {
                await withTransaction(async (client) => {
                    await inventoryService.reserveInventoryForOrder(client, {
                        orderId: body.orderId,
                        lines: body.lines,
                    });
                });

                reply.code(201).send({
                    status: 'ok',
                    message: 'Inventory reserved successfully',
                    orderId: body.orderId,
                });
            } catch (error) {
                if (error instanceof DomainError) {
                    reply.code(error.statusCode).send({
                        error: error.code,
                        message: error.message,
                    });
                } else {
                    logger.error({ error }, 'Failed to reserve inventory');
                    reply.code(500).send({
                        error: 'INTERNAL_ERROR',
                        message: 'An unexpected error occurred',
                    });
                }
            }
        }
    );

    // Release inventory for an order
    app.post<{
        Body: {
            orderId: string;
            reason?: string;
        };
    }>(
        '/release',
        { schema: releaseInventorySchema },
        async (request: FastifyRequest, reply: FastifyReply) => {
            const body = request.body as {
                orderId: string;
                reason?: string;
            };

            try {
                await withTransaction(async (client) => {
                    await inventoryService.releaseInventoryForOrder(client, {
                        orderId: body.orderId,
                        reason: body.reason,
                    });
                });

                reply.code(200).send({
                    status: 'ok',
                    message: 'Inventory released successfully',
                    orderId: body.orderId,
                });
            } catch (error) {
                if (error instanceof DomainError) {
                    reply.code(error.statusCode).send({
                        error: error.code,
                        message: error.message,
                    });
                } else {
                    logger.error({ error }, 'Failed to release inventory');
                    reply.code(500).send({
                        error: 'INTERNAL_ERROR',
                        message: 'An unexpected error occurred',
                    });
                }
            }
        }
    );

    // Get available inventory for a SKU
    app.get<{
        Params: {
            sku: string;
        };
    }>(
        '/:sku',
        { schema: getInventorySchema },
        async (request: FastifyRequest, reply: FastifyReply) => {
            const params = request.params as { sku: string };

            try {
                await withTransaction(async (client) => {
                    const batches = await inventoryService.getAvailableInventory(
                        client,
                        params.sku
                    );

                    const totalAvailable = batches.reduce(
                        (sum: number, batch: InventoryBatch) => sum + batch.availableQuantity,
                        0
                    );

                    reply.send({
                        skuCode: params.sku,
                        totalAvailable,
                        batches: batches.map((b: InventoryBatch) => ({
                            id: b.id,
                            externalBatchId: b.externalBatchId,
                            lotNumber: b.lotNumber,
                            availableQuantity: b.availableQuantity,
                            totalQuantity: b.totalQuantity,
                            expiresAt: b.expiresAt?.toISOString(),
                        })),
                    });
                });
            } catch (error) {
                logger.error({ error }, 'Failed to get inventory');
                reply.code(500).send({
                    error: 'INTERNAL_ERROR',
                    message: 'An unexpected error occurred',
                });
            }
        }
    );
}
