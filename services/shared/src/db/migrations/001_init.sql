-- Core inventory tables
CREATE TABLE IF NOT EXISTS sku (
  id          BIGSERIAL PRIMARY KEY,
  sku_code    TEXT NOT NULL UNIQUE,
  name        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sku_batch (
  id                      BIGSERIAL PRIMARY KEY,
  sku_id                  BIGINT NOT NULL REFERENCES sku(id) ON DELETE CASCADE,
  external_batch_id       TEXT,
  lot_number              TEXT,
  expires_at              TIMESTAMPTZ,
  total_quantity          INTEGER NOT NULL DEFAULT 0,
  unallocatable_quantity  INTEGER NOT NULL DEFAULT 0,
  available_quantity      INTEGER NOT NULL DEFAULT 0,
  version                 INTEGER NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT available_lte_total CHECK (available_quantity <= total_quantity),
  CONSTRAINT quantities_non_negative CHECK (
    total_quantity >= 0 AND 
    unallocatable_quantity >= 0 AND 
    available_quantity >= 0
  )
);

-- Append-only ledger of all inventory movements
CREATE TABLE IF NOT EXISTS inventory_ledger (
  id             BIGSERIAL PRIMARY KEY,
  sku_batch_id   BIGINT NOT NULL REFERENCES sku_batch(id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN ('RECEIPT', 'ORDER_ALLOCATE', 'ORDER_RELEASE', 'ADJUSTMENT')),
  quantity_delta INTEGER NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('NABIS_ORDER', 'WMS_SYNC', 'MANUAL_ADJUSTMENT', 'WMS_OUTBOUND')),
  reference_id   TEXT,
  metadata       JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Order reservations tracking
CREATE TABLE IF NOT EXISTS order_reservation (
  id             BIGSERIAL PRIMARY KEY,
  order_id       TEXT NOT NULL,
  sku_batch_id   BIGINT NOT NULL REFERENCES sku_batch(id) ON DELETE CASCADE,
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  status         TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ
);

-- WMS inventory snapshots
CREATE TABLE IF NOT EXISTS wms_inventory_snapshot (
  id                          BIGSERIAL PRIMARY KEY,
  wms_sku_batch_id            TEXT NOT NULL,
  sku_batch_id                BIGINT REFERENCES sku_batch(id) ON DELETE SET NULL,
  reported_orderable_quantity INTEGER NOT NULL,
  reported_unallocatable      INTEGER,
  reported_at                 TIMESTAMPTZ NOT NULL,
  raw_payload                 JSONB,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- WMS sync state tracking
CREATE TABLE IF NOT EXISTS wms_sync_state (
  id                    BIGSERIAL PRIMARY KEY,
  last_full_sync_at     TIMESTAMPTZ,
  last_incremental_token TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert initial sync state row
INSERT INTO wms_sync_state (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Outbox pattern for domain events
CREATE TABLE IF NOT EXISTS domain_event (
  id          BIGSERIAL PRIMARY KEY,
  type        TEXT NOT NULL,
  payload     JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retry_count INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);

-- WMS sync requests for force sync
CREATE TABLE IF NOT EXISTS wms_sync_request (
  id            BIGSERIAL PRIMARY KEY,
  requested_by  TEXT,
  reason        TEXT,
  sku_batch_id  BIGINT REFERENCES sku_batch(id) ON DELETE CASCADE,
  priority      INTEGER NOT NULL DEFAULT 10,
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'IN_PROGRESS', 'DONE', 'FAILED')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  error         TEXT
);
