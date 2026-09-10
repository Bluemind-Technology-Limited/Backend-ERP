-- Add comprehensive timestamps to track entity lifecycle transitions

-- AlterTable requisitions
ALTER TABLE "requisitions" ADD COLUMN "approved_at" TIMESTAMP(3);
ALTER TABLE "requisitions" ADD COLUMN "rejected_at" TIMESTAMP(3);

-- AlterTable purchase_orders
ALTER TABLE "purchase_orders" ADD COLUMN "sent_at" TIMESTAMP(3);
ALTER TABLE "purchase_orders" ADD COLUMN "received_at" TIMESTAMP(3);
ALTER TABLE "purchase_orders" ADD COLUMN "closed_at" TIMESTAMP(3);

-- AlterTable goods_receipts
ALTER TABLE "goods_receipts" ADD COLUMN "approved_at" TIMESTAMP(3);
ALTER TABLE "goods_receipts" ADD COLUMN "rejected_at" TIMESTAMP(3);
ALTER TABLE "goods_receipts" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable production_orders
ALTER TABLE "production_orders" ADD COLUMN "actual_start" TIMESTAMP(3);

-- AlterTable boms
ALTER TABLE "boms" ADD COLUMN "archived_at" TIMESTAMP(3);

-- Create indexes on timestamp columns for fast querying
CREATE INDEX "requisitions_approved_at_idx" ON "requisitions"("approved_at");
CREATE INDEX "requisitions_rejected_at_idx" ON "requisitions"("rejected_at");

CREATE INDEX "purchase_orders_sent_at_idx" ON "purchase_orders"("sent_at");
CREATE INDEX "purchase_orders_received_at_idx" ON "purchase_orders"("received_at");
CREATE INDEX "purchase_orders_closed_at_idx" ON "purchase_orders"("closed_at");

CREATE INDEX "goods_receipts_approved_at_idx" ON "goods_receipts"("approved_at");
CREATE INDEX "goods_receipts_rejected_at_idx" ON "goods_receipts"("rejected_at");

CREATE INDEX "production_orders_actual_start_idx" ON "production_orders"("actual_start");

CREATE INDEX "boms_archived_at_idx" ON "boms"("archived_at");
