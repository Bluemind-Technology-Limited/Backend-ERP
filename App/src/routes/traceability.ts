import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import * as traceabilityService from "../services/traceabilityService.js";

const router: Router = Router();
router.use(requireAuth);

/**
 * GET /traceability/search?q=...&limit=
 * Universal trace search — matches batch number, material name or SKU, so any
 * ingredient, raw material or finished good can be used as the trace root.
 */
router.get(
  "/search",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const { q, limit } = req.query;
      const matches = await traceabilityService.searchBatchLots(
        String(q ?? ""),
        limit ? parseInt(String(limit)) : 25
      );
      res.json({ matches });
    } catch (error: any) {
      console.error("GET /traceability/search error:", error);
      res.status(500).json({ error: error?.message || "Failed to search batches" });
    }
  }
);

/**
 * GET /traceability/batch/:batchId — full bidirectional trace tree.
 */
router.get(
  "/batch/:batchId",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const tree = await traceabilityService.buildTraceTree(req.params.batchId);
      if (!tree) return res.status(404).json({ error: "Batch not found" });
      res.json({ tree });
    } catch (error: any) {
      console.error("GET /traceability/batch/:batchId error:", error);
      res.status(500).json({ error: error?.message || "Failed to build trace" });
    }
  }
);

/**
 * GET /traceability/batch?batchNumber=... — convenience lookup by batch number.
 * Batch numbers are only unique per material, so if several match we tell the
 * caller rather than guessing.
 */
router.get(
  "/batch",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const batchNumber = String(req.query.batchNumber ?? "").trim();
      if (!batchNumber) {
        return res.status(400).json({ error: "batchNumber query is required" });
      }

      const matches = await traceabilityService.searchBatchLots(batchNumber, 25);
      const exact = matches.filter((m) => m.batchNumber === batchNumber);

      if (exact.length === 0) {
        return res.status(404).json({ error: "Batch not found" });
      }
      if (exact.length > 1) {
        return res.status(409).json({
          error: "Multiple batches share this number — pick the material.",
          matches: exact,
        });
      }

      const tree = await traceabilityService.buildTraceTree(exact[0].id);
      res.json({ tree });
    } catch (error: any) {
      console.error("GET /traceability/batch error:", error);
      res.status(500).json({ error: error?.message || "Failed to build trace" });
    }
  }
);

export default router;
