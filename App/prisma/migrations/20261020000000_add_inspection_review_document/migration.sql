-- QA review document uploaded by the inspector (Cloudflare R2 object).
ALTER TABLE "inspection_records"
  ADD COLUMN "review_document_url" TEXT,
  ADD COLUMN "review_document_key" TEXT,
  ADD COLUMN "review_document_name" TEXT,
  ADD COLUMN "review_document_mime" TEXT,
  ADD COLUMN "review_document_size" INTEGER,
  ADD COLUMN "review_document_uploaded_at" TIMESTAMP(3),
  ADD COLUMN "review_document_uploaded_by_id" TEXT;
