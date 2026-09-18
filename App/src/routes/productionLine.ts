import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import * as productionLineService from "../services/productionLineService.js";

const router: Router = Router();
router.use(requireAuth);

function sendError(res: Response, error: any, fallback: string) {
  const message = error?.message || fallback;
  if (/not found/i.test(message)) return res.status(404).json({ error: message });
  if (/cannot|must|required|does not belong|not part of|only/i.test(message)) {
    return res.status(400).json({ error: message });
  }
  return res.status(500).json({ error: message });
}

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
 * POST /production-line/plans/:planId/issue
 * Body: { warehouseId, lines: [{ aggregatedIngredientId, quantity, batchLotId? }] }
 * Gated on `inventory:update` because it is a stock deduction.
 */
router.post(
  "/plans/:planId/issue",
  requirePermission("inventory", "update"),
  async (req: Request, res: Response) => {
    try {
      const { warehouseId, lines } = req.body;
      if (!warehouseId) return res.status(400).json({ error: "warehouseId is required" });
      if (!Array.isArray(lines) || lines.length === 0) {
        return res.status(400).json({ error: "lines must be a non-empty array" });
      }

      const plan = await productionLineService.issuePlanIngredients({
        planId: req.params.planId,
        warehouseId,
        lines: lines.map((l: any) => ({
          aggregatedIngredientId: l.aggregatedIngredientId,
          quantity: Number(l.quantity),
          batchLotId: l.batchLotId ?? null,
        })),
        issuedById: req.user!.id,
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
        remainderQuantity,
        remainders,
        inputs,
        machineId,
        batchNumber,
        productionDate,
        unitOfMeasure,
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
        productionDate,
        unitOfMeasure,
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
        warehouseId,
        batchNumber,
        expiryDate,
        productionDate,
        unitOfMeasure,
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
        warehouseId,
        batchNumber,
        expiryDate,
        productionDate,
        unitOfMeasure,
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

export default router;
