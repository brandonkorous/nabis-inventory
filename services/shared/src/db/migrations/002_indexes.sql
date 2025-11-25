-- Performance indexes for inventory operations

-- Lookup SKUs by code (frequent)
CREATE INDEX IF NOT EXISTS idx_sku_sku_code ON sku(sku_code);

-- Lookup batches by SKU (frequent)
CREATE INDEX IF NOT EXISTS idx_sku_batch_sku_id ON sku_batch(sku_id);

-- Lookup available batches with quantity (hot path)
CREATE INDEX IF NOT EXISTS idx_sku_batch_available_qty ON sku_batch(available_quantity) WHERE available_quantity > 0;

-- External batch ID lookups for WMS sync
CREATE INDEX IF NOT EXISTS idx_sku_batch_external_id ON sku_batch(external_batch_id) WHERE external_batch_id IS NOT NULL;

-- Ledger queries by batch (audit trail)
CREATE INDEX IF NOT EXISTS idx_inventory_ledger_batch_created ON inventory_ledger(sku_batch_id, created_at DESC);

-- Ledger queries by reference (order lookups)
CREATE INDEX IF NOT EXISTS idx_inventory_ledger_reference ON inventory_ledger(reference_id) WHERE reference_id IS NOT NULL;

-- Order reservation lookups
CREATE INDEX IF NOT EXISTS idx_order_reservation_order_id ON order_reservation(order_id);
CREATE INDEX IF NOT EXISTS idx_order_reservation_batch_id ON order_reservation(sku_batch_id);
CREATE INDEX IF NOT EXISTS idx_order_reservation_status ON order_reservation(status) WHERE status = 'PENDING';

-- Domain event processing (outbox pattern - critical for performance)
CREATE INDEX IF NOT EXISTS idx_domain_event_pending ON domain_event(created_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_domain_event_status_created ON domain_event(status, created_at);

-- WMS snapshot lookups
CREATE INDEX IF NOT EXISTS idx_wms_snapshot_wms_batch_id ON wms_inventory_snapshot(wms_sku_batch_id);
CREATE INDEX IF NOT EXISTS idx_wms_snapshot_sku_batch_id ON wms_inventory_snapshot(sku_batch_id);
CREATE INDEX IF NOT EXISTS idx_wms_snapshot_reported_at ON wms_inventory_snapshot(reported_at DESC);

-- WMS sync request processing
CREATE INDEX IF NOT EXISTS idx_wms_sync_request_status_priority ON wms_sync_request(status, priority DESC, created_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_wms_sync_request_batch_id ON wms_sync_request(sku_batch_id) WHERE sku_batch_id IS NOT NULL;
