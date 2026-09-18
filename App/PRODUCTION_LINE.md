# Production Line — three-station hand-off

Once a Production Manager creates and schedules a plan, the work flows through
three stations. Each has its own role and screen.

```
PM creates plan (DRAFT) ──schedule──▶ SCHEDULED
      │
      ▼
1. STOCK MANAGER (STORE_OFFICER)      /production/stock-issue
   sees the plan's aggregated ingredient list, picks a warehouse / batch lots,
   deducts the quantities  → plan becomes IN_PROGRESS
      │
      ▼
2. GRINDING SUPERVISOR (GRINDING_SUPERVISOR)   /production/grinding
   per batch: actual ground output for the day + unused ingredients returned
      │
      ▼
3. PRODUCTION SUPERVISOR (PRODUCTION_SUPERVISOR)  /production/finishing
   per batch: required vs achieved finished output, receives stock,
   records unused ground batches  → plan becomes COMPLETED
```

## Station 1 — Stock Manager

- Sees every aggregated ingredient for the plan (`plan_aggregated_ingredients`),
  the required vs already-issued quantity, and (optionally) a batch lot per line.
- Submitting posts a **negative `PROD_CONSUMPTION`** ledger entry per line
  (`referenceType: "PLAN_ISSUE"`), stamps the aggregated line as `RELEASED` and
  moves the plan to `IN_PROGRESS`.
- Gated on `inventory:update` (it is a stock deduction), which `STORE_OFFICER` holds.

`POST /api/production-line/plans/:planId/issue`
`{ warehouseId, lines: [{ aggregatedIngredientId, quantity, batchLotId? }] }`

## Station 2 — Grinding Supervisor

- Receives the plan's batches (one per plan item) that are awaiting grinding.
- Records `inputQuantity`, `achievedQuantity`, and any **unused ingredients**
  (`remainders: [{ materialId, quantity, batchLotId? }]`).
- Each remainder is posted back to stock as a **positive `ADJUSTMENT`**
  (`referenceType: "PLAN_RETURN"`) into the warehouse the material was issued
  from, and the aggregated line's `returnedQuantity` is increased.

`POST /api/production-line/plans/:planId/items/:itemId/grinding`

## Station 3 — Production Supervisor

- Receives batches that have been ground but not yet finished, with the
  **required finished-goods output** (plan item `targetQuantity`) and the
  **ground quantity available**.
- Records `achievedQuantity`, `remainderQuantity` (unused ground batches) and the
  receiving warehouse + finished batch number.
- Achieved output creates a finished `BatchLot` (`QUARANTINE`), posts a positive
  **`PROD_OUTPUT`**, and raises a `FINISHED_BATCH` QA inspection — so the finished
  goods enter the existing QA release flow.
- When every plan item has a finishing record, the plan is marked `COMPLETED`.

`POST /api/production-line/plans/:planId/items/:itemId/finishing`

## Shared endpoints

| Method + path | Permission | Purpose |
|---|---|---|
| `GET /production-line/plans` | `production:read` | Active plans with per-station progress |
| `GET /production-line/queue?station=ISSUE\|GRINDING\|FINISHING` | `production:read` | The work queue for a station |
| `GET /production-line/plans/:planId` | `production:read` | Full station view for one plan |

## Schema

- `plan_aggregated_ingredients` gained issuance tracking: `issued_quantity`,
  `issued_warehouse_id`, `issued_batch_lot_id`, `issued_at`, `issued_by_id`,
  `returned_quantity`.
- `ProductionStage` (`GRINDING`, `FINISHING`) + `ProductionStageStatus`.
- `production_stage_records` — one row per batch per station (input / achieved /
  remainder, machine, warehouse, finished batch lot, remarks).
- `production_stage_remainders` — per-material unused quantities, each linked to
  the ledger entry that returned it to stock.

## Notes

- **Canonical consumption (enforced).** For any production order allocated to a
  plan item (`BatchMachineAllocation`), the plan's **Stock Issue** station is the
  single path that deducts stock. `POST /production/production-orders/:id/release`
  still records the order's ingredient tracking and moves it to `RELEASED`, but
  posts **no ledger entry** for plan-linked orders, and returns
  `{ stockDeducted: false }`. Standalone orders (no plan allocation) keep
  releasing and deducting as before. The production-orders API exposes
  `planLinked` / `planNumber`, and the UI shows “Issue via Stock Issue” instead
  of a Release button for those orders.
- Finished output still passes through QA (`FINISHED_BATCH` inspections) before
  the batch is released from `QUARANTINE`, unchanged from before.
- `ProductionStageStatus` currently defaults to `SUBMITTED`; `VERIFIED`/`FLAGGED`
  are reserved for a future supervisor sign-off step.

## Traceability

The grinding station records **which batch lots it consumed** (`inputs`), stored in
`production_grinding_inputs`. That is what lets a finished batch trace to the
*specific* raw batches it was made from (instead of "whatever was issued to the
plan"). If a grinding record has no inputs, trace falls back to the plan-level
`PLAN_ISSUE` ledger.

Endpoints (`production:read`):

| Method + path | Purpose |
|---|---|
| `GET /api/traceability/search?q=` | Universal search by batch number, material name or SKU |
| `GET /api/traceability/batch/:batchId` | Full upstream + downstream tree |
| `GET /api/traceability/batch?batchNumber=` | Lookup by number (409 + candidates if ambiguous) |

The tree resolves **both** production paths (production order and production
plan), inbound receipts via **PO or Consignment** (`goods_receipts.consignment_id`),
grinding/finishing stages, remainders, finished-batch consumers (forward trace)
and the batch's stock movements.

The old `/api/production/trace*` endpoints were removed; the Traceability screen
now uses `/api/traceability`.
