-- Daily production tracking: cost snapshots + per-receipt ingredient issue lines.
--
-- 1) production_stage_records.unit_cost — output value is frozen at the moment a
--    stage is recorded instead of re-deriving it from master data later.
-- 2) plan_ingredient_issues — one row per issue line (material + receipt lot +
--    quantity + unit cost), so each station can show its own breakdown such as
--    "Turmeric 200 kg (20 kg × 10 receipts)".

ALTER TABLE "production_stage_records"
  ADD COLUMN IF NOT EXISTS "unit_cost" DECIMAL(15, 4) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "plan_ingredient_issues" (
  "id" TEXT NOT NULL,
  "production_plan_id" TEXT NOT NULL,
  "plan_item_id" TEXT,
  "aggregated_ingredient_id" TEXT NOT NULL,
  "material_id" TEXT NOT NULL,
  "batch_lot_id" TEXT,
  "quantity" DECIMAL(15, 4) NOT NULL,
  "unit_of_measure" TEXT NOT NULL,
  "unit_cost" DECIMAL(15, 4) NOT NULL DEFAULT 0,
  "warehouse_id" TEXT,
  "issued_by_id" TEXT NOT NULL,
  "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "plan_ingredient_issues_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "plan_ingredient_issues_production_plan_id_idx"
  ON "plan_ingredient_issues"("production_plan_id");
CREATE INDEX IF NOT EXISTS "plan_ingredient_issues_material_id_idx"
  ON "plan_ingredient_issues"("material_id");
CREATE INDEX IF NOT EXISTS "plan_ingredient_issues_issued_at_idx"
  ON "plan_ingredient_issues"("issued_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plan_ingredient_issues_production_plan_id_fkey'
  ) THEN
    ALTER TABLE "plan_ingredient_issues"
      ADD CONSTRAINT "plan_ingredient_issues_production_plan_id_fkey"
      FOREIGN KEY ("production_plan_id") REFERENCES "production_plans"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plan_ingredient_issues_material_id_fkey'
  ) THEN
    ALTER TABLE "plan_ingredient_issues"
      ADD CONSTRAINT "plan_ingredient_issues_material_id_fkey"
      FOREIGN KEY ("material_id") REFERENCES "materials"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
