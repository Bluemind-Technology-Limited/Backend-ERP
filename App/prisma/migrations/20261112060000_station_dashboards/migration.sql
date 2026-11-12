-- Station dashboards (#10): real receipts, batches processed, rejects, and an
-- explicit production outstanding closure.

ALTER TABLE "production_stage_records"
  ADD COLUMN IF NOT EXISTS "received_quantity" DECIMAL(15, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "batches_processed" DECIMAL(15, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "rejected_quantity" DECIMAL(15, 4) NOT NULL DEFAULT 0;

ALTER TABLE "production_plans"
  ADD COLUMN IF NOT EXISTS "outstanding_closed_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "outstanding_closed_by_id" TEXT,
  ADD COLUMN IF NOT EXISTS "outstanding_close_reason" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'production_plans_outstanding_closed_by_id_fkey'
  ) THEN
    ALTER TABLE "production_plans"
      ADD CONSTRAINT "production_plans_outstanding_closed_by_id_fkey"
      FOREIGN KEY ("outstanding_closed_by_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
