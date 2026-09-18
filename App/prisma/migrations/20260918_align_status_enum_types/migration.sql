-- Aligns status columns created by early hand-written migrations (VARCHAR/TEXT)
-- with the Prisma enum types.
--
-- Why: the Prisma schema declares these fields as enums, so Prisma binds
-- parameters cast to the Postgres enum type. When that type does not exist (or
-- the column is a plain varchar/text) Postgres raises 42704 and every query
-- that filters on the column fails with a 500.
--
-- Safe: every existing value was verified to be a member of the target enum.

-- 1) Create the enum types Prisma expects but which were never created.
DO $$ BEGIN
  CREATE TYPE "ProductionPlanStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CostChangeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2) boms.status: varchar -> BomStatus (schema: non-null, default DRAFT)
ALTER TABLE "boms" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "boms" ALTER COLUMN "status" TYPE "BomStatus" USING ("status"::text::"BomStatus");
UPDATE "boms" SET "status" = 'DRAFT' WHERE "status" IS NULL;
ALTER TABLE "boms" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "boms" ALTER COLUMN "status" SET DEFAULT 'DRAFT'::"BomStatus";

-- 3) production_plans.status: varchar -> ProductionPlanStatus (schema: non-null, default DRAFT)
ALTER TABLE "production_plans" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "production_plans" ALTER COLUMN "status" TYPE "ProductionPlanStatus" USING ("status"::text::"ProductionPlanStatus");
UPDATE "production_plans" SET "status" = 'DRAFT' WHERE "status" IS NULL;
ALTER TABLE "production_plans" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "production_plans" ALTER COLUMN "status" SET DEFAULT 'DRAFT'::"ProductionPlanStatus";

-- 4) cost_audits.status: text -> CostChangeStatus (schema: non-null, default PENDING)
ALTER TABLE "cost_audits" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "cost_audits" ALTER COLUMN "status" TYPE "CostChangeStatus" USING ("status"::text::"CostChangeStatus");
UPDATE "cost_audits" SET "status" = 'PENDING' WHERE "status" IS NULL;
ALTER TABLE "cost_audits" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "cost_audits" ALTER COLUMN "status" SET DEFAULT 'PENDING'::"CostChangeStatus";
