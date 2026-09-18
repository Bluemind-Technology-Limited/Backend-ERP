-- Traceability lineage: link consignment-based GRNs to their consignment, and
-- record the exact batch lots a grinding station consumed per batch.

-- GoodsReceipt -> Consignment (consignment-based receipts have no PO)
ALTER TABLE "goods_receipts" ADD COLUMN "consignment_id" TEXT;
ALTER TABLE "goods_receipts"
  ADD CONSTRAINT "goods_receipts_consignment_id_fkey"
  FOREIGN KEY ("consignment_id") REFERENCES "consignments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "goods_receipts_consignment_id_idx" ON "goods_receipts"("consignment_id");

-- Grinding input batch lots (finished batch -> specific raw batches)
CREATE TABLE "production_grinding_inputs" (
  "id" TEXT NOT NULL,
  "stage_record_id" TEXT NOT NULL,
  "material_id" TEXT NOT NULL,
  "batch_lot_id" TEXT,
  "quantity" DECIMAL(15,4) NOT NULL,
  "unit_of_measure" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "production_grinding_inputs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "production_grinding_inputs_stage_record_id_fkey" FOREIGN KEY ("stage_record_id") REFERENCES "production_stage_records"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "production_grinding_inputs_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "production_grinding_inputs_batch_lot_id_fkey" FOREIGN KEY ("batch_lot_id") REFERENCES "batch_lots"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "production_grinding_inputs_stage_record_id_idx" ON "production_grinding_inputs"("stage_record_id");
CREATE INDEX "production_grinding_inputs_material_id_idx" ON "production_grinding_inputs"("material_id");
CREATE INDEX "production_grinding_inputs_batch_lot_id_idx" ON "production_grinding_inputs"("batch_lot_id");
