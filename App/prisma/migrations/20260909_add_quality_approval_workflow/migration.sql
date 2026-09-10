-- AlterEnum: Add new consignment status values
ALTER TYPE "ConsignmentStatus" ADD VALUE 'QUALITY_PENDING';
ALTER TYPE "ConsignmentStatus" ADD VALUE 'QUALITY_APPROVED';

-- CreateEnum: QualityApprovalStatus
CREATE TYPE "QualityApprovalStatus" AS ENUM (
  'PENDING',
  'IN_PROGRESS',
  'PASSED',
  'FAILED',
  'APPROVED',
  'REJECTED'
);

-- CreateEnum: QualityCheckType
CREATE TYPE "QualityCheckType" AS ENUM (
  'PHYSICAL_INSPECTION',
  'QUANTITY_VERIFICATION',
  'EXPIRY_CHECK',
  'PACKAGING_INSPECTION',
  'DOCUMENTATION_REVIEW',
  'LABORATORY_TEST'
);

-- CreateTable: quality_approvals
CREATE TABLE "quality_approvals" (
  "id" TEXT NOT NULL,
  "consignment_id" TEXT NOT NULL,
  "status" "QualityApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "total_items" INTEGER NOT NULL DEFAULT 0,
  "passed_items" INTEGER NOT NULL DEFAULT 0,
  "failed_items" INTEGER NOT NULL DEFAULT 0,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "approved_at" TIMESTAMP(3),
  "rejected_at" TIMESTAMP(3),
  "started_by_id" TEXT,
  "approved_by_id" TEXT,
  "rejection_reason" TEXT,
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "quality_approvals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "quality_approvals_consignment_id_key" UNIQUE("consignment_id"),
  CONSTRAINT "quality_approvals_consignment_id_fkey" FOREIGN KEY ("consignment_id") REFERENCES "consignments"("id") ON DELETE CASCADE,
  CONSTRAINT "quality_approvals_started_by_id_fkey" FOREIGN KEY ("started_by_id") REFERENCES "users"("id"),
  CONSTRAINT "quality_approvals_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id")
);

-- CreateTable: quality_check_items
CREATE TABLE "quality_check_items" (
  "id" TEXT NOT NULL,
  "quality_approval_id" TEXT NOT NULL,
  "consignment_item_id" TEXT NOT NULL,
  "check_type" "QualityCheckType" NOT NULL,
  "status" "QualityApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "result" TEXT,
  "remarks" TEXT,
  "checked_at" TIMESTAMP(3),
  "checked_by_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "quality_check_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "quality_check_items_quality_approval_id_fkey" FOREIGN KEY ("quality_approval_id") REFERENCES "quality_approvals"("id") ON DELETE CASCADE,
  CONSTRAINT "quality_check_items_consignment_item_id_fkey" FOREIGN KEY ("consignment_item_id") REFERENCES "consignment_items"("id") ON DELETE CASCADE,
  CONSTRAINT "quality_check_items_checked_by_id_fkey" FOREIGN KEY ("checked_by_id") REFERENCES "users"("id")
);

-- CreateIndex: quality_approvals
CREATE INDEX "quality_approvals_status_idx" ON "quality_approvals"("status");
CREATE INDEX "quality_approvals_consignment_id_idx" ON "quality_approvals"("consignment_id");

-- CreateIndex: quality_check_items
CREATE INDEX "quality_check_items_quality_approval_id_idx" ON "quality_check_items"("quality_approval_id");
CREATE INDEX "quality_check_items_consignment_item_id_idx" ON "quality_check_items"("consignment_item_id");
CREATE INDEX "quality_check_items_status_idx" ON "quality_check_items"("status");
