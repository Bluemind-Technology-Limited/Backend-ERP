-- Three-station production flow: one work order per plan per station, plus a
-- persisted carry-over / WIP repository. Defensive (IF NOT EXISTS) because some
-- databases already carry an uncommitted station-work-order migration.

DO $$ BEGIN
  CREATE TYPE "ProductionStation" AS ENUM ('INGREDIENT', 'GRINDING', 'PRODUCTION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "StationWorkOrderStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "WorkInProgressStatus" AS ENUM ('OPEN', 'PARTIAL', 'TRANSFERRED', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "production_station_work_orders" (
  "id" TEXT NOT NULL,
  "production_plan_id" TEXT NOT NULL,
  "station" "ProductionStation" NOT NULL,
  "status" "StationWorkOrderStatus" NOT NULL DEFAULT 'PENDING',
  "expected_quantity" DECIMAL(15, 4) NOT NULL DEFAULT 0,
  "received_quantity" DECIMAL(15, 4) NOT NULL DEFAULT 0,
  "processed_quantity" DECIMAL(15, 4) NOT NULL DEFAULT 0,
  "transferred_quantity" DECIMAL(15, 4) NOT NULL DEFAULT 0,
  "outstanding_quantity" DECIMAL(15, 4) NOT NULL DEFAULT 0,
  "unit_of_measure" TEXT NOT NULL DEFAULT 'kg',
  "notified_at" TIMESTAMP(3),
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "production_station_work_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "production_station_work_orders_plan_station_key"
  ON "production_station_work_orders"("production_plan_id", "station");
CREATE INDEX IF NOT EXISTS "production_station_work_orders_station_status_idx"
  ON "production_station_work_orders"("station", "status");

CREATE TABLE IF NOT EXISTS "work_in_progress" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "production_plan_id" TEXT NOT NULL,
  "plan_item_id" TEXT,
  "station_work_order_id" TEXT,
  "production_date" TIMESTAMP(3) NOT NULL,
  "product_name" TEXT,
  "batch_number" TEXT,
  "batch_lot_id" TEXT,
  "material_id" TEXT,
  "origin_station" "ProductionStation" NOT NULL,
  "destination_station" "ProductionStation",
  "expected_quantity" DECIMAL(15, 4) NOT NULL DEFAULT 0,
  "completed_quantity" DECIMAL(15, 4) NOT NULL DEFAULT 0,
  "transferred_quantity" DECIMAL(15, 4) NOT NULL DEFAULT 0,
  "remaining_quantity" DECIMAL(15, 4) NOT NULL DEFAULT 0,
  "unit_of_measure" TEXT NOT NULL,
  "status" "WorkInProgressStatus" NOT NULL DEFAULT 'OPEN',
  "notes" TEXT,
  "closed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "work_in_progress_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "work_in_progress_key_key" ON "work_in_progress"("key");
CREATE INDEX IF NOT EXISTS "work_in_progress_production_plan_id_idx"
  ON "work_in_progress"("production_plan_id");
CREATE INDEX IF NOT EXISTS "work_in_progress_origin_status_idx"
  ON "work_in_progress"("origin_station", "status");
CREATE INDEX IF NOT EXISTS "work_in_progress_production_date_idx"
  ON "work_in_progress"("production_date");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'production_station_work_orders_production_plan_id_fkey'
  ) THEN
    ALTER TABLE "production_station_work_orders"
      ADD CONSTRAINT "production_station_work_orders_production_plan_id_fkey"
      FOREIGN KEY ("production_plan_id") REFERENCES "production_plans"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_in_progress_production_plan_id_fkey'
  ) THEN
    ALTER TABLE "work_in_progress"
      ADD CONSTRAINT "work_in_progress_production_plan_id_fkey"
      FOREIGN KEY ("production_plan_id") REFERENCES "production_plans"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_in_progress_station_work_order_id_fkey'
  ) THEN
    ALTER TABLE "work_in_progress"
      ADD CONSTRAINT "work_in_progress_station_work_order_id_fkey"
      FOREIGN KEY ("station_work_order_id") REFERENCES "production_station_work_orders"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
