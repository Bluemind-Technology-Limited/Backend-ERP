-- AlterTable
ALTER TABLE "materials" DROP COLUMN IF EXISTS "shelf_life_days";
ALTER TABLE "materials" ADD COLUMN "default_expiry_date" TIMESTAMP(3);
