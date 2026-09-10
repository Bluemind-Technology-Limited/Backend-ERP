import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import * as qualityApprovalService from "../services/qualityApprovalService.js";

const router: Router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Quality Approval Management Endpoints
// ---------------------------------------------------------------------------

/**
 * POST /quality/approvals/initiate
 * Initiate QA checks for a consignment (consignment must be in RECEIVED status)
 * QA Inspector starts the quality approval process
 */
router.post(
  "/approvals/initiate",
  requirePermission("qa", "create"),
  async (req: Request, res: Response) => {
    try {
      const { consignmentId } = req.body;

      if (!consignmentId) {
        return res.status(400).json({ error: "consignmentId is required" });
      }

      const result = await qualityApprovalService.initiateQualityCheck(
        (req as any).prisma,
        consignmentId,
        (req as any).user.id
      );

      res.status(201).json({
        message: "Quality checks initiated",
        data: result,
      });
    } catch (error: any) {
      console.error("POST /quality/approvals/initiate error:", error);
      res.status(400).json({ error: error?.message || "Failed to initiate quality checks" });
    }
  }
);

/**
 * GET /quality/approvals/:consignmentId
 * Get quality approval status for a consignment
 */
router.get(
  "/approvals/:consignmentId",
  requirePermission("qa", "read"),
  async (req: Request, res: Response) => {
    try {
      const status = await qualityApprovalService.getQualityStatus(
        (req as any).prisma,
        req.params.consignmentId
      );

      if (!status) {
        return res.status(404).json({ error: "Quality approval not found for this consignment" });
      }

      res.json({ data: status });
    } catch (error: any) {
      console.error("GET /quality/approvals/:consignmentId error:", error);
      res.status(500).json({ error: error?.message || "Failed to get quality status" });
    }
  }
);

/**
 * PATCH /quality/approvals/items/:checkItemId
 * Update a quality check item with result (PASS/FAIL)
 */
router.patch(
  "/approvals/items/:checkItemId",
  requirePermission("qa", "update"),
  async (req: Request, res: Response) => {
    try {
      const { checkType, result, remarks } = req.body;

      if (!checkType || !result) {
        return res.status(400).json({ error: "checkType and result (PASS/FAIL) are required" });
      }

      if (!["PASS", "FAIL"].includes(result)) {
        return res.status(400).json({ error: "result must be PASS or FAIL" });
      }

      const updatedItem = await qualityApprovalService.updateCheckItem(
        (req as any).prisma,
        req.params.checkItemId,
        {
          checkType,
          result,
          remarks,
          inspectorId: (req as any).user.id,
        }
      );

      res.json({
        message: "Quality check item updated",
        data: updatedItem,
      });
    } catch (error: any) {
      console.error("PATCH /quality/approvals/items/:checkItemId error:", error);
      res.status(400).json({ error: error?.message || "Failed to update check item" });
    }
  }
);

/**
 * POST /quality/approvals/:approvalId/approve
 * Approve consignment for release (all items passed)
 * Only QA can approve, making consignment accessible to stock manager
 */
router.post(
  "/approvals/:approvalId/approve",
  requirePermission("qa", "update"),
  async (req: Request, res: Response) => {
    try {
      const { notes } = req.body;

      const result = await qualityApprovalService.approveConsignment(
        (req as any).prisma,
        req.params.approvalId,
        {
          approverUserId: (req as any).user.id,
          notes,
        }
      );

      res.json({
        message: "Consignment approved for release - stock manager can now access",
        data: result,
      });
    } catch (error: any) {
      console.error("POST /quality/approvals/:approvalId/approve error:", error);
      res.status(400).json({ error: error?.message || "Failed to approve consignment" });
    }
  }
);

/**
 * POST /quality/approvals/:approvalId/reject
 * Reject consignment due to failed QA checks
 * Consignment remains blocked until resubmitted
 */
router.post(
  "/approvals/:approvalId/reject",
  requirePermission("qa", "update"),
  async (req: Request, res: Response) => {
    try {
      const { rejectionReason, notes } = req.body;

      if (!rejectionReason) {
        return res.status(400).json({ error: "rejectionReason is required" });
      }

      const result = await qualityApprovalService.rejectConsignment(
        (req as any).prisma,
        req.params.approvalId,
        {
          rejectorUserId: (req as any).user.id,
          rejectionReason,
          notes,
        }
      );

      res.json({
        message: "Consignment rejected - remains blocked from stock manager access",
        data: result,
      });
    } catch (error: any) {
      console.error("POST /quality/approvals/:approvalId/reject error:", error);
      res.status(400).json({ error: error?.message || "Failed to reject consignment" });
    }
  }
);

/**
 * GET /quality/approvals/:approvalId/failed-items
 * Get all failed QA check items for a consignment
 */
router.get(
  "/approvals/:approvalId/failed-items",
  requirePermission("qa", "read"),
  async (req: Request, res: Response) => {
    try {
      const failedItems = await qualityApprovalService.getFailedItems(
        (req as any).prisma,
        req.params.approvalId
      );

      res.json({
        data: failedItems,
        count: failedItems.length,
      });
    } catch (error: any) {
      console.error("GET /quality/approvals/:approvalId/failed-items error:", error);
      res.status(500).json({ error: error?.message || "Failed to get failed items" });
    }
  }
);

/**
 * GET /quality/approvals/:consignmentId/report
 * Generate comprehensive QA report for a consignment
 */
router.get(
  "/approvals/:consignmentId/report",
  requirePermission("qa", "read"),
  async (req: Request, res: Response) => {
    try {
      const report = await qualityApprovalService.generateQualityReport(
        (req as any).prisma,
        req.params.consignmentId
      );

      res.json({ data: report });
    } catch (error: any) {
      console.error("GET /quality/approvals/:consignmentId/report error:", error);
      res.status(400).json({ error: error?.message || "Failed to generate report" });
    }
  }
);

// ---------------------------------------------------------------------------
// Dashboard Endpoints
// ---------------------------------------------------------------------------

/**
 * GET /quality/pending
 * Get list of consignments awaiting QA approval
 * Visible in QA Inspector dashboard
 */
router.get(
  "/pending",
  requirePermission("qa", "read"),
  async (req: Request, res: Response) => {
    try {
      const { page = 1, limit = 20 } = req.query;
      const pageNum = parseInt(page as string) || 1;
      const limitNum = parseInt(limit as string) || 20;
      const offset = (pageNum - 1) * limitNum;

      const result = await qualityApprovalService.getConsignmentsAwaitingQA(
        (req as any).prisma,
        limitNum,
        offset
      );

      res.json({
        consignments: result.consignments,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: result.pagination.total,
          pages: result.pagination.pages,
        },
      });
    } catch (error: any) {
      console.error("GET /quality/pending error:", error);
      res.status(500).json({ error: error?.message || "Failed to get pending consignments" });
    }
  }
);

/**
 * GET /quality/approved
 * Get list of approved consignments ready for stock manager access
 * Stock manager uses this to see what can be distributed
 */
router.get(
  "/approved",
  requirePermission("inventory", "read"),
  async (req: Request, res: Response) => {
    try {
      const { page = 1, limit = 20 } = req.query;
      const pageNum = parseInt(page as string) || 1;
      const limitNum = parseInt(limit as string) || 20;
      const offset = (pageNum - 1) * limitNum;

      const result = await qualityApprovalService.getApprovedConsignments(
        (req as any).prisma,
        limitNum,
        offset
      );

      res.json({
        consignments: result.consignments,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: result.pagination.total,
          pages: result.pagination.pages,
        },
      });
    } catch (error: any) {
      console.error("GET /quality/approved error:", error);
      res.status(500).json({ error: error?.message || "Failed to get approved consignments" });
    }
  }
);

// ---------------------------------------------------------------------------
// Delete Quality Approval
// ---------------------------------------------------------------------------

/**
 * DELETE /quality/approvals/:approvalId
 * Delete a quality approval record (only if not yet approved)
 * Reverts consignment back to RECEIVED status
 */
router.delete(
  "/approvals/:approvalId",
  requirePermission("qa", "delete"),
  async (req: Request, res: Response) => {
    try {
      const { approvalId } = req.params;

      if (!approvalId) {
        return res.status(400).json({ error: "approvalId is required" });
      }

      const result = await qualityApprovalService.deleteQualityApproval(
        (req as any).prisma,
        approvalId,
        req.user!.id
      );

      res.json(result);
    } catch (error: any) {
      console.error("DELETE /quality/approvals/:approvalId error:", error);
      
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      if (error.message.includes('Cannot delete')) {
        return res.status(403).json({ error: error.message });
      }
      
      res.status(500).json({ error: error?.message || "Failed to delete quality approval" });
    }
  }
);

export default router;
