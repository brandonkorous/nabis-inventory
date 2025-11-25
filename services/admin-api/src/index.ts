import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import cors from '@fastify/cors';
import * as dotenv from 'dotenv';
import { registerAdminRoutes } from './routes/admin';
import { checkConnection } from '@nabis/shared/src/db/client';
import { logger } from '@nabis/shared/src/utils/logger';

dotenv.config();

const PORT = parseInt(process.env.ADMIN_API_PORT || '3100', 10);
const HOST = process.env.ADMIN_API_HOST || '0.0.0.0';

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

     await app.register(cors, {
          origin: true,
     });

     await app.register(swagger, {
          openapi: {
               info: {
                    title: 'Nabis Admin API',
                    description: 'Control-plane API for inventory operations and WMS sync',
                    version: '1.0.0',
                    contact: {
                         name: 'Nabis Engineering',
                    },
               },
               servers: [
                    { url: 'http://localhost:3100', description: 'Development' },
                    { url: 'https://admin-api.nabis.brandonkorous.com', description: 'Production' },
               ],
               tags: [
                    { name: 'wms-sync', description: 'WMS synchronization operations' },
                    { name: 'inventory-admin', description: 'Inventory administrative operations' },
                    { name: 'health', description: 'Health and readiness checks' },
               ],
               components: {
                    securitySchemes: {
                         adminApiKey: {
                              type: 'apiKey',
                              name: 'X-Admin-API-Key',
                              in: 'header',
                              description: 'Admin API key for authenticated operations',
                         },
                    },
               },
               security: [{ adminApiKey: [] }],
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
                    description: 'Readiness check',
                    response: {
                         200: {
                              type: 'object',
                              properties: {
                                   status: { type: 'string', example: 'ready' },
                                   dependencies: { type: 'object' },
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
          async (_, reply) => {
               try {
                    const dbHealthy = await checkConnection();
                    if (!dbHealthy) {
                         reply.code(503);
                         return { status: 'not_ready', error: 'Database connection failed' };
                    }
                    return { status: 'ready', dependencies: { database: 'ok' } };
               } catch (error) {
                    reply.code(503);
                    return {
                         status: 'not_ready',
                         error: error instanceof Error ? error.message : 'Unknown error',
                    };
               }
          }
     );

     await app.register(registerAdminRoutes, { prefix: '/admin' });

     try {
          await app.listen({ port: PORT, host: HOST });
          logger.info(`Admin API listening on ${HOST}:${PORT}`);
          logger.info(`OpenAPI docs available at http://${HOST}:${PORT}/docs`);
     } catch (err) {
          logger.error({ err }, 'Failed to start server');
          process.exit(1);
     }

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
