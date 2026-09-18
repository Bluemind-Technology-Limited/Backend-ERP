-- The 2026-09-09 "flatten BOM, remove versions" migration moved BOM ingredients
-- onto `bom_id`, but left the old `bom_version_id` column behind — NOT NULL, with
-- an FK to the now-empty `bom_versions` table.
--
-- Prisma no longer writes `bom_version_id`, so every ingredient insert failed with
-- a null constraint violation ("Invalid prisma.bom.create() ... Null constraint
-- violation") and no batch formulation could be created at all.
--
-- Safe: `bom_ingredients` is empty at the time of writing, and `bom_versions` has
-- no rows — the column is dead weight referencing a retired design.

-- 1) Drop the legacy link and its column.
ALTER TABLE "bom_ingredients" DROP CONSTRAINT IF EXISTS "bom_ingredients_bom_version_id_fkey";
ALTER TABLE "bom_ingredients" DROP COLUMN IF EXISTS "bom_version_id";

-- 2) `bom_id` is the real link now, and the Prisma schema declares it required.
--    Only tighten it when no orphan rows would be stranded.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "bom_ingredients" WHERE "bom_id" IS NULL) THEN
    ALTER TABLE "bom_ingredients" ALTER COLUMN "bom_id" SET NOT NULL;
  END IF;
END $$;

-- 3) Index the link, matching @@index([bomId]) on the model.
CREATE INDEX IF NOT EXISTS "bom_ingredients_bom_id_idx" ON "bom_ingredients"("bom_id");
