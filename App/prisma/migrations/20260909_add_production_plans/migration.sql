-- Add production planning tables for multi-product production
-- SAFE: Only adds new tables, doesn't modify existing

-- Step 1: Create production_plans table
CREATE TABLE IF NOT EXISTS production_plans (
  id VARCHAR(255) PRIMARY KEY,
  plan_number VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  status VARCHAR(50) DEFAULT 'DRAFT',
  scheduled_for TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_by_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by_id) REFERENCES users(id) ON DELETE RESTRICT
);

-- Step 2: Create production_plan_items table
CREATE TABLE IF NOT EXISTS production_plan_items (
  id VARCHAR(255) PRIMARY KEY,
  production_plan_id VARCHAR(255) NOT NULL,
  bom_id VARCHAR(255) NOT NULL,
  target_quantity DECIMAL(15, 4) NOT NULL,
  actual_yield DECIMAL(15, 4),
  sequence INT DEFAULT 1,
  FOREIGN KEY (production_plan_id) REFERENCES production_plans(id) ON DELETE CASCADE,
  FOREIGN KEY (bom_id) REFERENCES boms(id) ON DELETE RESTRICT
);

-- Step 3: Create plan_aggregated_ingredients table
CREATE TABLE IF NOT EXISTS plan_aggregated_ingredients (
  id VARCHAR(255) PRIMARY KEY,
  production_plan_id VARCHAR(255) NOT NULL,
  material_id VARCHAR(255) NOT NULL,
  total_quantity DECIMAL(15, 4) NOT NULL,
  unit_of_measure VARCHAR(255) NOT NULL,
  status VARCHAR(50) DEFAULT 'PENDING',
  FOREIGN KEY (production_plan_id) REFERENCES production_plans(id) ON DELETE CASCADE,
  FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE RESTRICT
);

-- Step 4: Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_production_plans_status ON production_plans(status);
CREATE INDEX IF NOT EXISTS idx_production_plans_scheduled_for ON production_plans(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_production_plans_created_by ON production_plans(created_by_id);
CREATE INDEX IF NOT EXISTS idx_production_plan_items_plan ON production_plan_items(production_plan_id);
CREATE INDEX IF NOT EXISTS idx_production_plan_items_bom ON production_plan_items(bom_id);
CREATE INDEX IF NOT EXISTS idx_plan_aggregated_ingredients_plan ON plan_aggregated_ingredients(production_plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_aggregated_ingredients_material ON plan_aggregated_ingredients(material_id);

-- Step 5: Add comments for documentation
COMMENT ON TABLE production_plans IS 'Multi-product production plans that group multiple batch formulations';
COMMENT ON TABLE production_plan_items IS 'Items in a production plan - each is a batch formulation with target quantity';
COMMENT ON TABLE plan_aggregated_ingredients IS 'Pre-calculated aggregated ingredients needed for entire production plan';
