-- SOP KIB/QCA/010 — Lot coding and traceability.
--
-- Lot code = [Vendor Code] + [Ingredient Code] + [Material Set Number] + [Year Code]
-- rendered with dashes, e.g. "A-1-1-26".
--
-- Every new column is nullable or defaulted, so existing suppliers, materials and
-- batch lots remain valid and can be filled in by editing.

-- 1) Vendor code on suppliers (alphabetic, e.g. A, B, C).
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "vendor_code" TEXT;

-- 2) Ingredient (traceability) code on materials (numeric, e.g. 1, 2, 3).
ALTER TABLE "materials" ADD COLUMN IF NOT EXISTS "traceability_code" TEXT;

-- 3) Inbound lot vs finished production batch.
DO $$ BEGIN
  CREATE TYPE "BatchLotOrigin" AS ENUM ('INBOUND', 'FINISHED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 4) Lot-code components on the batch lot.
ALTER TABLE "batch_lots" ADD COLUMN IF NOT EXISTS "origin" "BatchLotOrigin" NOT NULL DEFAULT 'INBOUND';
ALTER TABLE "batch_lots" ADD COLUMN IF NOT EXISTS "lot_code" TEXT;
ALTER TABLE "batch_lots" ADD COLUMN IF NOT EXISTS "set_number" INTEGER;
ALTER TABLE "batch_lots" ADD COLUMN IF NOT EXISTS "vendor_code" TEXT;
ALTER TABLE "batch_lots" ADD COLUMN IF NOT EXISTS "ingredient_code" TEXT;
ALTER TABLE "batch_lots" ADD COLUMN IF NOT EXISTS "year_code" TEXT;
ALTER TABLE "batch_lots" ADD COLUMN IF NOT EXISTS "supplier_batch_number" TEXT;
ALTER TABLE "batch_lots" ADD COLUMN IF NOT EXISTS "supplier_id" TEXT;

-- 5) Indexes and constraints (names match Prisma's conventions).
CREATE UNIQUE INDEX IF NOT EXISTS "batch_lots_lot_code_key" ON "batch_lots"("lot_code");
CREATE INDEX IF NOT EXISTS "batch_lots_vendor_code_idx" ON "batch_lots"("vendor_code");
CREATE INDEX IF NOT EXISTS "batch_lots_ingredient_code_idx" ON "batch_lots"("ingredient_code");
CREATE INDEX IF NOT EXISTS "batch_lots_origin_idx" ON "batch_lots"("origin");
CREATE INDEX IF NOT EXISTS "batch_lots_supplier_id_material_id_year_code_idx"
  ON "batch_lots"("supplier_id", "material_id", "year_code");

DO $$ BEGIN
  ALTER TABLE "batch_lots"
    ADD CONSTRAINT "batch_lots_supplier_id_fkey"
    FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
