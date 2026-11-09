-- QC Ingredient Batch Number + grinding batch serial.

-- QA-assigned code, separate from the lot code and the receiving batch number.
ALTER TABLE "batch_lots"
  ADD COLUMN IF NOT EXISTS "qc_batch_number" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "batch_lots_material_id_qc_batch_number_key"
  ON "batch_lots" ("material_id", "qc_batch_number");

-- Serial grinding batch number, assigned per grinding record.
ALTER TABLE "production_stage_records"
  ADD COLUMN IF NOT EXISTS "grinding_batch_number" INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS "production_stage_records_grinding_batch_number_key"
  ON "production_stage_records" ("grinding_batch_number");

-- Generic continuing serial counters (seeded by the operator).
CREATE TABLE IF NOT EXISTS "sequence_counters" (
  "key"        TEXT         NOT NULL,
  "value"      INTEGER      NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sequence_counters_pkey" PRIMARY KEY ("key")
);
