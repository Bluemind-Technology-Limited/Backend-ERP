-- Material pack definition: every quantity in the system is a count of these
-- packs (100 × 25 KG = 2,500 KG). `unit_of_measure` keeps the rendered label.
--
-- Defensive because an earlier, uncommitted `material_pack_size` migration may
-- already have added these columns on some databases.
ALTER TABLE "materials" ADD COLUMN IF NOT EXISTS "pack_size" DECIMAL(15, 4);
ALTER TABLE "materials" ADD COLUMN IF NOT EXISTS "pack_unit" TEXT;

UPDATE "materials" SET "pack_size" = 1 WHERE "pack_size" IS NULL OR "pack_size" <= 0;
UPDATE "materials" SET "pack_unit" = 'KG' WHERE "pack_unit" IS NULL OR btrim("pack_unit") = '';

ALTER TABLE "materials" ALTER COLUMN "pack_size" SET DEFAULT 1;
ALTER TABLE "materials" ALTER COLUMN "pack_unit" SET DEFAULT 'KG';
ALTER TABLE "materials" ALTER COLUMN "pack_size" SET NOT NULL;
ALTER TABLE "materials" ALTER COLUMN "pack_unit" SET NOT NULL;
