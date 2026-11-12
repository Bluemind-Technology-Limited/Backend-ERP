-- Formula-level ingredient requirement snapshot.
-- total_required = per_batch_required × batch_count, where batch_count is the
-- plan item's target quantity divided by the batch formula's expected yield.

CREATE TABLE IF NOT EXISTS "plan_ingredient_requirements" (
  "id" TEXT NOT NULL,
  "production_plan_id" TEXT NOT NULL,
  "plan_item_id" TEXT NOT NULL,
  "bom_id" TEXT NOT NULL,
  "material_id" TEXT NOT NULL,
  "quantity_per_batch" DECIMAL(15, 4) NOT NULL,
  "per_batch_required" DECIMAL(15, 4) NOT NULL,
  "batch_count" DECIMAL(15, 4) NOT NULL,
  "total_required" DECIMAL(15, 4) NOT NULL,
  "unit_of_measure" TEXT NOT NULL,
  "is_percentage" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "plan_ingredient_requirements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "plan_ingredient_requirements_plan_item_material_key"
  ON "plan_ingredient_requirements"("plan_item_id", "material_id");
CREATE INDEX IF NOT EXISTS "plan_ingredient_requirements_production_plan_id_idx"
  ON "plan_ingredient_requirements"("production_plan_id");
CREATE INDEX IF NOT EXISTS "plan_ingredient_requirements_material_id_idx"
  ON "plan_ingredient_requirements"("material_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plan_ingredient_requirements_production_plan_id_fkey'
  ) THEN
    ALTER TABLE "plan_ingredient_requirements"
      ADD CONSTRAINT "plan_ingredient_requirements_production_plan_id_fkey"
      FOREIGN KEY ("production_plan_id") REFERENCES "production_plans"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plan_ingredient_requirements_plan_item_id_fkey'
  ) THEN
    ALTER TABLE "plan_ingredient_requirements"
      ADD CONSTRAINT "plan_ingredient_requirements_plan_item_id_fkey"
      FOREIGN KEY ("plan_item_id") REFERENCES "production_plan_items"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plan_ingredient_requirements_material_id_fkey'
  ) THEN
    ALTER TABLE "plan_ingredient_requirements"
      ADD CONSTRAINT "plan_ingredient_requirements_material_id_fkey"
      FOREIGN KEY ("material_id") REFERENCES "materials"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
