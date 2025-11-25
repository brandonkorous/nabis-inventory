import * as amqplib from 'amqplib';
import type { Channel, ConsumeMessage } from 'amqplib';
import { logger } from '../utils/logger';

type AmqpConnection = Awaited<ReturnType<typeof amqplib.connect>>;

let connection: AmqpConnection | null = null;
let channel: Channel | null = null;

export const INVENTORY_EVENTS_EXCHANGE = 'inventory.events';
export const WMS_COMMANDS_EXCHANGE = 'wms.commands';
export const WMS_OUTBOUND_QUEUE = 'wms.outbound';
export const WMS_SYNC_QUEUE = 'wms.sync';

async function connect(): Promise<AmqpConnection> {
     const url = process.env.AMQP_URL || 'amqp://localhost:5672';
     logger.info({ url: url.replace(/:[^:]*@/, ':****@') }, 'Connecting to RabbitMQ');

     connection = await amqplib.connect(url);

     connection!.on('error', (err) => {
          logger.error({ err }, 'RabbitMQ connection error');
     });

     connection!.on('close', () => {
          logger.warn('RabbitMQ connection closed, attempting to reconnect...');
          setTimeout(() => {
               connection = null;
               channel = null;
          }, 5000);
     });

     logger.info('Connected to RabbitMQ');
     return connection!;
}

export async function getChannel(): Promise<Channel> {
     if (channel) return channel;

     if (!connection) {
          connection = await connect();
     }

     channel = await connection!.createChannel();

     // Setup exchanges
     await channel!.assertExchange(INVENTORY_EVENTS_EXCHANGE, 'topic', { durable: true });
     await channel!.assertExchange(WMS_COMMANDS_EXCHANGE, 'topic', { durable: true });

     // Setup dead letter exchange
     await channel!.assertExchange('dlx.inventory', 'topic', { durable: true });

     // Setup queues
     await channel!.assertQueue(WMS_OUTBOUND_QUEUE, {
          durable: true,
          deadLetterExchange: 'dlx.inventory',
          deadLetterRoutingKey: 'dlq.wms.outbound',
     });

     await channel!.assertQueue(WMS_SYNC_QUEUE, {
          durable: true,
          deadLetterExchange: 'dlx.inventory',
          deadLetterRoutingKey: 'dlq.wms.sync',
     });

     // Setup DLQs
     await channel!.assertQueue('dlq.wms.outbound', { durable: true });
     await channel!.assertQueue('dlq.wms.sync', { durable: true });

     // Bind queues to exchanges
     await channel!.bindQueue(
          WMS_OUTBOUND_QUEUE,
          INVENTORY_EVENTS_EXCHANGE,
          'inventory.InventoryAllocated'
     );
     await channel!.bindQueue(
          WMS_OUTBOUND_QUEUE,
          INVENTORY_EVENTS_EXCHANGE,
          'inventory.InventoryReleased'
     );
     await channel!.bindQueue(WMS_SYNC_QUEUE, WMS_COMMANDS_EXCHANGE, 'wms.forceSync');

     // Bind DLQs
     await channel!.bindQueue('dlq.wms.outbound', 'dlx.inventory', 'dlq.wms.outbound');
     await channel!.bindQueue('dlq.wms.sync', 'dlx.inventory', 'dlq.wms.sync');

     logger.info('RabbitMQ channel created and configured');

     return channel!;
}

export async function publishEvent(
     exchange: string,
     routingKey: string,
     payload: Record<string, unknown>
): Promise<void> {
     const ch = await getChannel();
     const content = Buffer.from(JSON.stringify(payload));

     ch.publish(exchange, routingKey, content, {
          persistent: true,
          contentType: 'application/json',
          timestamp: Date.now(),
     });
}

export async function closeConnection(): Promise<void> {
     if (channel) {
          await channel!.close();
          channel = null;
     }
     if (connection) {
          await connection!.close();
          connection = null;
     }
     logger.info('RabbitMQ connection closed');
}

// Handle shutdown signals
process.on('SIGINT', async () => {
     await closeConnection();
});

process.on('SIGTERM', async () => {
     await closeConnection();
});

export type { ConsumeMessage };
