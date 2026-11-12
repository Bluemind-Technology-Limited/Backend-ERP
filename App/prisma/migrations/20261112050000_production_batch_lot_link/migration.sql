-- QA-approved production batch identity.
-- A plan item (one batch formula/batch) points at the BatchLot that QA approves;
-- every grinding and production stage record points at that same lot.

ALTER TABLE "production_plan_items"
  ADD COLUMN IF NOT EXISTS "batch_lot_id" TEXT,
  ADD COLUMN IF NOT EXISTS "batch_approved_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "batch_approved_by_id" TEXT;

ALTER TABLE "production_stage_records"
  ADD COLUMN IF NOT EXISTS "batch_lot_id" TEXT;

CREATE INDEX IF NOT EXISTS "production_plan_items_batch_lot_id_idx"
  ON "production_plan_items"("batch_lot_id");
CREATE INDEX IF NOT EXISTS "production_stage_records_batch_lot_id_idx"
  ON "production_stage_records"("batch_lot_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'production_plan_items_batch_lot_id_fkey'
  ) THEN
    ALTER TABLE "production_plan_items"
      ADD CONSTRAINT "production_plan_items_batch_lot_id_fkey"
      FOREIGN KEY ("batch_lot_id") REFERENCES "batch_lots"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'production_plan_items_batch_approved_by_id_fkey'
  ) THEN
    ALTER TABLE "production_plan_items"
      ADD CONSTRAINT "production_plan_items_batch_approved_by_id_fkey"
      FOREIGN KEY ("batch_approved_by_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'production_stage_records_batch_lot_id_fkey'
  ) THEN
    ALTER TABLE "production_stage_records"
      ADD CONSTRAINT "production_stage_records_batch_lot_id_fkey"
      FOREIGN KEY ("batch_lot_id") REFERENCES "batch_lots"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
