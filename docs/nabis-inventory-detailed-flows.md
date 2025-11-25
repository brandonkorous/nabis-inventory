# Nabis Inventory Service - Detailed Flow Diagrams

Node.js + PostgreSQL + RabbitMQ

This document supplements the high-level architecture with **detailed interaction flows** between the microservices, PostgreSQL, RabbitMQ, and the WMS.

The goal is to make it extremely clear how each part behaves at runtime, especially around:

- Oversell prevention
- Outbox → RabbitMQ dispatch
- WMS outbound integration
- Periodic and forced WMS sync

All flows assume the microservice boundaries from the v5 architecture document:

- `inventory-api`
- `admin-api`
- `event-dispatcher`
- `wms-outbound-worker`
- `wms-sync-worker`
- Shared `PostgreSQL` and `RabbitMQ`

---

## 1. Order Reservation Flow (Happy Path + Oversell Prevention)

This is the hot path: validating and reserving inventory for an order **without overselling**.

```mermaid
sequenceDiagram
  title Order Reservation - Happy Path

  participant Client as Order Service
  participant InvAPI as inventory-api
(Inventory API Service)
  participant DB as PostgreSQL
  participant Dispatcher as event-dispatcher
(Event Dispatcher Service)
  participant RMQ as RabbitMQ inventory.events
  participant QOutbound as Queue wms.outbound
  participant WmsOutbound as wms-outbound-worker
(WMS Outbound Service)

  Client->>InvAPI: POST /inventory/reserve
{ orderId, lines[] }
  note right of InvAPI: Start DB transaction
  InvAPI->>DB: BEGIN

  InvAPI->>DB: SELECT sku_batch
WHERE id IN (lines.skuBatchId)
FOR UPDATE
  DB-->>InvAPI: rows with available_quantity

  InvAPI->>InvAPI: Validate each line:
requested <= available_quantity

  alt Sufficient inventory for all lines
    InvAPI->>DB: UPDATE sku_batch
SET available_quantity = available_quantity - qty
    InvAPI->>DB: INSERT inventory_ledger
(type=ORDER_ALLOCATE, delta=-qty)
    InvAPI->>DB: INSERT order_reservation
(status=PENDING)
    InvAPI->>DB: INSERT domain_event
(type=InventoryAllocated,
 status=PENDING)
    InvAPI->>DB: COMMIT
    note right of InvAPI: Transaction commits
state is durable
    InvAPI-->>Client: 201 Created
{ status: "ok" }

    note over Dispatcher,DB: Separate service loop
    Dispatcher->>DB: SELECT domain_event
WHERE status='PENDING'
FOR UPDATE SKIP LOCKED
    DB-->>Dispatcher: InventoryAllocated events
    Dispatcher->>RMQ: publish InventoryAllocated
→ exchange inventory.events
    RMQ-->>QOutbound: route message
→ queue wms.outbound
    Dispatcher->>DB: UPDATE domain_event
SET status='SENT'
    QOutbound-->>WmsOutbound: Deliver InventoryAllocated message
    note right of WmsOutbound: WMS call happens here,
not on the hot path
  else Insufficient inventory for at least one line
    InvAPI->>DB: ROLLBACK
    InvAPI-->>Client: 409 Conflict
"insufficient inventory"
  end
```

**Key points:**

- Oversell is prevented by `SELECT ... FOR UPDATE` + `available_quantity` checks inside a single transaction.
- WMS is **never** called in the hot path; it’s fully asynchronous via RabbitMQ.

---

## 2. Concurrency: Two Competing Orders Against the Same Batch

This shows how Postgres row locks serialize competing updates.

```mermaid
sequenceDiagram
  title Concurrency - Two Competing Orders

  participant ClientA as Order Service A
  participant ClientB as Order Service B
  participant InvAPI as inventory-api
  participant DB as PostgreSQL

  ClientA->>InvAPI: POST /inventory/reserve
(order A, qty=10)
  note right of InvAPI: Tx A starts
  InvAPI->>DB: BEGIN (Tx A)
  InvAPI->>DB: SELECT sku_batch
FOR UPDATE (batch 123)
  DB-->>InvAPI: available_quantity=10

  ClientB->>InvAPI: POST /inventory/reserve
(order B, qty=10)
  note right of InvAPI: Tx B starts
  InvAPI->>DB: BEGIN (Tx B)
  InvAPI->>DB: SELECT sku_batch
FOR UPDATE (batch 123)
  note right of DB: Tx B blocked
waiting on row lock from Tx A

  InvAPI->>DB: UPDATE sku_batch
SET available_quantity = 0
WHERE id=123
  InvAPI->>DB: INSERT ledger, reservation,
InventoryAllocated event (A)
  InvAPI->>DB: COMMIT (Tx A)
  InvAPI-->>ClientA: 201 Created

  note right of DB: Row lock on batch 123
released for Tx B
  DB-->>InvAPI: SELECT result for Tx B
available_quantity=0

  InvAPI->>InvAPI: Check requested 10
> available 0 → insufficient
  InvAPI->>DB: ROLLBACK (Tx B)
  InvAPI-->>ClientB: 409 Conflict
"insufficient inventory"
```

One order wins, one loses. No oversell, no race condition.

---

## 3. Domain Event Dispatch Flow (Outbox → RabbitMQ)

This flow demonstrates the **outbox pattern**: events written in the same transaction as state, then delivered asynchronously.

```mermaid
sequenceDiagram
  title Domain Event Dispatch - Outbox to RabbitMQ

  participant Dispatcher as event-dispatcher
(Service)
  participant DB as PostgreSQL
  participant RMQ as RabbitMQ inventory.events
  participant QOutbound as Queue wms.outbound
  participant Analytics as Analytics/BI

  loop Every 100-500ms
    Dispatcher->>DB: BEGIN
    Dispatcher->>DB: SELECT * FROM domain_event
WHERE status='PENDING'
ORDER BY created_at
LIMIT 100
FOR UPDATE SKIP LOCKED
    DB-->>Dispatcher: [events]

    alt Events found
      loop For each event
        Dispatcher->>RMQ: publish event.payload
→ exchange inventory.events
routingKey: inventory.<type>
        RMQ-->>QOutbound: route relevant events
→ queue wms.outbound
        RMQ-->>Analytics: fan-out to analytics
        Dispatcher->>DB: UPDATE domain_event
SET status='SENT'
      end
      Dispatcher->>DB: COMMIT
    else No pending events
      Dispatcher->>DB: COMMIT
      note right of Dispatcher: sleep for a short interval
    end
  end
```

This service can be scaled horizontally thanks to `FOR UPDATE SKIP LOCKED`.

---

## 4. WMS Outbound Flow (From InventoryAllocated → WMS API)

This flow shows how we respect the WMS boundary and keep retry/backoff logic out of the hot path.

```mermaid
sequenceDiagram
  title WMS Outbound - Event-Driven Allocation

  participant QOutbound as Queue wms.outbound
  participant WmsOutbound as wms-outbound-worker
  participant WMS as WMS API
  participant DB as PostgreSQL

  loop Consume messages
    QOutbound-->>WmsOutbound: InventoryAllocated
{ orderId, skuBatchId, quantity }

    WmsOutbound->>DB: Optional: lookup sku_batch / order
for context / mapping
    DB-->>WmsOutbound: batch + metadata

    WmsOutbound->>WMS: POST /allocate
{ externalSku, quantity, orderRef }

    alt Success (200)
      WMS-->>WmsOutbound: 200 OK
      WmsOutbound->>DB: Optional: log WMS call
(e.g., ledger entry, audit)
      WmsOutbound-->>QOutbound: ACK message
    else Rate limited (429)
      WMS-->>WmsOutbound: 429 Too Many Requests
      note right of WmsOutbound: Apply retry/backoff policy
or requeue with delay / DLQ
      WmsOutbound-->>QOutbound: NACK / requeue or DLQ
    else Other failure (4xx/5xx)
      WMS-->>WmsOutbound: Error
      note right of WmsOutbound: Increment attempt count,
optionally send to DLQ
or mark as FAILED
      WmsOutbound-->>QOutbound: NACK + DLQ or
mark failed in DB
    end
  end
```

The important bit: **even if WMS is down or flaky, orders are still being safely reserved in Postgres**.

---

## 5. Periodic WMS Sync Flow (Time-Based Reconciliation)

This flow represents a **scheduled sync** (e.g., every 5-15 minutes) independent of force-sync commands.

```mermaid
sequenceDiagram
  title Periodic WMS Sync - Scheduled Reconciliation

  participant Scheduler as Cron / Timer
  participant WmsSync as wms-sync-worker
  participant WMS as WMS API
  participant DB as PostgreSQL

  loop Every N minutes
    Scheduler->>WmsSync: triggerPeriodicSync()

    WmsSync->>DB: SELECT last_full_sync_at,
last_incremental_token
FROM wms_sync_state
    DB-->>WmsSync: sync state

    alt First-time or full sync
      WmsSync->>WMS: GET /inventory/full
    else Incremental sync
      WmsSync->>WMS: GET /inventory/changes
?sinceToken=...
    end

    WMS-->>WmsSync: [ { wmsSkuBatchId, orderable, unallocatable, ... }, ... ]

    loop For each snapshot item
      WmsSync->>DB: INSERT/UPDATE wms_inventory_snapshot
(wmsSkuBatchId, sku_batch_id, orderable,...)

      WmsSync->>DB: SELECT sku_batch
WHERE id = snapshot.sku_batch_id
FOR UPDATE
      DB-->>WmsSync: current total / available / unallocatable

      WmsSync->>WmsSync: Compute delta between
WMS view and local view

      alt Significant delta detected
        WmsSync->>DB: INSERT inventory_ledger
(type=ADJUSTMENT, delta=Δ)
        WmsSync->>DB: UPDATE sku_batch
SET available_quantity = newValue
      else No meaningful delta
        note right of WmsSync: No adjustment
necessary
      end
    end

    WmsSync->>DB: UPDATE wms_sync_state
SET last_full_sync_at, last_incremental_token
  end
```

This keeps Nabis’ inventory view reconciled with the WMS without putting WMS on the order hot path.

---

## 6. Forced WMS Sync Flow (Ops Triggered via Admin API)

This is the “we just fixed it in WMS, push the button now” path.

```mermaid
sequenceDiagram
  title Forced WMS Sync - Admin / Control Plane

  participant AdminClient as Admin Client
(UI/CLI/service)
  participant AdminAPI as admin-api
(Admin Service)
  participant DB as PostgreSQL
  participant RMQ as RabbitMQ wms.commands
  participant QSync as Queue wms.sync
  participant WmsSync as wms-sync-worker
  participant WMS as WMS API

  AdminClient->>AdminAPI: POST /admin/wms/sync
{ skuBatchId?, reason }
  AdminAPI->>DB: INSERT wms_sync_request
(PENDING, priority=1, skuBatchId)
  DB-->>AdminAPI: { id: syncRequestId }

  AdminAPI->>RMQ: publish ForceWmsSync
→ exchange wms.commands
payload { syncRequestId, skuBatchId }
  RMQ-->>QSync: route to queue wms.sync
  AdminAPI-->>AdminClient: 202 Accepted
{ requestId, status: "queued" }

  QSync-->>WmsSync: ForceWmsSync message
  WmsSync->>DB: UPDATE wms_sync_request
SET status='IN_PROGRESS'

  WmsSync->>WMS: GET /inventory
?skuBatchId=... (if provided)
(or broader scope)
  WMS-->>WmsSync: inventory snapshot(s)

  loop For each snapshot item
    WmsSync->>DB: INSERT/UPDATE wms_inventory_snapshot
    WmsSync->>DB: SELECT sku_batch
FOR UPDATE
    DB-->>WmsSync: current batch state
    WmsSync->>WmsSync: Compute delta
    alt Delta != 0
      WmsSync->>DB: INSERT inventory_ledger
(type=ADJUSTMENT, delta=Δ)
      WmsSync->>DB: UPDATE sku_batch
SET available_quantity = newValue
    else No delta
      note right of WmsSync: no-op
    end
  end

  WmsSync->>DB: UPDATE wms_sync_request
SET status='DONE'
```

Ops gets an immediate reconciliation without touching the order path or directly calling WMS themselves.

---

## 7. Inventory Read Flow (Query Current Availability)

For completeness: how a caller asks “how much do we have right now?”

```mermaid
sequenceDiagram
  title Inventory Read - Query Available Quantity

  participant Client as Caller Service
  participant InvAPI as inventory-api
  participant DB as PostgreSQL

  Client->>InvAPI: GET /inventory/:sku
  InvAPI->>DB: SELECT s.sku_code,
       b.id as batch_id,
       b.available_quantity,
       b.unallocatable_quantity,
       b.expires_at
FROM sku s
JOIN sku_batch b ON b.sku_id = s.id
WHERE s.sku_code = :sku
  DB-->>InvAPI: rows for all batches

  InvAPI->>InvAPI: Aggregate / sort
by expiration or policy

  InvAPI-->>Client: 200 OK
{ sku, batches: [...],
  totalAvailable: sum(b.available_quantity) }
```

Reads are simple and fast: single query against `sku`/`sku_batch` (no WMS calls, no RabbitMQ).

---

## 8. How to Use These in the Interview

These diagrams let you:

- Start with the **high-level architecture** (v5 doc: microservices + infra).
- Then zoom into:
     - Order reservation & oversell prevention (Sections 1-2).
     - Event-driven integration via outbox + RabbitMQ (Section 3).
     - WMS-specific concerns (Sections 4-6).
     - Simple read path (Section 7).

You can literally pick a diagram, point to each lifeline, and say “this is a separate service” and “here’s where we guarantee correctness versus where we deal with eventual consistency and external flakiness.”
