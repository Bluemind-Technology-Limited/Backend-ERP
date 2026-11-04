-- Shelf life in days for a material/product (730 = 2 years).
-- Kept alongside default_expiry_date so the UI can show the period in days.

ALTER TABLE "materials"
  ADD COLUMN IF NOT EXISTS "shelf_life_days" INTEGER;
