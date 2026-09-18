-- Link consignment stock movements back to the ingredient they came from, so
-- approved quantity changes can post an exact delta against what is in stock.
ALTER TABLE "inventory_transactions" ADD COLUMN "consignment_item_id" TEXT;

ALTER TABLE "inventory_transactions"
  ADD CONSTRAINT "inventory_transactions_consignment_item_id_fkey"
  FOREIGN KEY ("consignment_item_id") REFERENCES "consignment_items"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "inventory_transactions_consignment_item_id_idx" ON "inventory_transactions"("consignment_item_id");
