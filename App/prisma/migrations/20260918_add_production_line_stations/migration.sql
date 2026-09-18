-- Production line stations: Stock Manager issuance tracking, plus grinding /
-- finishing stage records with per-material remainders.

-- Station 1: issuance fields on aggregated plan ingredients
ALTER TABLE "plan_aggregated_ingredients" ADD COLUMN "issued_quantity" DECIMAL(15,4);
ALTER TABLE "plan_aggregated_ingredients" ADD COLUMN "issued_warehouse_id" TEXT;
ALTER TABLE "plan_aggregated_ingredients" ADD COLUMN "issued_batch_lot_id" TEXT;
ALTER TABLE "plan_aggregated_ingredients" ADD COLUMN "issued_at" TIMESTAMP(3);
ALTER TABLE "plan_aggregated_ingredients" ADD COLUMN "issued_by_id" TEXT;
ALTER TABLE "plan_aggregated_ingredients" ADD COLUMN "returned_quantity" DECIMAL(15,4) NOT NULL DEFAULT 0;

-- Stations 2 & 3: enums
CREATE TYPE "ProductionStage" AS ENUM ('GRINDING', 'FINISHING');
CREATE TYPE "ProductionStageStatus" AS ENUM ('SUBMITTED', 'VERIFIED', 'FLAGGED');

-- Stations 2 & 3: stage records
CREATE TABLE "production_stage_records" (
  "id" TEXT NOT NULL,
  "production_plan_id" TEXT NOT NULL,
  "plan_item_id" TEXT NOT NULL,
  "stage" "ProductionStage" NOT NULL,
  "input_quantity" DECIMAL(15,4) NOT NULL,
  "achieved_quantity" DECIMAL(15,4) NOT NULL,
  "remainder_quantity" DECIMAL(15,4) NOT NULL DEFAULT 0,
  "unit_of_measure" TEXT NOT NULL,
  "batch_number" TEXT,
  "machine_id" TEXT,
  "warehouse_id" TEXT,
  "finished_batch_lot_id" TEXT,
  "returned_transaction_id" TEXT,
  "production_date" TIMESTAMP(3) NOT NULL,
  "status" "ProductionStageStatus" NOT NULL DEFAULT 'SUBMITTED',
  "remarks" TEXT,
  "recorded_by_id" TEXT NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "production_stage_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "production_stage_records_production_plan_id_fkey" FOREIGN KEY ("production_plan_id") REFERENCES "production_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "production_stage_records_plan_item_id_fkey" FOREIGN KEY ("plan_item_id") REFERENCES "production_plan_items"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "production_stage_records_production_plan_id_stage_idx" ON "production_stage_records"("production_plan_id", "stage");
CREATE INDEX "production_stage_records_plan_item_id_stage_idx" ON "production_stage_records"("plan_item_id", "stage");
CREATE INDEX "production_stage_records_production_date_idx" ON "production_stage_records"("production_date");

-- Stations 2 & 3: per-material remainders
CREATE TABLE "production_stage_remainders" (
  "id" TEXT NOT NULL,
  "stage_record_id" TEXT NOT NULL,
  "material_id" TEXT NOT NULL,
  "quantity" DECIMAL(15,4) NOT NULL,
  "unit_of_measure" TEXT NOT NULL,
  "warehouse_id" TEXT,
  "batch_lot_id" TEXT,
  "inventory_transaction_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "production_stage_remainders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "production_stage_remainders_stage_record_id_fkey" FOREIGN KEY ("stage_record_id") REFERENCES "production_stage_records"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "production_stage_remainders_stage_record_id_idx" ON "production_stage_remainders"("stage_record_id");
CREATE INDEX "production_stage_remainders_material_id_idx" ON "production_stage_remainders"("material_id");
