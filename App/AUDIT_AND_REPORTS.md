# Audit & Report

Two date-filtered reports, assembled from the **domain tables** — deliberately
not from `UserActivity`, whose global middleware no-ops because it is registered
before `requireAuth` (so `req.user` is always undefined and only explicit
`logActivity` calls populate it).

## Endpoints (`reports:read`)

| Method + path | Purpose |
|---|---|
| `GET /api/reports/production-flow?dateFrom&dateTo&planId&status&limit` | Whole production flow per plan |
| `GET /api/reports/erp-activity?dateFrom&dateTo&entity&userId&limit` | Unified ERP activity feed |

### Production flow

Per plan: items with **target / ground / achieved / variance**, the ingredient
issue (required / issued / returned per material), the plan's ledger movements
(`PLAN_ISSUE`, `PLAN_RETURN`, `PLAN_FINISHING`) and the finished-batch QA
inspections. Summary: plans by status, batch count, totals for target, achieved,
issued, returned and grinding remainder.

### ERP activity

One normalised, timestamp-sorted feed merging:

- stock movements (`InventoryTransaction`)
- production stages (`ProductionStageRecord` — grinding / finishing)
- QA checks (`QualityCheckItem`) and inspections (`InspectionRecord`)
- quantity adjustments (`QuantityAdjustment`)
- goods receipts (`GoodsReceipt`)
- consignments (`Consignment`)

with module/entity filters and a per-module summary.

## Frontend

`Audit & Report` at **/reports/audit** (`modules/reports/views/AuditReport.tsx`):
date + module filters, two tabs (Production flow with expandable per-plan
detail; ERP activity as a filterable table), CSV export, and KPI summaries.
Visible to `SUPER_ADMIN`, `EXECUTIVE_ADMIN` and `PRODUCTION_MANAGER`.

## Buffer memory (part 1 — FIFO on issue)

`getStock` now also returns `manufacturingDate` / `expiryDate`, and the Stock
Issue screen:

- sorts batch lots **oldest-manufactured first, then soonest-expiring** (unknowns last),
- **auto-selects the oldest available batch** per ingredient once a warehouse is chosen,
- shows an **Available** column per ingredient so existing stock (including
  remainders previously returned to store) is consumed before anything newer.

## Buffer memory (part 2 — WIP carryover)

Unused **ground** output is tracked as a computed pool per BOM — no new material,
no BatchLot, no ledger entry:

- `production_stage_records.carryover_used_quantity` records how much of a
  previous batch's remainder a finishing run drew on.
- `availableCarryover(bomId) = Σ(finishing.remainder) − Σ(finishing.carryoverUsed)`.
- The Finishing station shows *“Unfinished from previous batches: X”* with a
  **Use now** field; the service rejects a draw larger than what's available.
- `carryoverAvailable` is returned per item by the production-line API.

## Stage sign-off & KPIs

- `PATCH /api/production-line/stage-records/:id/status` (`production:approve`) sets
  a grinding/finishing record to `VERIFIED` or `FLAGGED` — the enum already
  existed, so no migration was needed.
- The Audit & Report production-flow drill-down lists each stage record with its
  status and **Verify / Flag** buttons (visible to `SUPER_ADMIN` and
  `PRODUCTION_MANAGER`).
- Yields are computed, not stored: `grindingYield% = grinding.achieved / input`,
  `finishingYield% = finishing.achieved / item.target`, plus remainder % on both
  stages. They appear per item in the flow table and as an average KPI.
