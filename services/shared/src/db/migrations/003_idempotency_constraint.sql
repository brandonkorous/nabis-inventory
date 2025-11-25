-- Add unique constraint to ensure idempotency for order reservations
-- This prevents duplicate reservations for the same order + batch combination
-- and supports the idempotency logic in reserveInventoryForOrder

DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'order_reservation_unique_order_batch'
    ) THEN
        ALTER TABLE order_reservation
        ADD CONSTRAINT order_reservation_unique_order_batch
        UNIQUE (order_id, sku_batch_id);
    END IF;
END $$;
