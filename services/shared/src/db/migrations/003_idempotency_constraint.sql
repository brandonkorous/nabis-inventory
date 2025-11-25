-- Add unique constraint to ensure idempotency for order reservations
-- This prevents duplicate reservations for the same order + batch combination
-- and supports the idempotency logic in reserveInventoryForOrder

ALTER TABLE order_reservation
ADD CONSTRAINT order_reservation_unique_order_batch
UNIQUE (order_id, sku_batch_id);
