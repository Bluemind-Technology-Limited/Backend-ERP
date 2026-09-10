-- Flatten BOM structure: migrate bom_versions data to boms, update foreign keys, drop bom_versions
-- SAFE: Migrate data first, then update references, then drop old table

-- Step 1: Add new columns to boms table
ALTER TABLE boms
  ADD COLUMN IF NOT EXISTS expected_yield DECIMAL(15, 4),
  ADD COLUMN IF NOT EXISTS yield_unit VARCHAR(255),
  ADD COLUMN IF NOT EXISTS finished_sku_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'DRAFT',
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS approved_by_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS updated_by_id VARCHAR(255);

-- Step 2: Migrate data from bom_versions to boms
-- For each BOM, take the latest version (highest version number)
UPDATE boms b
SET
  expected_yield = (
    SELECT expected_yield FROM bom_versions bv
    WHERE bv.bom_id = b.id
    ORDER BY version DESC
    LIMIT 1
  ),
  yield_unit = (
    SELECT yield_unit FROM bom_versions bv
    WHERE bv.bom_id = b.id
    ORDER BY version DESC
    LIMIT 1
  ),
  finished_sku_id = (
    SELECT finished_sku_id FROM bom_versions bv
    WHERE bv.bom_id = b.id
    ORDER BY version DESC
    LIMIT 1
  ),
  status = COALESCE(
    (SELECT status::text FROM bom_versions bv
    WHERE bv.bom_id = b.id
    ORDER BY version DESC
    LIMIT 1),
    'DRAFT'
  )
WHERE expected_yield IS NULL;

-- Step 3: Update bom_ingredients to reference boms directly
-- First add the new bom_id column
ALTER TABLE bom_ingredients
  ADD COLUMN IF NOT EXISTS bom_id VARCHAR(255);

-- Populate bom_id from bom_versions
UPDATE bom_ingredients bi
SET bom_id = (
  SELECT bom_id FROM bom_versions bv
  WHERE bv.id = bi.bom_version_id
)
WHERE bom_id IS NULL;

-- Step 4: Update production_orders to reference boms directly
-- First add the new bom_id column
ALTER TABLE production_orders
  ADD COLUMN IF NOT EXISTS bom_id VARCHAR(255);

-- Populate bom_id from bom_versions
UPDATE production_orders po
SET bom_id = (
  SELECT bom_id FROM bom_versions bv
  WHERE bv.id = po.bom_version_id
)
WHERE bom_id IS NULL;

-- Step 5: Add foreign key constraints for new columns
ALTER TABLE bom_ingredients
  ADD CONSTRAINT fk_bom_ingredients_bom FOREIGN KEY (bom_id)
    REFERENCES boms(id) ON DELETE CASCADE;

ALTER TABLE production_orders
  ADD CONSTRAINT fk_production_orders_bom FOREIGN KEY (bom_id)
    REFERENCES boms(id) ON DELETE RESTRICT;

-- Step 6: Add foreign keys for approval tracking
ALTER TABLE boms
  ADD CONSTRAINT fk_boms_approved_by FOREIGN KEY (approved_by_id)
    REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_boms_updated_by FOREIGN KEY (updated_by_id)
    REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_boms_finished_sku FOREIGN KEY (finished_sku_id)
    REFERENCES materials(id) ON DELETE SET NULL;

-- Step 7: Create indexes for performance (NO unique constraint if duplicates exist)
CREATE INDEX IF NOT EXISTS idx_boms_status ON boms(status);
CREATE INDEX IF NOT EXISTS idx_boms_finished_sku ON boms(finished_sku_id);
CREATE INDEX IF NOT EXISTS idx_bom_ingredients_bom ON bom_ingredients(bom_id);
CREATE INDEX IF NOT EXISTS idx_production_orders_bom ON production_orders(bom_id);

-- Step 8: Drop old foreign key constraints and columns
ALTER TABLE bom_ingredients
  DROP CONSTRAINT IF EXISTS bom_ingredients_bom_version_id_fkey,
  DROP COLUMN IF EXISTS bom_version_id;

ALTER TABLE production_orders
  DROP CONSTRAINT IF EXISTS production_orders_bom_version_id_fkey,
  DROP COLUMN IF EXISTS bom_version_id;

-- Step 9: Drop bom_versions table
DROP TABLE IF EXISTS bom_versions CASCADE;
