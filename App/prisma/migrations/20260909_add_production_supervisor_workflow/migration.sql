-- Add PRODUCTION_SUPERVISOR to UserRole enum
ALTER TYPE "UserRole" ADD VALUE 'PRODUCTION_SUPERVISOR' AFTER 'PRODUCTION_MANAGER';

-- CreateTable BatchMachineAllocation
CREATE TABLE "batch_machine_allocations" (
    "id" TEXT NOT NULL,
    "production_plan_item_id" TEXT NOT NULL,
    "production_order_id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "scheduled_start_time" TIMESTAMP(3),
    "scheduled_end_time" TIMESTAMP(3),
    "actual_start_time" TIMESTAMP(3),
    "actual_end_time" TIMESTAMP(3),
    "batch_number" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ALLOCATED',
    "supervisor_id" TEXT NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "batch_machine_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable DailyProductionReconciliation
CREATE TABLE "daily_production_reconciliations" (
    "id" TEXT NOT NULL,
    "production_plan_id" TEXT NOT NULL,
    "reconciliation_date" TIMESTAMP(3) NOT NULL,
    "supervisor_id" TEXT NOT NULL,
    "planned_item_count" INTEGER NOT NULL,
    "planned_total_quantity" DECIMAL(15,4) NOT NULL,
    "actual_item_count" INTEGER NOT NULL,
    "actual_total_quantity" DECIMAL(15,4) NOT NULL,
    "quantity_variance" DECIMAL(15,4) NOT NULL,
    "variance_percentage" DECIMAL(5,2) NOT NULL,
    "discrepancy_notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_production_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "batch_machine_allocations_production_plan_item_id_machine_id_idx" ON "batch_machine_allocations"("production_plan_item_id", "machine_id");

-- CreateIndex
CREATE INDEX "batch_machine_allocations_supervisor_id_created_at_idx" ON "batch_machine_allocations"("supervisor_id", "created_at");

-- CreateIndex
CREATE INDEX "batch_machine_allocations_status_idx" ON "batch_machine_allocations"("status");

-- CreateIndex
CREATE INDEX "daily_production_reconciliations_production_plan_id_reconciliation_date_idx" ON "daily_production_reconciliations"("production_plan_id", "reconciliation_date");

-- CreateIndex
CREATE INDEX "daily_production_reconciliations_supervisor_id_created_at_idx" ON "daily_production_reconciliations"("supervisor_id", "created_at");

-- CreateIndex
CREATE INDEX "daily_production_reconciliations_status_idx" ON "daily_production_reconciliations"("status");

-- AddForeignKey
ALTER TABLE "batch_machine_allocations" ADD CONSTRAINT "batch_machine_allocations_production_plan_item_id_fkey" FOREIGN KEY ("production_plan_item_id") REFERENCES "production_plan_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_machine_allocations" ADD CONSTRAINT "batch_machine_allocations_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_machine_allocations" ADD CONSTRAINT "batch_machine_allocations_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_machine_allocations" ADD CONSTRAINT "batch_machine_allocations_supervisor_id_fkey" FOREIGN KEY ("supervisor_id") REFERENCES "users"("id") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_production_reconciliations" ADD CONSTRAINT "daily_production_reconciliations_production_plan_id_fkey" FOREIGN KEY ("production_plan_id") REFERENCES "production_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_production_reconciliations" ADD CONSTRAINT "daily_production_reconciliations_supervisor_id_fkey" FOREIGN KEY ("supervisor_id") REFERENCES "users"("id") ON UPDATE CASCADE;
