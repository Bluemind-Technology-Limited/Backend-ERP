-- CreateEnum
CREATE TYPE "ProductionIngredientStatus" AS ENUM ('RESERVED', 'RELEASED', 'CONSUMED', 'RETURNED', 'PARTIALLY_CONSUMED');

-- AlterTable
ALTER TABLE "production_ingredients" ADD COLUMN "status" "ProductionIngredientStatus" NOT NULL DEFAULT 'RESERVED';

-- CreateIndex
CREATE INDEX "production_ingredients_status_idx" ON "production_ingredients"("status");
