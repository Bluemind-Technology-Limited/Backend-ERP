# Consignment QA — per-ingredient checks + proof attachments

Extends the consignment quality workflow so that:

1. **Every ingredient is checked independently**, even though the ingredients are
   grouped inside one consignment. A single ingredient can carry several checks
   (e.g. physical inspection + laboratory test), each with its own result,
   checker, timestamp and remarks.
2. **The consignment detail shows all involved ingredients** together with their
   per-ingredient QA outcome and the proof attached to each check.
3. **Proof of the checks can be attached** (photo, certificate, lab report,
   document) as a file upload.

## Data model

- `ConsignmentItem` — one row per ingredient in the consignment (unchanged).
- `QualityApproval` — one per consignment (unchanged). Its `totalItems`,
  `passedItems`, `failedItems` counters are now derived at **ingredient**
  granularity (an ingredient passes only if *all* its checks pass).
- `QualityCheckItem` — one row per independent check, linked to a specific
  `ConsignmentItem` (unchanged shape; `status` is now persisted correctly).
- `QualityCheckAttachment` *(new)* — proof files for a check. Stores metadata and
  the Supabase Storage object path only; signed URLs are minted on read.

## Storage setup (one-time)

Proof files live in a **private** Supabase Storage bucket (default
`qa-attachments`, override with `QA_ATTACHMENTS_BUCKET`).

```bash
cd backend/App
pnpm db:deploy        # applies the new migration
pnpm storage:setup    # creates the private bucket (idempotent)
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` must be set on the backend.

## API

All routes are mounted under `/api/quality` and require the Supabase JWT.

| Method + path | Permission | Purpose |
|---|---|---|
| `POST /approvals/initiate` | `qa:create` | Start checks (seeds one check per ingredient) |
| `GET /approvals/:consignmentId` | `qa:read` | Approval status + `itemsByIngredient[]` + checks + proof |
| `PATCH /approvals/items/:checkItemId` | `qa:update` | Record PASS/FAIL + remarks for a check |
| `POST /approvals/:approvalId/checks` | `qa:create` | Add an extra, independent check to an ingredient |
| `POST /approvals/:approvalId/approve` | `qa:update` | Approve (all ingredients passed) |
| `POST /approvals/:approvalId/reject` | `qa:update` | Reject with a reason |
| `DELETE /approvals/:approvalId` | `qa:delete` | Delete checks, revert consignment to `RECEIVED` |
| `GET /pending` | `qa:read` | Consignments in `RECEIVED` / `QUALITY_PENDING` |
| `GET /approved` | `inventory:read` | Consignments in `QUALITY_APPROVED` |
| `GET /storage/status` | `qa:read` | Whether attachment storage is configured |
| `POST /checks/:checkItemId/attachments/presign` | `qa:update` | Signed upload URL |
| `POST /checks/:checkItemId/attachments` | `qa:update` | Register proof metadata after upload |
| `GET /checks/:checkItemId/attachments` | `qa:read` | List proof with signed read URLs |
| `GET /consignments/:consignmentId/attachments` | `qa:read` | All proof on a consignment |
| `DELETE /attachments/:attachmentId` | `qa:update` | Remove proof (blocked once approved) |

Uploads are capped at 10 MB and limited to images or PDFs.

## Frontend

- New view **Consignment QA** at `/quality/consignment-checks`
  (`src/modules/qa/ConsignmentQA.tsx`), reachable from the *Quality Assurance*
  sidebar group. It lists consignments awaiting QA, expands to show every
  ingredient and its checks, records PASS/FAIL with remarks, uploads proof, and
  performs consignment sign-off.
- The procurement **Consignments** view now shows each ingredient's QA status
  inline and links to the QA view (`?consignment=<id>`).

Roles with access to the QA view: `SUPER_ADMIN`, `EXECUTIVE_ADMIN`
(read-only), `QC` and `HEAD_OF_QC`. Deleting checks is restricted to `SUPER_ADMIN`
(`qa:delete`).

---

# QC roles, quantity approval & inspection report

## Roles

`QA_INSPECTOR` was renamed to **`QC`**, and **`HEAD_OF_QC`** was added. The
rename is applied with `ALTER TYPE ... RENAME VALUE`, so existing users keep
their assignment.

| Role | QA capabilities |
|---|---|
| `QC` | Runs checks, uploads proof, proposes quantity changes, signs off consignments |
| `HEAD_OF_QC` | Approves/rejects QC quantity changes; read access to QA + reports |
| `SUPER_ADMIN` | Everything (break-glass approver for quantity changes) |

The RBAC matrix is in `src/scripts/seed-rbac.ts` — run `pnpm db:seed` (or the
`seed-rbac` script) after deploying the migration.

## Quantity approval workflow

1. **QC** completes the checks for an ingredient, then submits a quantity change
   (`POST /quality/quantity-adjustments`) with a reason code (SHORTAGE, DAMAGE,
   OVERAGE, QUALITY_REJECT, RECOUNT). The change is `PENDING` and **blocks
   distribution** of that ingredient.
2. **Head of QC** reviews the queue (`GET /quality/quantity-adjustments/pending`)
   and approves or rejects.
3. On approval (`POST /quality/quantity-adjustments/:id/approve`, role-gated to
   `HEAD_OF_QC`/`SUPER_ADMIN`):
   - the ingredient's quantity becomes the new number;
   - if stock was already posted for the ingredient, an `ADJUSTMENT` ledger entry
     for exactly the delta is written (creating the ledger's `approvedById`);
   - if nothing was posted yet, no entry is written and the normal
     receipt/distribution path carries the new number — so it lands once.

Supporting schema: `quantity_adjustments`, `QuantityAdjustmentStatus`, and
`inventory_transactions.consignment_item_id` (links consignment stock to its
ingredient so deltas can be computed).

## Inspection report

`GET /quality/inspections/report` (permission `qa:read`) returns a single,
filterable feed of:

- consignment ingredient checks (`QualityCheckItem`),
- GRN / finished-batch inspections (`InspectionRecord`),
- QC quantity changes (proposed / approved / rejected),

plus a summary (totals, pass/fail/pending, by check type, by inspector, by day).
The admin view lives at **/reports/inspections** (`Inspection Report`) with CSV
export.

## Inventory-path fixes shipped alongside

These were required for the quantity workflow to be trustworthy:

- `goods_receipts.po_id` is now **nullable** — consignment-based GRNs have no
  Purchase Order (previously a literal `"consignment-based"` violated the FK).
- Consignment stock is posted **once**: the GRN-consignment path is authoritative
  and consignment-item-aware; `markDistributionComplete` only posts as a fallback
  when nothing is already in the ledger (removing a historical double-count).
- `DELETE /grn/:grnId` now matches the ledger by `referenceType: "GRN"`.
