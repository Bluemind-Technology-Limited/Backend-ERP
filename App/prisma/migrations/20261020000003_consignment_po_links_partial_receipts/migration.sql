-- Consignments become a batch of Purchase Order lines, and each line tracks
-- what has actually been received so the remainder can be received later.
--
-- 1) PurchaseOrderStatus: PARTIAL -> PARTIALLY_RECEIVED (explicit naming).
-- 2) ConsignmentStatus: add PARTIALLY_RECEIVED.
-- 3) consignments.po_id -> the PO this shipment is drawn from.
-- 4) consignment_items.po_item_id -> the PO line being fulfilled.
-- 5) consignment_items.received_qty -> how much of the line has arrived.
--
-- Written to be idempotent: an earlier run of this migration can leave the
-- object changes committed (Prisma does not wrap migrations in a transaction),
-- so every statement checks the current state before acting.

-- ---------------------------------------------------------------------------
-- 1) Recreate the PO status enum (Postgres cannot remove a value in place).
--    Only runs when the old PARTIAL value is still present.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'PurchaseOrderStatus' AND e.enumlabel = 'PARTIAL'
  ) THEN
    ALTER TYPE "PurchaseOrderStatus" RENAME TO "PurchaseOrderStatus_old";

    CREATE TYPE "PurchaseOrderStatus" AS ENUM (
      'DRAFT',
      'SENT',
      'PARTIALLY_RECEIVED',
      'RECEIVED',
      'CLOSED'
    );

    ALTER TABLE "purchase_orders" ALTER COLUMN "status" DROP DEFAULT;

    ALTER TABLE "purchase_orders"
      ALTER COLUMN "status" TYPE "PurchaseOrderStatus"
      USING (
        CASE
          WHEN "status"::text = 'PARTIAL' THEN 'PARTIALLY_RECEIVED'
          ELSE "status"::text
        END
      )::"PurchaseOrderStatus";

    ALTER TABLE "purchase_orders"
      ALTER COLUMN "status" SET DEFAULT 'DRAFT'::"PurchaseOrderStatus";

    DROP TYPE "PurchaseOrderStatus_old";
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Consignment status gains a partial-receipt state.
-- ---------------------------------------------------------------------------
ALTER TYPE "ConsignmentStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_RECEIVED';

-- ---------------------------------------------------------------------------
-- 3) Consignment -> Purchase Order.
-- ---------------------------------------------------------------------------
ALTER TABLE "consignments" ADD COLUMN IF NOT EXISTS "po_id" TEXT;

-- Best-effort backfill: a consignment whose free-text po_numbers names exactly
-- one PO from the same supplier belongs to that PO.
UPDATE "consignments" c
SET "po_id" = po."id"
FROM "purchase_orders" po
WHERE c."po_id" IS NULL
  AND c."po_numbers" IS NOT NULL
  AND c."po_numbers" = po."number"
  AND po."supplier_id" = c."supplier_id";

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'consignments_po_id_fkey') THEN
    ALTER TABLE "consignments"
      ADD CONSTRAINT "consignments_po_id_fkey"
      FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "consignments_po_id_idx" ON "consignments"("po_id");

-- ---------------------------------------------------------------------------
-- 4) Consignment line -> Purchase Order line.
-- ---------------------------------------------------------------------------
ALTER TABLE "consignment_items"
  ADD COLUMN IF NOT EXISTS "po_item_id" TEXT,
  ADD COLUMN IF NOT EXISTS "received_qty" DECIMAL(15, 4) NOT NULL DEFAULT 0;

-- Best-effort backfill for lines whose consignment is already linked and whose
-- material appears exactly once on that PO.
UPDATE "consignment_items" ci
SET "po_item_id" = (
  SELECT poi."id"
  FROM "consignments" c
  JOIN "purchase_order_items" poi
    ON poi."po_id" = c."po_id" AND poi."material_id" = ci."material_id"
  WHERE c."id" = ci."consignment_id"
  LIMIT 1
)
WHERE ci."po_item_id" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "consignments" c
    WHERE c."id" = ci."consignment_id"
      AND c."po_id" IS NOT NULL
      AND (
        SELECT COUNT(*)
        FROM "purchase_order_items" p2
        WHERE p2."po_id" = c."po_id" AND p2."material_id" = ci."material_id"
      ) = 1
  );

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'consignment_items_po_item_id_fkey') THEN
    ALTER TABLE "consignment_items"
      ADD CONSTRAINT "consignment_items_po_item_id_fkey"
      FOREIGN KEY ("po_item_id") REFERENCES "purchase_order_items"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "consignment_items_po_item_id_idx" ON "consignment_items"("po_item_id");

-- ---------------------------------------------------------------------------
-- 5) Anything already posted through a consignment GRN counts as received.
-- ---------------------------------------------------------------------------
UPDATE "consignment_items" ci
SET "received_qty" = COALESCE(t.total, 0)
FROM (
  SELECT "consignment_item_id", SUM("quantity") AS total
  FROM "inventory_transactions"
  WHERE "consignment_item_id" IS NOT NULL
  GROUP BY "consignment_item_id"
) t
WHERE t."consignment_item_id" = ci."id"
  AND ci."received_qty" = 0;
