-- CreateEnum
CREATE TYPE "ConsignmentStatus" AS ENUM ('DRAFT', 'READY_FOR_SHIPMENT', 'IN_TRANSIT', 'RECEIVED', 'DISTRIBUTED', 'COMPLETED');

-- CreateTable consignments
CREATE TABLE "consignments" (
    "id" TEXT NOT NULL,
    "consignment_number" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "status" "ConsignmentStatus" NOT NULL DEFAULT 'DRAFT',
    "po_numbers" TEXT,
    "ship_date" TIMESTAMP(3),
    "expected_delivery" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "distributed_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "received_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable consignment_items
CREATE TABLE "consignment_items" (
    "id" TEXT NOT NULL,
    "consignment_id" TEXT NOT NULL,
    "material_id" TEXT NOT NULL,
    "quantity" DECIMAL(15,4) NOT NULL,
    "unit_of_measure" TEXT NOT NULL,
    "distributed_qty" DECIMAL(15,4) NOT NULL DEFAULT 0,

    CONSTRAINT "consignment_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable consignment_distributions
CREATE TABLE "consignment_distributions" (
    "id" TEXT NOT NULL,
    "consignment_id" TEXT NOT NULL,
    "consignment_item_id" TEXT NOT NULL,
    "bin_id" TEXT NOT NULL,
    "quantity" DECIMAL(15,4) NOT NULL,
    "distributed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "distributed_by_id" TEXT NOT NULL,

    CONSTRAINT "consignment_distributions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "consignments_consignment_number_key" ON "consignments"("consignment_number");

-- CreateIndex
CREATE INDEX "consignments_status_idx" ON "consignments"("status");

-- CreateIndex
CREATE INDEX "consignments_supplier_id_idx" ON "consignments"("supplier_id");

-- CreateIndex
CREATE INDEX "consignments_warehouse_id_idx" ON "consignments"("warehouse_id");

-- CreateIndex
CREATE INDEX "consignments_ship_date_idx" ON "consignments"("ship_date");

-- CreateIndex
CREATE INDEX "consignment_items_consignment_id_idx" ON "consignment_items"("consignment_id");

-- CreateIndex
CREATE INDEX "consignment_items_material_id_idx" ON "consignment_items"("material_id");

-- CreateIndex
CREATE INDEX "consignment_distributions_consignment_id_idx" ON "consignment_distributions"("consignment_id");

-- CreateIndex
CREATE INDEX "consignment_distributions_consignment_item_id_idx" ON "consignment_distributions"("consignment_item_id");

-- CreateIndex
CREATE INDEX "consignment_distributions_bin_id_idx" ON "consignment_distributions"("bin_id");

-- AddForeignKey
ALTER TABLE "consignments" ADD CONSTRAINT "consignments_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignments" ADD CONSTRAINT "consignments_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignments" ADD CONSTRAINT "consignments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignments" ADD CONSTRAINT "consignments_received_by_id_fkey" FOREIGN KEY ("received_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignment_items" ADD CONSTRAINT "consignment_items_consignment_id_fkey" FOREIGN KEY ("consignment_id") REFERENCES "consignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignment_items" ADD CONSTRAINT "consignment_items_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignment_distributions" ADD CONSTRAINT "consignment_distributions_consignment_id_fkey" FOREIGN KEY ("consignment_id") REFERENCES "consignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignment_distributions" ADD CONSTRAINT "consignment_distributions_consignment_item_id_fkey" FOREIGN KEY ("consignment_item_id") REFERENCES "consignment_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignment_distributions" ADD CONSTRAINT "consignment_distributions_bin_id_fkey" FOREIGN KEY ("bin_id") REFERENCES "warehouse_bins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignment_distributions" ADD CONSTRAINT "consignment_distributions_distributed_by_id_fkey" FOREIGN KEY ("distributed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
