-- Add unit cost fields to Material
ALTER TABLE "materials" ADD COLUMN "standard_cost" NUMERIC(15,4) DEFAULT 0;
ALTER TABLE "materials" ADD COLUMN "last_cost_update_at" TIMESTAMP(3);
ALTER TABLE "materials" ADD COLUMN "last_cost_updated_by" TEXT;

-- Add cost fields to BomIngredient
ALTER TABLE "bom_ingredients" ADD COLUMN "estimated_cost" NUMERIC(15,4) DEFAULT 0;
ALTER TABLE "bom_ingredients" ADD COLUMN "cost_updated_at" TIMESTAMP(3);

-- Add cost fields to ProductionOrder
ALTER TABLE "production_orders" ADD COLUMN "estimated_cost" NUMERIC(15,4) DEFAULT 0;
ALTER TABLE "production_orders" ADD COLUMN "actual_cost" NUMERIC(15,4);
ALTER TABLE "production_orders" ADD COLUMN "cost_variance" NUMERIC(15,4);

-- Add unit cost to GoodsReceiptItem
ALTER TABLE "goods_receipt_items" ADD COLUMN "unit_cost" NUMERIC(15,4) DEFAULT 0;

-- Create CostAudit table
CREATE TABLE "cost_audits" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "field_name" TEXT NOT NULL,
    "old_value" NUMERIC(15,4),
    "new_value" NUMERIC(15,4) NOT NULL,
    "reason" TEXT,
    "change_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "changed_by_id" TEXT NOT NULL,
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "cost_audits_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "cost_audits_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Create indexes for CostAudit
CREATE INDEX "cost_audits_entity_type_entity_id_idx" ON "cost_audits"("entity_type", "entity_id");
CREATE INDEX "cost_audits_changed_by_id_changed_at_idx" ON "cost_audits"("changed_by_id", "changed_at");
CREATE INDEX "cost_audits_status_changed_at_idx" ON "cost_audits"("status", "changed_at");
