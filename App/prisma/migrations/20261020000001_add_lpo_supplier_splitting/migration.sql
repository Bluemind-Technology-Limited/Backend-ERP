-- Split one internal purchase order across suppliers for outbound LPOs.
ALTER TABLE "purchase_order_items"
  ADD COLUMN "supplier_id" TEXT;

ALTER TABLE "purchase_orders"
  ADD COLUMN "lpo_emails" JSONB;

ALTER TABLE "purchase_order_items"
  ADD CONSTRAINT "purchase_order_items_supplier_id_fkey"
  FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "purchase_order_items_supplier_id_idx"
  ON "purchase_order_items"("supplier_id");
