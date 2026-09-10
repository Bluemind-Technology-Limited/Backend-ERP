-- AlterTable: Add missing columns to machines table
ALTER TABLE "machines" ADD COLUMN "serial_number" TEXT NOT NULL DEFAULT '',
ADD COLUMN "category" TEXT NOT NULL DEFAULT '',
ADD COLUMN "department" TEXT NOT NULL DEFAULT '',
ADD COLUMN "location" TEXT,
ADD COLUMN "model_number" TEXT,
ADD COLUMN "manufacturer_name" TEXT,
ADD COLUMN "description" TEXT,
ADD COLUMN "purchase_date" TIMESTAMP(3),
ADD COLUMN "installation_date" TIMESTAMP(3),
ADD COLUMN "warranty_expiry_date" TIMESTAMP(3),
ADD COLUMN "estimated_output_per_hour" BIGINT,
ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Add unique constraint on serial_number
ALTER TABLE "machines" ADD CONSTRAINT "machines_serial_number_key" UNIQUE ("serial_number");

-- CreateTable: Commissionings
CREATE TABLE "commissionings" (
    "id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "commissioning_date" TIMESTAMP(3) NOT NULL,
    "technician_id" TEXT NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commissionings_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Performances
CREATE TABLE "performances" (
    "id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "record_date" TIMESTAMP(3) NOT NULL,
    "target_output" BIGINT NOT NULL,
    "actual_output" BIGINT NOT NULL,
    "efficiency_percentage" DECIMAL(5,2) NOT NULL,
    "downtime" INTEGER NOT NULL DEFAULT 0,
    "recorded_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "performances_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Breakdowns
CREATE TABLE "breakdowns" (
    "id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "reported_at" TIMESTAMP(3) NOT NULL,
    "reported_by_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REPORTED',
    "downtime_duration" INTEGER,
    "resolution_notes" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolved_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "breakdowns_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Maintenances
CREATE TABLE "maintenances" (
    "id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "scheduled_date" TIMESTAMP(3) NOT NULL,
    "maintenance_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "assigned_to_id" TEXT,
    "estimated_duration" INTEGER,
    "actual_duration" INTEGER,
    "estimated_cost" DECIMAL(10,2),
    "actual_cost" DECIMAL(10,2),
    "notes" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "maintenances_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Spare Parts
CREATE TABLE "spare_parts" (
    "id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "part_name" TEXT NOT NULL,
    "part_number" TEXT NOT NULL,
    "supplier" TEXT,
    "current_stock" INTEGER NOT NULL DEFAULT 0,
    "min_stock_level" INTEGER,
    "reorder_quantity" INTEGER,
    "unit_cost" DECIMAL(10,2),
    "last_restocked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spare_parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Staff Assignments
CREATE TABLE "staff_assignments" (
    "id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "assignment_date" TIMESTAMP(3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "unassigned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "commissionings_machine_id_idx" ON "commissionings"("machine_id");

-- CreateIndex
CREATE INDEX "commissionings_technician_id_idx" ON "commissionings"("technician_id");

-- CreateIndex
CREATE INDEX "performances_machine_id_idx" ON "performances"("machine_id");

-- CreateIndex
CREATE INDEX "performances_recorded_by_id_idx" ON "performances"("recorded_by_id");

-- CreateIndex
CREATE INDEX "breakdowns_machine_id_idx" ON "breakdowns"("machine_id");

-- CreateIndex
CREATE INDEX "breakdowns_reported_by_id_idx" ON "breakdowns"("reported_by_id");

-- CreateIndex
CREATE INDEX "breakdowns_resolved_by_id_idx" ON "breakdowns"("resolved_by_id");

-- CreateIndex
CREATE INDEX "maintenances_machine_id_idx" ON "maintenances"("machine_id");

-- CreateIndex
CREATE INDEX "maintenances_assigned_to_id_idx" ON "maintenances"("assigned_to_id");

-- CreateIndex
CREATE INDEX "spare_parts_machine_id_idx" ON "spare_parts"("machine_id");

-- CreateIndex
CREATE INDEX "staff_assignments_machine_id_idx" ON "staff_assignments"("machine_id");

-- CreateIndex
CREATE INDEX "staff_assignments_user_id_idx" ON "staff_assignments"("user_id");

-- AddForeignKey
ALTER TABLE "commissionings" ADD CONSTRAINT "commissionings_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commissionings" ADD CONSTRAINT "commissionings_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performances" ADD CONSTRAINT "performances_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performances" ADD CONSTRAINT "performances_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breakdowns" ADD CONSTRAINT "breakdowns_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breakdowns" ADD CONSTRAINT "breakdowns_reported_by_id_fkey" FOREIGN KEY ("reported_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breakdowns" ADD CONSTRAINT "breakdowns_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenances" ADD CONSTRAINT "maintenances_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenances" ADD CONSTRAINT "maintenances_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spare_parts" ADD CONSTRAINT "spare_parts_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
