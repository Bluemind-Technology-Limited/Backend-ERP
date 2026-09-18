/**
 * Cost Management Routes
 * Handles all cost modification, approval, and audit operations
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import * as costService from "../services/costManagementService.js";
import * as userActivityLogger from "../services/userActivityLogger.js";
import { prisma } from "../lib/db.js";

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Cost Change Requests
// ---------------------------------------------------------------------------

/**
 * POST /cost-management/request-change — Request a cost modification
 * Body: { entityType, entityId, fieldName, oldValue, newValue, reason? }
 */
router.post("/request-change", requirePermission("cost_management", "update"), async (req: Request, res: Response) => {
  try {
    const { entityType, entityId, fieldName, oldValue, newValue, reason } = req.body;

    if (!entityType || !entityId || !fieldName || newValue === undefined) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const result = await costService.requestCostChange({
      entityType,
      entityId,
      fieldName,
      oldValue: oldValue ? Number(oldValue) : null,
      newValue: Number(newValue),
      reason,
      changeType: "MANUAL",
      requestedBy: req.user!.id,
    });

    // Log the activity
    await userActivityLogger.logActivity({
      userId: req.user!.id,
      activityType: result.requiresApproval ? "UPDATE" : "APPROVE",
      module: "cost_management",
      description: `${result.requiresApproval ? "Requested" : "Applied"} cost change to ${entityType}`,
      entityType: "CostAudit",
      entityId: result.audit.id,
      details: {
        entityType,
        entityId,
        fieldName,
        oldValue,
        newValue,
        requiresApproval: result.requiresApproval,
        variancePercent: result.variancePercent,
      },
    });

    res.status(201).json(result);
  } catch (error: any) {
    console.error("POST /cost-management/request-change error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});

// ---------------------------------------------------------------------------
// Cost Approvals
// ---------------------------------------------------------------------------

/**
 * GET /cost-management/pending-approvals — Get pending cost approvals
 */
router.get("/pending-approvals", requirePermission("cost_management", "approve"), async (req: Request, res: Response) => {
  try {
    const { limit } = req.query;
    const approvals = await costService.getPendingApprovals(req.user!.id, limit ? parseInt(limit as string) : 50);
    res.json({ approvals });
  } catch (error: any) {
    console.error("GET /cost-management/pending-approvals error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});

/**
 * POST /cost-management/approvals/:auditId/approve — Approve a cost change
 * Body: { approved: boolean, rejectionReason?: string }
 */
router.post(
  "/approvals/:auditId/approve",
  requirePermission("cost_management", "approve"),
  async (req: Request, res: Response) => {
    try {
      const { auditId } = req.params;
      const { approved, rejectionReason } = req.body;

      if (approved === undefined) {
        return res.status(400).json({ error: "approved field is required" });
      }

      const updated = await costService.approveCostChange(
        auditId,
        req.user!.id,
        approved ? undefined : rejectionReason
      );

      // Log the approval/rejection
      await userActivityLogger.logActivity({
        userId: req.user!.id,
        activityType: approved ? "APPROVE" : "REJECT",
        module: "cost_management",
        description: `${approved ? "Approved" : "Rejected"} cost change request`,
        entityType: "CostAudit",
        entityId: auditId,
        details: {
          decision: approved ? "APPROVED" : "REJECTED",
          rejectionReason,
        },
      });

      res.json({ audit: updated });
    } catch (error: any) {
      console.error("POST /cost-management/approvals/:auditId/approve error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

// ---------------------------------------------------------------------------
// Cost History & Reports
// ---------------------------------------------------------------------------

/**
 * GET /cost-management/history/:entityType/:entityId — Get cost change history
 */
router.get(
  "/history/:entityType/:entityId",
  requirePermission("cost_management", "read"),
  async (req: Request, res: Response) => {
    try {
      const { entityType, entityId } = req.params;
      const { limit } = req.query;

      const history = await costService.getCostHistory(entityType, entityId, limit ? parseInt(limit as string) : 50);
      res.json({ history });
    } catch (error: any) {
      console.error("GET /cost-management/history/:entityType/:entityId error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /cost-management/audit-summary — Get cost audit statistics
 */
router.get("/audit-summary", requirePermission("cost_management", "read"), async (req: Request, res: Response) => {
  try {
    const { days } = req.query;
    const summary = await costService.getCostAuditSummary(days ? parseInt(days as string) : 30);
    res.json(summary);
  } catch (error: any) {
    console.error("GET /cost-management/audit-summary error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});

/**
 * GET /cost-management/material/:materialId/cost-info — Get material cost information
 */
router.get(
  "/material/:materialId/cost-info",
  requirePermission("cost_management", "read"),
  async (req: Request, res: Response) => {
    try {
      const { materialId } = req.params;
      const info = await costService.getMaterialCostInfo(materialId);
      res.json(info);
    } catch (error: any) {
      console.error("GET /cost-management/material/:materialId/cost-info error:", error);
      res.status(error?.message?.includes("not found") ? 404 : 500).json({ error: error?.message || "Database error" });
    }
  }
);

// ---------------------------------------------------------------------------
// PO Item Cost Modification
// ---------------------------------------------------------------------------

/**
 * PATCH /cost-management/po-items/:poItemId/cost — Update PO item cost
 * Body: { unitCost, reason? }
 */
router.patch(
  "/po-items/:poItemId/cost",
  requirePermission("cost_management", "update"),
  async (req: Request, res: Response) => {
    try {
      const { poItemId } = req.params;
      const { unitCost, reason } = req.body;

      if (unitCost === undefined) {
        return res.status(400).json({ error: "unitCost is required" });
      }

      // Get current cost
      const current = await prisma.purchaseOrderItem.findUnique({
        where: { id: poItemId },
      });

      if (!current) {
        return res.status(404).json({ error: "PO item not found" });
      }

      // Request cost change
      const result = await costService.requestCostChange({
        entityType: "PurchaseOrderItem",
        entityId: poItemId,
        fieldName: "unitCost",
        oldValue: Number(current.unitCost),
        newValue: Number(unitCost),
        reason,
        changeType: "MANUAL",
        requestedBy: req.user!.id,
      });

      res.json(result);
    } catch (error: any) {
      console.error("PATCH /cost-management/po-items/:poItemId/cost error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

// ---------------------------------------------------------------------------
// Material Standard Cost
// ---------------------------------------------------------------------------

/**
 * PATCH /cost-management/materials/:materialId/standard-cost — Update material standard cost
 * Body: { standardCost, reason? }
 */
router.patch(
  "/materials/:materialId/standard-cost",
  requirePermission("cost_management", "update"),
  async (req: Request, res: Response) => {
    try {
      const { materialId } = req.params;
      const { standardCost, reason } = req.body;

      if (standardCost === undefined) {
        return res.status(400).json({ error: "standardCost is required" });
      }

      const current = await prisma.material.findUnique({
        where: { id: materialId },
      });

      if (!current) {
        return res.status(404).json({ error: "Material not found" });
      }

      const result = await costService.requestCostChange({
        entityType: "Material",
        entityId: materialId,
        fieldName: "standardCost",
        oldValue: current.standardCost ? Number(current.standardCost) : null,
        newValue: Number(standardCost),
        reason,
        changeType: "MANUAL",
        requestedBy: req.user!.id,
      });

      res.json(result);
    } catch (error: any) {
      console.error("PATCH /cost-management/materials/:materialId/standard-cost error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

export default router;
