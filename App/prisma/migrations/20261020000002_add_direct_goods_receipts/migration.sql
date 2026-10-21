-- Distinguish PO, consignment and contingency (direct) goods receipts.
CREATE TYPE "GoodsReceiptSource" AS ENUM ('PURCHASE_ORDER', 'CONSIGNMENT', 'DIRECT');

ALTER TABLE "goods_receipts"
  ADD COLUMN "supplier_id" TEXT,
  ADD COLUMN "source" "GoodsReceiptSource" NOT NULL DEFAULT 'PURCHASE_ORDER';

-- Backfill the source from the existing links.
UPDATE "goods_receipts"
SET "source" = 'CONSIGNMENT'
WHERE "consignment_id" IS NOT NULL;

UPDATE "goods_receipts"
SET "source" = 'DIRECT'
WHERE "po_id" IS NULL AND "consignment_id" IS NULL;

-- Copy the supplier from the PO / consignment so direct receipts can fall back
-- to an explicit supplier selection.
UPDATE "goods_receipts" gr
SET "supplier_id" = po."supplier_id"
FROM "purchase_orders" po
WHERE gr."po_id" = po."id";

UPDATE "goods_receipts" gr
SET "supplier_id" = c."supplier_id"
FROM "consignments" c
WHERE gr."consignment_id" = c."id";

ALTER TABLE "goods_receipts"
  ADD CONSTRAINT "goods_receipts_supplier_id_fkey"
  FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "goods_receipts_source_idx" ON "goods_receipts"("source");
CREATE INDEX "goods_receipts_supplier_id_idx" ON "goods_receipts"("supplier_id");
