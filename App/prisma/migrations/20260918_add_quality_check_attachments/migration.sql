-- CreateTable: quality_check_attachments
-- Proof-of-check files (photos, certificates, lab reports, documents) attached
-- to an individual quality check item. Binary content lives in Supabase Storage;
-- this table only stores metadata + the object path.
CREATE TABLE "quality_check_attachments" (
  "id" TEXT NOT NULL,
  "quality_check_item_id" TEXT NOT NULL,
  "consignment_id" TEXT NOT NULL,
  "file_name" TEXT NOT NULL,
  "storage_path" TEXT NOT NULL,
  "mime_type" TEXT,
  "file_size" INTEGER,
  "kind" TEXT,
  "uploaded_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "quality_check_attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "quality_check_attachments_quality_check_item_id_fkey" FOREIGN KEY ("quality_check_item_id") REFERENCES "quality_check_items"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "quality_check_attachments_consignment_id_fkey" FOREIGN KEY ("consignment_id") REFERENCES "consignments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "quality_check_attachments_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex: quality_check_attachments
CREATE INDEX "quality_check_attachments_quality_check_item_id_idx" ON "quality_check_attachments"("quality_check_item_id");
CREATE INDEX "quality_check_attachments_consignment_id_idx" ON "quality_check_attachments"("consignment_id");
