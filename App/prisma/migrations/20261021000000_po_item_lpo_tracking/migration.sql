-- Per-line LPO tracking + temporary holds.
-- One purchase order can be sent to suppliers in several LPO rounds; a line
-- that has already travelled on an LPO is never offered again.

ALTER TABLE "purchase_order_items"
  ADD COLUMN IF NOT EXISTS "on_hold" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "hold_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "lpo_number" TEXT,
  ADD COLUMN IF NOT EXISTS "lpo_sent_at" TIMESTAMP(3);

ALTER TABLE "purchase_orders"
  ADD COLUMN IF NOT EXISTS "lpo_sequence" INTEGER NOT NULL DEFAULT 0;
