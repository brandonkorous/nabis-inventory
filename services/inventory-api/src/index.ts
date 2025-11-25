import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import cors from '@fastify/cors';
import * as dotenv from 'dotenv';
import { registerInventoryRoutes } from './routes/inventory';
import { checkConnection } from '@nabis/shared/src/db/client';
import { logger } from '@nabis/shared/src/utils/logger';

// Load environment variables
dotenv.config();

const PORT = parseInt(process.env.INVENTORY_API_PORT || '3000', 10);
const HOST = process.env.INVENTORY_API_HOST || '0.0.0.0';

async function main() {
     const app = Fastify({
          logger: true,
          requestIdHeader: 'x-correlation-id',
          genReqId: (req) => (req.headers['x-correlation-id'] as string) || `req-${Date.now()}`,
          ajv: {
               customOptions: {
                    removeAdditional: 'all',
                    coerceTypes: true,
                    useDefaults: true,
                    strict: false,
               },
          },
     });

     // CORS
     await app.register(cors, {
          origin: true,
     });

     // OpenAPI/Swagger
     await app.register(swagger, {
          openapi: {
               info: {
                    title: 'Nabis Inventory API',
                    description: 'Production-grade inventory service for order-path operations',
                    version: '1.0.0',
                    contact: {
                         name: 'Nabis Engineering',
                    },
               },
               servers: [
                    { url: 'http://localhost:3000', description: 'Development' },
                    { url: 'https://api.nabis.brandonkorous.com', description: 'Production' },
               ],
               tags: [
                    {
                         name: 'inventory',
                         description: 'Inventory reservation and query operations',
                    },
                    { name: 'health', description: 'Health and readiness checks' },
               ],
               components: {
                    securitySchemes: {
                         apiKey: {
                              type: 'apiKey',
                              name: 'X-API-Key',
                              in: 'header',
                         },
                    },
               },
          },
     });

     await app.register(swaggerUi, {
          routePrefix: '/docs',
          uiConfig: {
               docExpansion: 'list',
               deepLinking: true,
          },
     });

     // Health checks
     app.get(
          '/health',
          {
               schema: {
                    tags: ['health'],
                    description: 'Basic health check',
                    response: {
                         200: {
                              type: 'object',
                              properties: {
                                   status: { type: 'string', example: 'ok' },
                                   timestamp: { type: 'string', format: 'date-time' },
                              },
                         },
                    },
               },
          },
          async () => {
               return {
                    status: 'ok',
                    timestamp: new Date().toISOString(),
               };
          }
     );

     app.get(
          '/health/ready',
          {
               schema: {
                    tags: ['health'],
                    description: 'Readiness check with dependency validation',
                    response: {
                         200: {
                              type: 'object',
                              properties: {
                                   status: { type: 'string', example: 'ready' },
                                   dependencies: {
                                        type: 'object',
                                        properties: {
                                             database: { type: 'string' },
                                        },
                                   },
                              },
                         },
                         503: {
                              type: 'object',
                              properties: {
                                   status: { type: 'string' },
                                   error: { type: 'string' },
                              },
                         },
                    },
               },
          },
          async (_request, reply) => {
               try {
                    const dbHealthy = await checkConnection();
                    if (!dbHealthy) {
                         reply.code(503);
                         return {
                              status: 'not_ready',
                              error: 'Database connection failed',
                         };
                    }

                    return {
                         status: 'ready',
                         dependencies: {
                              database: 'ok',
                         },
                    };
               } catch (error) {
                    reply.code(503);
                    return {
                         status: 'not_ready',
                         error: error instanceof Error ? error.message : 'Unknown error',
                    };
               }
          }
     );

     // Register inventory routes
     await app.register(registerInventoryRoutes, { prefix: '/inventory' });

     // Start server
     try {
          await app.listen({ port: PORT, host: HOST });
          logger.info(`Inventory API listening on ${HOST}:${PORT}`);
          logger.info(`OpenAPI docs available at http://${HOST}:${PORT}/docs`);
     } catch (err) {
          logger.error({ err }, 'Failed to start server');
          process.exit(1);
     }

     // Graceful shutdown
     const shutdown = async () => {
          logger.info('Shutting down gracefully...');
          await app.close();
          process.exit(0);
     };

     process.on('SIGINT', shutdown);
     process.on('SIGTERM', shutdown);
}

main().catch((err) => {
     console.error('Fatal error:', err);
     process.exit(1);
});
