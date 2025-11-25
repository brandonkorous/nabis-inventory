# Nabis Inventory Service Implementation Plan – Production-Grade (API-Only)

Node.js + PostgreSQL + RabbitMQ

This document is the implementation companion to the **production-grade, API-first architecture**. It shows how you can structure the code, data model, and workers to deliver:

- Strong consistency in **Postgres** (no oversell).
- Asynchronous integration via **RabbitMQ**.
- Operational controls exposed strictly as **APIs** (no UI implementation here).

Any UI (admin console, ops dashboard, etc.) is out-of-scope for this implementation and will simply call these APIs as a client.

---

## 1. Project Structure

Example monorepo layout:

```text
nabis-inventory/
  package.json
  tsconfig.json
  src/
    api/
      inventoryServer.ts      # Inventory API (orders, reads)
      adminServer.ts          # Admin / control API
      routes/
        inventory.ts
        admin.ts
    db/
      client.ts
      migrations/
        001_init.sql
    services/
      inventoryService.ts
      wmsSyncService.ts
      events.ts
    workers/
      eventDispatcherWorker.ts
      wmsOutboundWorker.ts
      wmsSyncWorker.ts
  tests/
    inventoryConcurrency.test.ts
    messagingFlow.test.ts
  docs/
    nabis-inventory-architecture-v3.md
```

Deployed processes/containers:

- `inventory-api`: runs `inventoryServer.ts`.
- `admin-api`: runs `adminServer.ts`.
- `event-dispatcher`: runs `eventDispatcherWorker.ts`.
- `wms-outbound-worker`: runs `wmsOutboundWorker.ts`.
- `wms-sync-worker`: runs `wmsSyncWorker.ts`.

No UI is built here—this is pure middleware.

---

## 2. Database Schema (Key Tables)

This matches the architecture document (v3).

### 2.1 Migration: Core Inventory + Integration

`src/db/migrations/001_init.sql` (simplified, key parts only):

```sql
CREATE TABLE sku (
  id          BIGSERIAL PRIMARY KEY,
  sku_code    TEXT NOT NULL UNIQUE,
  name        TEXT
);

CREATE TABLE sku_batch (
  id                      BIGSERIAL PRIMARY KEY,
  sku_id                  BIGINT NOT NULL REFERENCES sku(id),
  external_batch_id       TEXT,
  lot_number              TEXT,
  expires_at              TIMESTAMPTZ,
  total_quantity          INTEGER NOT NULL DEFAULT 0,
  unallocatable_quantity  INTEGER NOT NULL DEFAULT 0,
  available_quantity      INTEGER NOT NULL DEFAULT 0,
  version                 INTEGER NOT NULL DEFAULT 0,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE inventory_ledger (
  id             BIGSERIAL PRIMARY KEY,
  sku_batch_id   BIGINT NOT NULL REFERENCES sku_batch(id),
  type           TEXT NOT NULL,     -- RECEIPT, ORDER_ALLOCATE, ORDER_RELEASE, ADJUSTMENT
  quantity_delta INTEGER NOT NULL,
  source         TEXT NOT NULL,     -- NABIS_ORDER, WMS_SYNC, MANUAL_ADJUSTMENT
  reference_id   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_reservation (
  id             BIGSERIAL PRIMARY KEY,
  order_id       TEXT NOT NULL,
  sku_batch_id   BIGINT NOT NULL REFERENCES sku_batch(id),
  quantity       INTEGER NOT NULL,
  status         TEXT NOT NULL,      -- PENDING, CONFIRMED, CANCELLED, EXPIRED
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ
);

CREATE TABLE wms_inventory_snapshot (
  id                          BIGSERIAL PRIMARY KEY,
  wms_sku_batch_id            TEXT NOT NULL,
  sku_batch_id                BIGINT REFERENCES sku_batch(id),
  reported_orderable_quantity INTEGER NOT NULL,
  reported_unallocatable      INTEGER,
  reported_at                 TIMESTAMPTZ NOT NULL,
  raw_payload                 JSONB
);

CREATE TABLE wms_sync_state (
  id                    BIGSERIAL PRIMARY KEY,
  last_full_sync_at     TIMESTAMPTZ,
  last_incremental_token TEXT
);

CREATE TABLE domain_event (
  id          BIGSERIAL PRIMARY KEY,
  type        TEXT NOT NULL,        -- e.g., InventoryAllocated
  payload     JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, SENT, FAILED
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wms_sync_request (
  id            BIGSERIAL PRIMARY KEY,
  requested_by  TEXT,
  reason        TEXT,
  sku_batch_id  BIGINT,
  priority      INTEGER NOT NULL DEFAULT 10,
  status        TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, IN_PROGRESS, DONE, FAILED
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

You can optionally add a dedicated `wms_outbox` table if you want explicit WMS tracking, but `domain_event` is enough to demonstrate the pattern.

---

## 3. Shared Infrastructure

### 3.1 Postgres Client

`src/db/client.ts`:

```ts
import { Pool, PoolClient } from 'pg';

export const pool = new Pool({
     connectionString: process.env.DATABASE_URL,
});

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
     const client = await pool.connect();
     try {
          await client.query('BEGIN');
          const result = await fn(client);
          await client.query('COMMIT');
          return result;
     } catch (err) {
          await client.query('ROLLBACK');
          throw err;
     } finally {
          client.release();
     }
}
```

### 3.2 RabbitMQ Client

`src/services/events.ts`:

```ts
import amqplib, { Connection, Channel } from 'amqplib';

let connection: Connection | null = null;
let channel: Channel | null = null;

const INVENTORY_EXCHANGE = 'inventory.events';
const WMS_COMMAND_EXCHANGE = 'wms.commands';

export async function getChannel(): Promise<Channel> {
     if (channel) return channel;

     connection = await amqplib.connect(process.env.AMQP_URL || 'amqp://localhost');
     channel = await connection.createChannel();

     await channel.assertExchange(INVENTORY_EXCHANGE, 'topic', { durable: true });
     await channel.assertExchange(WMS_COMMAND_EXCHANGE, 'topic', { durable: true });

     return channel;
}

export const Exchanges = {
     INVENTORY_EXCHANGE,
     WMS_COMMAND_EXCHANGE,
};
```

Workers and APIs use `getChannel()` to publish/consume messages.

---

## 4. Inventory Service (Hot Path)

### 4.1 Core Allocation Logic

`src/services/inventoryService.ts`:

```ts
import { PoolClient } from 'pg';

export type OrderLine = {
     skuBatchId: number;
     quantity: number;
};

export async function reserveInventoryForOrder(
     client: PoolClient,
     opts: {
          orderId: string;
          lines: OrderLine[];
     }
) {
     const batchIds = [...new Set(opts.lines.map((l) => l.skuBatchId))].sort();

     const { rows: batches } = await client.query(
          `
      SELECT id, available_quantity
      FROM sku_batch
      WHERE id = ANY($1::bigint[])
      FOR UPDATE
    `,
          [batchIds]
     );

     const byId = new Map<number, { id: number; available_quantity: number }>();
     batches.forEach((b) => byId.set(b.id, b));

     // Validate
     for (const line of opts.lines) {
          const batch = byId.get(line.skuBatchId);
          if (!batch) {
               throw new Error(`SKU batch ${line.skuBatchId} not found`);
          }
          if (batch.available_quantity < line.quantity) {
               throw new Error(
                    `Insufficient inventory for batch ${line.skuBatchId}: requested ${line.quantity}, available ${batch.available_quantity}`
               );
          }
     }

     // Apply updates + ledger + reservation + outbox event
     for (const line of opts.lines) {
          const batch = byId.get(line.skuBatchId)!;
          const newAvailable = batch.available_quantity - line.quantity;

          await client.query(
               `
        UPDATE sku_batch
        SET available_quantity = $1,
            updated_at = now()
        WHERE id = $2
      `,
               [newAvailable, batch.id]
          );

          await client.query(
               `
        INSERT INTO inventory_ledger (sku_batch_id, type, quantity_delta, source, reference_id)
        VALUES ($1, 'ORDER_ALLOCATE', $2 * -1, 'NABIS_ORDER', $3)
      `,
               [line.skuBatchId, line.quantity, opts.orderId]
          );

          await client.query(
               `
        INSERT INTO order_reservation (order_id, sku_batch_id, quantity, status)
        VALUES ($1, $2, $3, 'PENDING')
      `,
               [opts.orderId, line.skuBatchId, line.quantity]
          );

          // Domain event for async processing (WMS, analytics, etc.)
          await client.query(
               `
        INSERT INTO domain_event (type, payload)
        VALUES ($1, $2::jsonb)
      `,
               [
                    'InventoryAllocated',
                    JSON.stringify({
                         orderId: opts.orderId,
                         skuBatchId: line.skuBatchId,
                         quantity: line.quantity,
                    }),
               ]
          );
     }
}
```

### 4.2 Inventory API Server

`src/api/routes/inventory.ts`:

```ts
import { FastifyInstance } from 'fastify';
import { withTransaction } from '../../db/client';
import { reserveInventoryForOrder } from '../../services/inventoryService';

export async function registerInventoryRoutes(app: FastifyInstance) {
     app.post('/inventory/reserve', async (request, reply) => {
          const body = request.body as {
               orderId: string;
               lines: { skuBatchId: number; quantity: number }[];
          };

          try {
               await withTransaction((client) =>
                    reserveInventoryForOrder(client, {
                         orderId: body.orderId,
                         lines: body.lines,
                    })
               );
               reply.code(201).send({ status: 'ok' });
          } catch (err: any) {
               if (
                    typeof err.message === 'string' &&
                    err.message.startsWith('Insufficient inventory')
               ) {
                    reply.code(409).send({ error: err.message });
               } else {
                    request.log.error(err);
                    reply.code(500).send({ error: 'internal_error' });
               }
          }
     });
}
```

`src/api/inventoryServer.ts`:

```ts
import Fastify from "fastify";
import { registerInventoryRoutes } from "./routes/inventory";

async function main() {
  const app = Fastify({ logger: true });
  await registerInventoryRoutes(app);

  const port = Number(process.env.PORT || 3000);
  await app.listen({ port, host: "0.0.0.0" });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
}
```

---

## 5. Admin / Control API (Force WMS Sync)

This API is designed for **other services, CLIs, or UIs** to call. The implementation here stays on the backend side.

### 5.1 Route to Request Sync

`src/api/routes/admin.ts`:

```ts
import { FastifyInstance } from 'fastify';
import { pool } from '../../db/client';
import { getChannel, Exchanges } from '../../services/events';

export async function registerAdminRoutes(app: FastifyInstance) {
     app.post('/admin/wms/sync', async (request, reply) => {
          const body = request.body as {
               skuBatchId?: number;
               reason?: string;
          };

          const requestedBy = 'system-or-user-id'; // from auth in real code

          const { rows } = await pool.query(
               `
        INSERT INTO wms_sync_request (requested_by, reason, sku_batch_id, priority)
        VALUES ($1, $2, $3, 1)
        RETURNING id
      `,
               [requestedBy, body.reason ?? null, body.skuBatchId ?? null]
          );

          const syncRequestId = rows[0].id;

          const channel = await getChannel();
          await channel.publish(
               Exchanges.WMS_COMMAND_EXCHANGE,
               'wms.forceSync',
               Buffer.from(
                    JSON.stringify({
                         type: 'ForceWmsSync',
                         syncRequestId,
                         skuBatchId: body.skuBatchId ?? null,
                    })
               ),
               { persistent: true }
          );

          reply.code(202).send({ requestId: syncRequestId, status: 'queued' });
     });
}
```

`src/api/adminServer.ts`:

```ts
import Fastify from "fastify";
import { registerAdminRoutes } from "./routes/admin";

async function main() {
  const app = Fastify({ logger: true });

  await registerAdminRoutes(app);

  const port = Number(process.env.ADMIN_PORT || 3100);
  await app.listen({ port, host: "0.0.0.0" });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
}
```

Any UI or automation tool just calls `POST /admin/wms/sync` when it wants a forced sync.

---

## 6. Event Dispatcher Worker (DB → RabbitMQ)

`src/workers/eventDispatcherWorker.ts`:

```ts
import { pool, withTransaction } from '../db/client';
import { getChannel, Exchanges } from '../services/events';

async function dispatchBatch() {
     const channel = await getChannel();

     await withTransaction(async (client) => {
          const { rows: events } = await client.query(
               `
        SELECT *
        FROM domain_event
        WHERE status = 'PENDING'
        ORDER BY created_at
        LIMIT 100
        FOR UPDATE SKIP LOCKED
      `
          );

          if (!events.length) return;

          for (const ev of events) {
               const routingKey = `inventory.${ev.type}`;

               channel.publish(
                    Exchanges.INVENTORY_EXCHANGE,
                    routingKey,
                    Buffer.from(JSON.stringify(ev.payload)),
                    { persistent: true }
               );

               await client.query(
                    `
          UPDATE domain_event
          SET status = 'SENT', updated_at = now()
          WHERE id = $1
        `,
                    [ev.id]
               );
          }
     });
}

async function runLoop() {
     // eslint-disable-next-line no-constant-condition
     while (true) {
          await dispatchBatch();
          await new Promise((r) => setTimeout(r, 200));
     }
}

runLoop().catch((err) => {
     console.error(err);
     process.exit(1);
});
```

---

## 7. WMS Outbound Worker (RabbitMQ → WMS)

`src/workers/wmsOutboundWorker.ts`:

```ts
import { getChannel, Exchanges } from '../services/events';
import { pool } from '../db/client';

async function start() {
     const channel = await getChannel();

     const queue = 'wms.outbound';
     await channel.assertQueue(queue, { durable: true });
     await channel.bindQueue(queue, Exchanges.INVENTORY_EXCHANGE, 'inventory.InventoryAllocated');

     channel.prefetch(10);

     channel.consume(queue, async (msg) => {
          if (!msg) return;

          try {
               const payload = JSON.parse(msg.content.toString()) as {
                    orderId: string;
                    skuBatchId: number;
                    quantity: number;
               };

               // Placeholder: call WMS allocate API here
               // await wmsClient.allocate(...)

               // Optional: track outbound call in DB
               await pool.query(
                    `
          INSERT INTO inventory_ledger (sku_batch_id, type, quantity_delta, source, reference_id)
          VALUES ($1, 'ADJUSTMENT', 0, 'WMS_OUTBOUND', $2)
        `,
                    [payload.skuBatchId, payload.orderId]
               );

               channel.ack(msg);
          } catch (err) {
               console.error('WMS outbound error', err);
               channel.nack(msg, false, false); // send to DLQ in real impl
          }
     });
}

start().catch((err) => {
     console.error(err);
     process.exit(1);
});
```

---

## 8. WMS Sync Worker (Force Sync + Periodic)

`src/workers/wmsSyncWorker.ts`:

```ts
import { getChannel, Exchanges } from '../services/events';
import { withTransaction } from '../db/client';

async function processForceSyncCommand(msg: any) {
     const { syncRequestId, skuBatchId } = msg as {
          syncRequestId: number;
          skuBatchId?: number | null;
     };

     await withTransaction(async (client) => {
          await client.query(
               `UPDATE wms_sync_request
       SET status = 'IN_PROGRESS', updated_at = now()
       WHERE id = $1`,
               [syncRequestId]
          );

          // Placeholder: call WMS for full or targeted inventory
          // const wmsData = await wmsClient.getInventory({ skuBatchId });

          const wmsData = [
               {
                    wmsSkuBatchId: 'ext-123',
                    skuBatchId: skuBatchId ?? 1,
                    orderable: 1000,
                    unallocatable: 0,
               },
          ];

          for (const item of wmsData) {
               await client.query(
                    `
          INSERT INTO wms_inventory_snapshot (
            wms_sku_batch_id, sku_batch_id,
            reported_orderable_quantity, reported_unallocatable, reported_at, raw_payload
          )
          VALUES ($1, $2, $3, $4, now(), $5)
          ON CONFLICT (wms_sku_batch_id) DO UPDATE
          SET reported_orderable_quantity = EXCLUDED.reported_orderable_quantity,
              reported_unallocatable = EXCLUDED.reported_unallocatable,
              reported_at = EXCLUDED.reported_at,
              raw_payload = EXCLUDED.raw_payload
        `,
                    [
                         item.wmsSkuBatchId,
                         item.skuBatchId,
                         item.orderable,
                         item.unallocatable ?? null,
                         JSON.stringify(item),
                    ]
               );

               // TODO: compute delta vs sku_batch and write ADJUSTMENT + update available_quantity
          }

          await client.query(
               `UPDATE wms_sync_request
       SET status = 'DONE', updated_at = now()
       WHERE id = $1`,
               [syncRequestId]
          );
     });
}

async function start() {
     const channel = await getChannel();

     const queue = 'wms.sync';
     await channel.assertQueue(queue, { durable: true });
     await channel.bindQueue(queue, Exchanges.WMS_COMMAND_EXCHANGE, 'wms.forceSync');

     channel.prefetch(5);

     channel.consume(queue, async (msg) => {
          if (!msg) return;
          try {
               const payload = JSON.parse(msg.content.toString());
               await processForceSyncCommand(payload);
               channel.ack(msg);
          } catch (err) {
               console.error('WMS sync error', err);
               channel.nack(msg, false, false);
          }
     });

     // You can also add a timer-based periodic sync here if desired.
}

start().catch((err) => {
     console.error(err);
     process.exit(1);
});
```

---

## 9. Concurrency Test (Oversell Prevention)

`tests/inventoryConcurrency.test.ts`:

```ts
import { pool, withTransaction } from '../src/db/client';
import { reserveInventoryForOrder } from '../src/services/inventoryService';

describe('concurrent reservations', () => {
     let skuBatchId: number;

     beforeAll(async () => {
          await withTransaction(async (client) => {
               const { rows: skuRows } = await client.query(
                    'INSERT INTO sku (sku_code, name) VALUES ($1, $2) RETURNING id',
                    ['TEST-SKU', 'Test SKU']
               );
               const skuId = skuRows[0].id;

               const { rows: batchRows } = await client.query(
                    `
          INSERT INTO sku_batch (sku_id, total_quantity, available_quantity)
          VALUES ($1, 10, 10)
          RETURNING id
        `,
                    [skuId]
               );
               skuBatchId = batchRows[0].id;
          });
     });

     afterAll(async () => {
          await pool.end();
     });

     it('only allows one of two competing orders to succeed', async () => {
          const order1 = withTransaction((client) =>
               reserveInventoryForOrder(client, {
                    orderId: 'order-1',
                    lines: [{ skuBatchId, quantity: 10 }],
               })
          );

          const order2 = withTransaction((client) =>
               reserveInventoryForOrder(client, {
                    orderId: 'order-2',
                    lines: [{ skuBatchId, quantity: 5 }],
               })
          );

          const [r1, r2] = await Promise.allSettled([order1, order2]);

          const successes = [r1, r2].filter((r) => r.status === 'fulfilled').length;
          const failures = [r1, r2].filter((r) => r.status === 'rejected').length;

          expect(successes).toBe(1);
          expect(failures).toBe(1);

          const { rows } = await pool.query(
               'SELECT available_quantity FROM sku_batch WHERE id = $1',
               [skuBatchId]
          );

          expect(rows[0].available_quantity === 0 || rows[0].available_quantity === 5).toBe(true);
     });
});
```

---

## 10. Interview Positioning

With this implementation plan, you can clearly say:

- “This is a **middleware-only**, API-first design. I expose clean HTTP APIs for both the order flow and admin/ops needs, and any UI is free to evolve on top of these APIs.”
- “The **Inventory API** is fast and only depends on Postgres. It uses row-level locking and transactions to prevent overselling.”
- “Side-effects (WMS updates, analytics) are pushed via an **outbox pattern** into RabbitMQ, and dedicated workers handle WMS integration, respecting rate limits and failures.”
- “Operations can trigger a **force sync** via an Admin API that enqueues commands for the WMS Sync Worker, without blocking on WMS from the HTTP call.”

That tells them you’re thinking in terms of **clear service boundaries**, **API contracts**, and **separation of concerns**—exactly what you want for a production middleware service.
