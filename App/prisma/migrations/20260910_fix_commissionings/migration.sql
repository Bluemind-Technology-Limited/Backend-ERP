-- Drop the incorrectly created commissionings table
DROP TABLE IF EXISTS "commissionings" CASCADE;

-- Recreate commissionings with correct columns per schema
CREATE TABLE "commissionings" (
    "id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "commissioning_date" TIMESTAMP(3) NOT NULL,
    "commissioned_by_id" TEXT NOT NULL,
    "installation_status" TEXT NOT NULL,
    "test_results" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commissionings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "commissionings_machine_id_commissioning_date_idx" ON "commissionings"("machine_id", "commissioning_date");

-- AddForeignKey
ALTER TABLE "commissionings" ADD CONSTRAINT "commissionings_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commissionings" ADD CONSTRAINT "commissionings_commissioned_by_id_fkey" FOREIGN KEY ("commissioned_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
