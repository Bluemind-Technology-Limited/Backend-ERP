-- Drop all machine-related tables
DROP TABLE IF EXISTS "staff_assignments" CASCADE;
DROP TABLE IF EXISTS "spare_parts" CASCADE;
DROP TABLE IF EXISTS "maintenances" CASCADE;
DROP TABLE IF EXISTS "breakdowns" CASCADE;
DROP TABLE IF EXISTS "performances" CASCADE;
DROP TABLE IF EXISTS "commissionings" CASCADE;
DROP TABLE IF EXISTS "machines" CASCADE;

-- Drop all machine-related enums
DROP TYPE IF EXISTS "BreakdownStatus" CASCADE;
DROP TYPE IF EXISTS "MaintenanceStatus" CASCADE;
DROP TYPE IF EXISTS "MaintenanceType" CASCADE;
DROP TYPE IF EXISTS "MachineCategory" CASCADE;
DROP TYPE IF EXISTS "MachineStatus" CASCADE;
