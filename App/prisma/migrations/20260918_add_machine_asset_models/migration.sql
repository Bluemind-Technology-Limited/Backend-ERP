-- Machine asset management models (spare parts, maintenance, commissioning,
-- performance, staff assignment) used by the machine service modules.

CREATE TYPE "MaintenanceType" AS ENUM ('PREVENTIVE', 'CORRECTIVE', 'PREDICTIVE', 'EMERGENCY');
CREATE TYPE "MaintenanceStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

CREATE TABLE "spare_parts" (
  "id" TEXT NOT NULL,
  "machine_id" TEXT NOT NULL,
  "part_name" TEXT NOT NULL,
  "part_number" TEXT NOT NULL,
  "description" TEXT,
  "supplier" TEXT,
  "stock_level" INTEGER NOT NULL DEFAULT 0,
  "min_stock_level" INTEGER NOT NULL DEFAULT 0,
  "cost_per_unit" DECIMAL(15,2) NOT NULL DEFAULT 0,
  "last_restock_date" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "spare_parts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "spare_parts_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "spare_parts_machine_id_idx" ON "spare_parts"("machine_id");

CREATE TABLE "maintenances" (
  "id" TEXT NOT NULL,
  "machine_id" TEXT NOT NULL,
  "type" "MaintenanceType" NOT NULL,
  "status" "MaintenanceStatus" NOT NULL DEFAULT 'SCHEDULED',
  "scheduled_date" TIMESTAMP(3) NOT NULL,
  "completed_date" TIMESTAMP(3),
  "description" TEXT,
  "technicians_assigned" TEXT,
  "estimated_duration" INTEGER,
  "actual_duration" INTEGER,
  "cost_estimate" DECIMAL(15,2),
  "actual_cost" DECIMAL(15,2),
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "maintenances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "maintenances_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "maintenances_machine_id_scheduled_date_idx" ON "maintenances"("machine_id", "scheduled_date");
CREATE INDEX "maintenances_status_idx" ON "maintenances"("status");

CREATE TABLE "commissionings" (
  "id" TEXT NOT NULL,
  "machine_id" TEXT NOT NULL,
  "commissioned_by_id" TEXT NOT NULL,
  "commissioning_date" TIMESTAMP(3) NOT NULL,
  "installation_status" TEXT NOT NULL,
  "test_results" TEXT,
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "commissionings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "commissionings_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "commissionings_commissioned_by_id_fkey" FOREIGN KEY ("commissioned_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "commissionings_machine_id_commissioning_date_idx" ON "commissionings"("machine_id", "commissioning_date");

CREATE TABLE "performances" (
  "id" TEXT NOT NULL,
  "machine_id" TEXT NOT NULL,
  "record_date" TIMESTAMP(3) NOT NULL,
  "target_output" DECIMAL(15,4) NOT NULL,
  "actual_output" DECIMAL(15,4) NOT NULL,
  "efficiency_percentage" DECIMAL(6,2) NOT NULL DEFAULT 0,
  "downtime" INTEGER NOT NULL DEFAULT 0,
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "performances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "performances_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "performances_machine_id_record_date_idx" ON "performances"("machine_id", "record_date");

CREATE TABLE "staff_assignments" (
  "id" TEXT NOT NULL,
  "machine_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "assigned_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unassigned_date" TIMESTAMP(3),
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "staff_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "staff_assignments_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "staff_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "staff_assignments_machine_id_is_active_idx" ON "staff_assignments"("machine_id", "is_active");
CREATE INDEX "staff_assignments_user_id_is_active_idx" ON "staff_assignments"("user_id", "is_active");
