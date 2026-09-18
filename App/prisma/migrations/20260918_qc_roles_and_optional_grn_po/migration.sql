-- QC roles: rename QA_INSPECTOR -> QC and add HEAD_OF_QC.
-- Renaming preserves existing users' role assignment.
ALTER TYPE "UserRole" RENAME VALUE 'QA_INSPECTOR' TO 'QC';
ALTER TYPE "UserRole" ADD VALUE 'HEAD_OF_QC';

-- Consignment-based goods receipts are not backed by a Purchase Order, so the
-- FK must be optional (previously the literal "consignment-based" violated it).
ALTER TABLE "goods_receipts" ALTER COLUMN "po_id" DROP NOT NULL;
