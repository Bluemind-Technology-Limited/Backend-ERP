-- CreateEnum: QuantityAdjustmentStatus
CREATE TYPE "QuantityAdjustmentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable: quantity_adjustments
-- QC-proposed quantity change for a consignment ingredient, approved by Head of QC.
CREATE TABLE "quantity_adjustments" (
  "id" TEXT NOT NULL,
  "consignment_id" TEXT NOT NULL,
  "consignment_item_id" TEXT NOT NULL,
  "material_id" TEXT NOT NULL,
  "old_quantity" DECIMAL(15,4) NOT NULL,
  "new_quantity" DECIMAL(15,4) NOT NULL,
  "difference" DECIMAL(15,4) NOT NULL,
  "reason_code" TEXT,
  "reason" TEXT,
  "status" "QuantityAdjustmentStatus" NOT NULL DEFAULT 'PENDING',
  "requested_by_id" TEXT NOT NULL,
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approved_by_id" TEXT,
  "decided_at" TIMESTAMP(3),
  "rejection_reason" TEXT,
  "applied_at" TIMESTAMP(3),
  "inventory_transaction_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "quantity_adjustments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "quantity_adjustments_consignment_id_fkey" FOREIGN KEY ("consignment_id") REFERENCES "consignments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "quantity_adjustments_consignment_item_id_fkey" FOREIGN KEY ("consignment_item_id") REFERENCES "consignment_items"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "quantity_adjustments_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "quantity_adjustments_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "quantity_adjustments_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex: quantity_adjustments
CREATE INDEX "quantity_adjustments_consignment_id_idx" ON "quantity_adjustments"("consignment_id");
CREATE INDEX "quantity_adjustments_consignment_item_id_idx" ON "quantity_adjustments"("consignment_item_id");
CREATE INDEX "quantity_adjustments_status_idx" ON "quantity_adjustments"("status");
CREATE INDEX "quantity_adjustments_requested_by_id_idx" ON "quantity_adjustments"("requested_by_id");
