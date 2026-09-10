-- Drop the incorrectly created staff_assignments table
DROP TABLE IF EXISTS "staff_assignments" CASCADE;

-- Recreate staff_assignments with correct columns per schema
CREATE TABLE "staff_assignments" (
    "id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "assigned_date" TIMESTAMP(3) NOT NULL,
    "unassigned_date" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_assignments_machine_id_is_active_idx" ON "staff_assignments"("machine_id", "is_active");

-- CreateIndex
CREATE INDEX "staff_assignments_user_id_is_active_idx" ON "staff_assignments"("user_id", "is_active");

-- AddForeignKey
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
