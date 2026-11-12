-- Centralized ingredient release audit.
-- The production plan records exactly who released the ingredient requirements
-- and when, so repeated releases can be rejected and history is explicit.

ALTER TABLE "production_plans" ADD COLUMN IF NOT EXISTS "released_by_id" TEXT;
ALTER TABLE "production_plans" ADD COLUMN IF NOT EXISTS "released_at" TIMESTAMP(3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'production_plans_released_by_id_fkey'
  ) THEN
    ALTER TABLE "production_plans"
      ADD CONSTRAINT "production_plans_released_by_id_fkey"
      FOREIGN KEY ("released_by_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
