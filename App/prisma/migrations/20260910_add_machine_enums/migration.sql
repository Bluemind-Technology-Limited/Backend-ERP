-- Create MachineCategory enum if not exists
DO $$ BEGIN
    CREATE TYPE "MachineCategory" AS ENUM ('BOTTLING_LINE', 'CARTONING_MACHINE', 'LABELING_MACHINE', 'CAPPING_MACHINE', 'FILLING_MACHINE', 'WRAPPING_MACHINE', 'GRINDING_MILL', 'MIXER', 'OVEN', 'COOLER', 'OTHER');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Create MaintenanceType enum if not exists
DO $$ BEGIN
    CREATE TYPE "MaintenanceType" AS ENUM ('PREVENTIVE', 'CORRECTIVE');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Create MaintenanceStatus enum if not exists
DO $$ BEGIN
    CREATE TYPE "MaintenanceStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Create BreakdownStatus enum if not exists
DO $$ BEGIN
    CREATE TYPE "BreakdownStatus" AS ENUM ('REPORTED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Alter machines table category column to use MachineCategory enum
-- First drop default if exists, then alter type, then set default
ALTER TABLE "machines" ALTER COLUMN "category" DROP DEFAULT;
ALTER TABLE "machines" ALTER COLUMN "category" TYPE "MachineCategory" USING "category"::"MachineCategory";
ALTER TABLE "machines" ALTER COLUMN "category" SET DEFAULT 'OTHER'::"MachineCategory";

-- Alter breakdowns table status column to use BreakdownStatus enum
ALTER TABLE "breakdowns" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "breakdowns" ALTER COLUMN "status" TYPE "BreakdownStatus" USING "status"::"BreakdownStatus";
ALTER TABLE "breakdowns" ALTER COLUMN "status" SET DEFAULT 'REPORTED'::"BreakdownStatus";

-- Alter maintenances table status and maintenance_type columns
ALTER TABLE "maintenances" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "maintenances" ALTER COLUMN "status" TYPE "MaintenanceStatus" USING "status"::"MaintenanceStatus";
ALTER TABLE "maintenances" ALTER COLUMN "status" SET DEFAULT 'SCHEDULED'::"MaintenanceStatus";

ALTER TABLE "maintenances" ALTER COLUMN "maintenance_type" DROP DEFAULT;
ALTER TABLE "maintenances" ALTER COLUMN "maintenance_type" TYPE "MaintenanceType" USING "maintenance_type"::"MaintenanceType";
