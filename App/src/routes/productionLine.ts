import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import * as productionLineService from "../services/productionLineService.js";
import * as productionStationService from "../services/productionStationService.js";

const router: Router = Router();
router.use(requireAuth);

function sendError(res: Response, error: any, fallback: string) {
  const message = error?.message || fallback;
  if (/not found/i.test(message)) return res.status(404).json({ error: message });
  if (/already used|already exists/i.test(message)) {
    return res.status(409).json({ error: message });
  }
  if (/cannot|must|required|does not belong|not part of|only/i.test(message)) {
    return res.status(400).json({ error: message });
  }
  return res.status(500).json({ error: message });
}

// ---------------------------------------------------------------------------
// Grinding batch serial
// ---------------------------------------------------------------------------

/**
 * GET /production-line/grinding-batch-sequence
 * `lastNumber` is null until the operator seeds it; `nextNumber` is what the
 * next grinding record will get.
 */
router.get(
  "/grinding-batch-sequence",
  requirePermission("production", "read"),
  async (_req: Request, res: Response) => {
    try {
      const sequence = await productionLineService.getGrindingBatchSequence();
      res.json(sequence);
    } catch (error: any) {
      console.error("GET /production-line/grinding-batch-sequence error:", error);
      sendError(res, error, "Failed to load the grinding batch sequence");
    }
  }
);

/**
 * PUT /production-line/grinding-batch-sequence
 * The grinding manager seeds/corrects the last used number.
 */
router.put(
  "/grinding-batch-sequence",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const { lastNumber } = req.body ?? {};
      if (lastNumber === undefined || lastNumber === null || lastNumber === "") {
        return res.status(400).json({ error: "lastNumber is required" });
      }
      const sequence = await productionLineService.setGrindingBatchSequence(Number(lastNumber));
      res.json(sequence);
    } catch (error: any) {
      console.error("PUT /production-line/grinding-batch-sequence error:", error);
      sendError(res, error, "Failed to update the grinding batch sequence");
    }
  }
);

// ---------------------------------------------------------------------------
// Views / queues
// ---------------------------------------------------------------------------

/**
 * GET /production-line/plans — active plans with per-station progress.
 */
router.get(
  "/plans",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const plans = await productionLineService.getProductionLinePlans({
        status: req.query.status as string | undefined,
      });
      res.json({ plans });
    } catch (error: any) {
      console.error("GET /production-line/plans error:", error);
      sendError(res, error, "Failed to load production plans");
    }
  }
);

/**
 * GET /production-line/queue?station=ISSUE|GRINDING|FINISHING
 */
router.get(
  "/queue",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const station = String(req.query.station || "").toUpperCase();
      if (!["ISSUE", "GRINDING", "FINISHING"].includes(station)) {
        return res
          .status(400)
          .json({ error: "station must be one of ISSUE, GRINDING, FINISHING" });
      }
      const plans = await productionLineService.getStationQueue(
        station as "ISSUE" | "GRINDING" | "FINISHING"
      );
      res.json({ plans });
    } catch (error: any) {
      console.error("GET /production-line/queue error:", error);
      sendError(res, error, "Failed to load the station queue");
    }
  }
);

/**
 * GET /production-line/daily-records?from=&to=
 * One entry per production date: expected vs achieved per arm, plus WIP.
 */
router.get(
  "/daily-records",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const days = await productionLineService.getDailyRecords({
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      });
      res.json({ days });
    } catch (error: any) {
      console.error("GET /production-line/daily-records error:", error);
      sendError(res, error, "Failed to load daily production records");
    }
  }
);

/**
 * GET /production-line/plans/:planId/flow
 * Expected / received / processed / transferred / outstanding / WIP per station.
 */
router.get(
  "/plans/:planId/flow",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const flow = await productionStationService.getStationFlow(req.params.planId);
      res.json({ flow });
    } catch (error: any) {
      console.error("GET /production-line/plans/:planId/flow error:", error);
      sendError(res, error, "Failed to load the station flow");
    }
  }
);

/**
 * GET /production-line/wip?status=&station=&planId=&from=&to=
 */
router.get(
  "/wip",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const result = await productionStationService.getWorkInProgress({
        status: req.query.status ? String(req.query.status).toUpperCase() : undefined,
        station: req.query.station ? String(req.query.station).toUpperCase() : undefined,
        planId: req.query.planId ? String(req.query.planId) : undefined,
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      });
      res.json(result);
    } catch (error: any) {
      console.error("GET /production-line/wip error:", error);
      sendError(res, error, "Failed to load work in progress");
    }
  }
);

/**
 * POST /production-line/wip/:id/transfer
 * Body: { quantity, notes? } — moves outstanding WIP to the next station.
 */
router.post(
  "/wip/:id/transfer",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const { quantity, notes } = req.body ?? {};
      if (quantity === undefined || quantity === null || quantity === "") {
        return res.status(400).json({ error: "quantity is required" });
      }
      const entry = await productionStationService.transferWorkInProgress({
        id: req.params.id,
        quantity: Number(quantity),
        notes: notes ? String(notes) : undefined,
        userId: req.user!.id,
      });
      res.json({ message: "WIP transferred to the next station", entry });
    } catch (error: any) {
      console.error("POST /production-line/wip/:id/transfer error:", error);
      sendError(res, error, "Failed to transfer WIP");
    }
  }
);

/**
 * GET /production-line/plans/:planId — full station view for one plan.
 */
router.get(
  "/plans/:planId",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const plan = await productionLineService.getPlanStationView(req.params.planId);
      res.json({ plan });
    } catch (error: any) {
      console.error("GET /production-line/plans/:planId error:", error);
      sendError(res, error, "Failed to load the plan");
    }
  }
);

// ---------------------------------------------------------------------------
// Station 1 — Stock Manager issues ingredients
// ---------------------------------------------------------------------------

/**
 * GET /production-line/releases
 * Every ingredient release line, newest first — the Ingredients Station record.
 */
router.get(
  "/releases",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const releases = await productionLineService.getReleaseHistory({
        planId: req.query.planId ? String(req.query.planId) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.json({ releases });
    } catch (error: any) {
      console.error("GET /production-line/releases error:", error);
      sendError(res, error, "Failed to load the release records");
    }
  }
);

/**
 * POST /production-line/plans/:planId/issue
 * Releases ingredients to grinding and deducts them from stock (earliest-expiry
 * lots first, across every warehouse). Body: `{ lines: [{ aggregatedIngredientId,
 * quantity }] }` for a partial release; omit `lines` to release everything
 * outstanding. Gated on `inventory:update` because it is the deduction point.
 */
router.post(
  "/plans/:planId/issue",
  requirePermission("inventory", "update"),
  async (req: Request, res: Response) => {
    try {
      const { lines, warehouseId } = req.body ?? {};
      const plan = await productionLineService.issuePlanIngredients({
        planId: req.params.planId,
        issuedById: req.user!.id,
        warehouseId: warehouseId ? String(warehouseId) : undefined,
        lines: Array.isArray(lines)
          ? lines.map((line: any) => ({
              aggregatedIngredientId: String(line.aggregatedIngredientId),
              quantity: Number(line.quantity),
            }))
          : undefined,
      });

      res.status(201).json({ message: "Ingredients issued to production", plan });
    } catch (error: any) {
      console.error("POST /production-line/plans/:planId/issue error:", error);
      sendError(res, error, "Failed to issue ingredients");
    }
  }
);

// ---------------------------------------------------------------------------
// Station 2 — Grinding supervisor
// ---------------------------------------------------------------------------

/**
 * POST /production-line/plans/:planId/items/:itemId/grinding
 * Body: { inputQuantity, achievedQuantity, remainderQuantity?,
 *         remainders?: [{ materialId, quantity, batchLotId?, warehouseId? }],
 *         machineId?, batchNumber?, productionDate?, unitOfMeasure?, remarks? }
 */
router.post(
  "/plans/:planId/items/:itemId/grinding",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const {
        inputQuantity,
        achievedQuantity,
        receivedQuantity,
        batchesProcessed,
        remainderQuantity,
        remainders,
        inputs,
        machineId,
        batchNumber,
        grindingBatchNumber,
        mixUnits,
        productionDate,
        remarks,
      } = req.body;

      if (inputQuantity === undefined || achievedQuantity === undefined) {
        return res
          .status(400)
          .json({ error: "inputQuantity and achievedQuantity are required" });
      }

      const plan = await productionLineService.submitGrindingRecord({
        planId: req.params.planId,
        planItemId: req.params.itemId,
        inputQuantity: Number(inputQuantity),
        achievedQuantity: Number(achievedQuantity),
        receivedQuantity:
          receivedQuantity === undefined ? undefined : Number(receivedQuantity),
        batchesProcessed:
          batchesProcessed === undefined ? undefined : Number(batchesProcessed),
        remainderQuantity:
          remainderQuantity === undefined ? undefined : Number(remainderQuantity),
        remainders: Array.isArray(remainders)
          ? remainders.map((r: any) => ({
              materialId: r.materialId,
              quantity: Number(r.quantity),
              batchLotId: r.batchLotId ?? null,
              warehouseId: r.warehouseId ?? null,
            }))
          : undefined,
        inputs: Array.isArray(inputs)
          ? inputs.map((r: any) => ({
              materialId: r.materialId,
              quantity: Number(r.quantity),
              batchLotId: r.batchLotId ?? null,
            }))
          : undefined,
        machineId: machineId ?? null,
        batchNumber: batchNumber ?? null,
        grindingBatchNumber: grindingBatchNumber ?? null,
        mixUnits: mixUnits === undefined ? undefined : Number(mixUnits),
        productionDate,
        remarks,
        recordedById: req.user!.id,
      });

      res.status(201).json({ message: "Grinding recorded", plan });
    } catch (error: any) {
      console.error("POST /production-line/plans/:planId/items/:itemId/grinding error:", error);
      sendError(res, error, "Failed to record grinding");
    }
  }
);

// ---------------------------------------------------------------------------
// Station 3 — Production supervisor
// ---------------------------------------------------------------------------

/**
 * POST /production-line/plans/:planId/items/:itemId/finishing
 * Body: { achievedQuantity, remainderQuantity?, warehouseId, batchNumber,
 *         expiryDate?, productionDate?, unitOfMeasure?, remarks? }
 */
router.post(
  "/plans/:planId/items/:itemId/finishing",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const {
        achievedQuantity,
        remainderQuantity,
        carryoverUsedQuantity,
        rejectedQuantity,
        warehouseId,
        batchNumber,
        expiryDate,
        productionDate,
        remarks,
      } = req.body;

      if (achievedQuantity === undefined) {
        return res.status(400).json({ error: "achievedQuantity is required" });
      }

      const plan = await productionLineService.submitFinishingRecord({
        planId: req.params.planId,
        planItemId: req.params.itemId,
        achievedQuantity: Number(achievedQuantity),
        remainderQuantity:
          remainderQuantity === undefined ? undefined : Number(remainderQuantity),
        carryoverUsedQuantity:
          carryoverUsedQuantity === undefined ? undefined : Number(carryoverUsedQuantity),
        rejectedQuantity:
          rejectedQuantity === undefined ? undefined : Number(rejectedQuantity),
        warehouseId,
        batchNumber,
        expiryDate,
        productionDate,
        remarks,
        recordedById: req.user!.id,
      });

      res.status(201).json({ message: "Finished output recorded", plan });
    } catch (error: any) {
      console.error("POST /production-line/plans/:planId/items/:itemId/finishing error:", error);
      sendError(res, error, "Failed to record finished output");
    }
  }
);

/**
 * POST /production-line/plans/:planId/close-outstanding
 * Explicit reconciliation of unfinished production quantities.
 */
router.post(
  "/plans/:planId/close-outstanding",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const { reason } = req.body ?? {};
      if (!reason || !String(reason).trim()) {
        return res.status(400).json({ error: "reason is required" });
      }
      const result = await productionLineService.closePlanOutstanding({
        planId: req.params.planId,
        userId: req.user!.id,
        reason: String(reason),
      });
      res.json({ message: "Outstanding production closed", ...result });
    } catch (error: any) {
      console.error("POST /production-line/plans/:planId/close-outstanding error:", error);
      sendError(res, error, "Failed to close outstanding production");
    }
  }
);

/**
 * PATCH /production-line/stage-records/:id/status
 * Manager sign-off on a submitted grinding/finishing record.
 */
router.patch(
  "/stage-records/:id/status",
  requirePermission("production", "approve"),
  async (req: Request, res: Response) => {
    try {
      const { status, notes } = req.body;
      if (!status) return res.status(400).json({ error: "status is required" });

      const record = await productionLineService.setStageRecordStatus(
        req.params.id,
        status,
        req.user!.id,
        notes
      );

      res.json({ message: `Stage record ${status.toLowerCase()}`, data: record });
    } catch (error: any) {
      console.error("PATCH /production-line/stage-records/:id/status error:", error);
      sendError(res, error, "Failed to update stage record");
    }
  }
);

export default router;
