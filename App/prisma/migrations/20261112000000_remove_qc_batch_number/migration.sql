-- QA now edits the set number (and therefore the lot code) instead of assigning
-- a separate QC Ingredient Batch Number.
DROP INDEX IF EXISTS "batch_lots_material_id_qc_batch_number_key";
ALTER TABLE "batch_lots" DROP COLUMN IF EXISTS "qc_batch_number";
