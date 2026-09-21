-- Same un-migrated flattening as bom_ingredients, on the orders side.
--
-- `production_orders` kept a NOT NULL `bom_version_id` with an FK to the retired
-- `bom_versions` table. Prisma only writes `bom_id` now, so the database rejected
-- the NULL with P2011 (NullConstraintViolation on ProductionOrder) and NO
-- production order could ever be created:
--
--   POST /production/production-orders -> 500
--   Invalid `prisma.productionOrder.create()` ... Null constraint violation
--
-- Safe: `production_orders` has no rows, and `bom_versions` is empty.

-- 1) Drop the legacy FK and column.
ALTER TABLE "production_orders" DROP CONSTRAINT IF EXISTS "production_orders_bom_version_id_fkey";
ALTER TABLE "production_orders" DROP COLUMN IF EXISTS "bom_version_id";

-- 2) `bom_id` is the real link and the schema declares it required. Only tighten
--    when no existing order would be stranded with a NULL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "production_orders" WHERE "bom_id" IS NULL) THEN
    ALTER TABLE "production_orders" ALTER COLUMN "bom_id" SET NOT NULL;
  END IF;
END $$;
