import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission, requireRole } from "../middleware/rbac.js";
import { prisma } from "../lib/db.js";
import * as qualityApprovalService from "../services/qualityApprovalService.js";
import * as quantityAdjustmentService from "../services/quantityAdjustmentService.js";
import * as inspectionReportService from "../services/inspectionReportService.js";
import * as storage from "../lib/storage.js";

const router: Router = Router();
router.use(requireAuth);

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME = /^(image\/|application\/pdf$)/;
const CHECK_TYPES = [
  "PHYSICAL_INSPECTION",
  "QUANTITY_VERIFICATION",
  "EXPIRY_CHECK",
  "PACKAGING_INSPECTION",
  "DOCUMENTATION_REVIEW",
  "LABORATORY_TEST",
] as const;

/** Map a thrown service error to a sensible HTTP status. */
function sendError(res: Response, error: any, fallback: string) {
  const message = error?.message || fallback;
  if (/not found/i.test(message)) return res.status(404).json({ error: message });
  if (/already|Cannot|does not match|must be/i.test(message)) {
    return res.status(400).json({ error: message });
  }
  return res.status(500).json({ error: message });
}

// ---------------------------------------------------------------------------
// Quality Approval Management Endpoints
// ---------------------------------------------------------------------------

/**
 * POST /quality/approvals/initiate
 * Initiate QA checks for a consignment (consignment must be in RECEIVED status).
 * Creates one independent check per ingredient.
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
        prisma,
        consignmentId,
        req.user!.id
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
 * GET /quality/storage/status
 * Whether proof-of-check storage is configured (used by the UI to warn early).
 */
router.get(
  "/storage/status",
  requirePermission("qa", "read"),
  (_req: Request, res: Response) => {
    res.json({
      configured: storage.isQaStorageConfigured(),
      bucket: storage.getQaBucket(),
      maxBytes: MAX_ATTACHMENT_BYTES,
    });
  }
);

/**
 * PATCH /quality/approvals/items/:checkItemId
 * Record a PASS/FAIL result for a single check (and its remarks/type).
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

      if (!CHECK_TYPES.includes(checkType)) {
        return res.status(400).json({ error: `checkType must be one of: ${CHECK_TYPES.join(", ")}` });
      }

      const updatedItem = await qualityApprovalService.updateCheckItem(
        prisma,
        req.params.checkItemId,
        {
          checkType,
          result,
          remarks,
          inspectorId: req.user!.id,
        }
      );

      res.json({
        message: "Quality check item updated",
        data: updatedItem,
      });
    } catch (error: any) {
      console.error("PATCH /quality/approvals/items/:checkItemId error:", error);
      sendError(res, error, "Failed to update check item");
    }
  }
);

/**
 * POST /quality/approvals/:approvalId/checks
 * Add an additional, independent check to a single ingredient.
 */
router.post(
  "/approvals/:approvalId/checks",
  requirePermission("qa", "create"),
  async (req: Request, res: Response) => {
    try {
      const { consignmentItemId, checkType, result, remarks } = req.body;

      if (!consignmentItemId || !checkType) {
        return res.status(400).json({ error: "consignmentItemId and checkType are required" });
      }
      if (!CHECK_TYPES.includes(checkType)) {
        return res.status(400).json({ error: `checkType must be one of: ${CHECK_TYPES.join(", ")}` });
      }
      if (result !== undefined && !["PASS", "FAIL"].includes(result)) {
        return res.status(400).json({ error: "result must be PASS or FAIL when provided" });
      }

      const check = await qualityApprovalService.addCheckItem(
        prisma,
        req.params.approvalId,
        {
          consignmentItemId,
          checkType,
          result,
          remarks,
          inspectorId: req.user!.id,
        }
      );

      res.status(201).json({ message: "Check added", data: check });
    } catch (error: any) {
      console.error("POST /quality/approvals/:approvalId/checks error:", error);
      sendError(res, error, "Failed to add check");
    }
  }
);

/**
 * POST /quality/approvals/:approvalId/approve
 * Approve consignment for release (every ingredient passed, none pending/failed).
 */
router.post(
  "/approvals/:approvalId/approve",
  requirePermission("qa", "update"),
  async (req: Request, res: Response) => {
    try {
      const { notes } = req.body;

      const result = await qualityApprovalService.approveConsignment(
        prisma,
        req.params.approvalId,
        {
          approverUserId: req.user!.id,
          notes,
        }
      );

      res.json({
        message: "Consignment approved for release - stock manager can now access",
        data: result,
      });
    } catch (error: any) {
      console.error("POST /quality/approvals/:approvalId/approve error:", error);
      sendError(res, error, "Failed to approve consignment");
    }
  }
);

/**
 * POST /quality/approvals/:approvalId/reject
 * Reject consignment due to failed QA checks.
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
        prisma,
        req.params.approvalId,
        {
          rejectorUserId: req.user!.id,
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
      sendError(res, error, "Failed to reject consignment");
    }
  }
);

/**
 * GET /quality/approvals/:approvalId/failed-items
 * All failed checks with their ingredient and attached proof.
 */
router.get(
  "/approvals/:approvalId/failed-items",
  requirePermission("qa", "read"),
  async (req: Request, res: Response) => {
    try {
      const failedItems = await qualityApprovalService.getFailedItems(
        prisma,
        req.params.approvalId
      );

      res.json({
        data: failedItems,
        count: failedItems.length,
      });
    } catch (error: any) {
      console.error("GET /quality/approvals/:approvalId/failed-items error:", error);
      sendError(res, error, "Failed to get failed items");
    }
  }
);

/**
 * GET /quality/approvals/:consignmentId/report
 * Generate a comprehensive QA report for a consignment.
 */
router.get(
  "/approvals/:consignmentId/report",
  requirePermission("qa", "read"),
  async (req: Request, res: Response) => {
    try {
      const report = await qualityApprovalService.generateQualityReport(
        prisma,
        req.params.consignmentId
      );

      res.json({ data: report });
    } catch (error: any) {
      console.error("GET /quality/approvals/:consignmentId/report error:", error);
      sendError(res, error, "Failed to generate report");
    }
  }
);

/**
 * GET /quality/approvals/:consignmentId
 * Consignment-level approval status with per-ingredient detail, checks and proof.
 * NOTE: keep this *after* the more specific `/approvals/...` GET routes above.
 */
router.get(
  "/approvals/:consignmentId",
  requirePermission("qa", "read"),
  async (req: Request, res: Response) => {
    try {
      const status = await qualityApprovalService.getQualityStatus(
        prisma,
        req.params.consignmentId
      );

      if (!status) {
        return res.status(404).json({ error: "Quality approval not found for this consignment" });
      }

      res.json({ data: status });
    } catch (error: any) {
      console.error("GET /quality/approvals/:consignmentId error:", error);
      sendError(res, error, "Failed to get quality status");
    }
  }
);

// ---------------------------------------------------------------------------
// Proof-of-check attachments
// ---------------------------------------------------------------------------

/**
 * POST /quality/checks/:checkItemId/attachments/presign
 * Mint a signed upload URL for a proof file on a specific check.
 */
router.post(
  "/checks/:checkItemId/attachments/presign",
  requirePermission("qa", "update"),
  async (req: Request, res: Response) => {
    try {
      const { fileName } = req.body;

      if (!fileName || typeof fileName !== "string") {
        return res.status(400).json({ error: "fileName is required" });
      }

      if (!storage.isQaStorageConfigured()) {
        return res.status(503).json({
          error:
            "Attachment storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the backend.",
        });
      }

      const upload = await qualityApprovalService.createAttachmentUploadUrl(
        prisma,
        req.params.checkItemId,
        fileName
      );

      res.json({ data: upload });
    } catch (error: any) {
      console.error("POST /quality/checks/:checkItemId/attachments/presign error:", error);
      sendError(res, error, "Failed to create upload URL");
    }
  }
);

/**
 * POST /quality/checks/:checkItemId/attachments
 * Register metadata for a proof file after the binary upload completes.
 */
router.post(
  "/checks/:checkItemId/attachments",
  requirePermission("qa", "update"),
  async (req: Request, res: Response) => {
    try {
      const { fileName, storagePath, mimeType, fileSize, kind } = req.body;

      if (!fileName || !storagePath) {
        return res.status(400).json({ error: "fileName and storagePath are required" });
      }
      if (mimeType && !ALLOWED_MIME.test(mimeType)) {
        return res.status(400).json({ error: "Only image or PDF proof files are allowed" });
      }
      if (fileSize !== undefined && (typeof fileSize !== "number" || fileSize > MAX_ATTACHMENT_BYTES)) {
        return res.status(400).json({ error: `File must be at most ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB` });
      }

      const attachment = await qualityApprovalService.createAttachment(
        prisma,
        req.params.checkItemId,
        {
          fileName,
          storagePath,
          mimeType,
          fileSize,
          kind,
          uploadedById: req.user!.id,
        }
      );

      res.status(201).json({ message: "Proof attached", data: attachment });
    } catch (error: any) {
      console.error("POST /quality/checks/:checkItemId/attachments error:", error);
      sendError(res, error, "Failed to attach proof");
    }
  }
);

/**
 * GET /quality/checks/:checkItemId/attachments
 * List the proof attached to a check, with signed read URLs.
 */
router.get(
  "/checks/:checkItemId/attachments",
  requirePermission("qa", "read"),
  async (req: Request, res: Response) => {
    try {
      const attachments = await qualityApprovalService.listAttachments(
        prisma,
        req.params.checkItemId
      );
      res.json({ data: attachments });
    } catch (error: any) {
      console.error("GET /quality/checks/:checkItemId/attachments error:", error);
      sendError(res, error, "Failed to list proof");
    }
  }
);

/**
 * GET /quality/consignments/:consignmentId/attachments
 * All proof attached to a consignment (grouped client-side by ingredient).
 */
router.get(
  "/consignments/:consignmentId/attachments",
  requirePermission("qa", "read"),
  async (req: Request, res: Response) => {
    try {
      const attachments = await qualityApprovalService.listConsignmentAttachments(
        prisma,
        req.params.consignmentId
      );
      res.json({ data: attachments });
    } catch (error: any) {
      console.error("GET /quality/consignments/:consignmentId/attachments error:", error);
      sendError(res, error, "Failed to list proof");
    }
  }
);

/**
 * DELETE /quality/attachments/:attachmentId
 * Remove a proof file (metadata row + stored object).
 */
router.delete(
  "/attachments/:attachmentId",
  requirePermission("qa", "update"),
  async (req: Request, res: Response) => {
    try {
      const result = await qualityApprovalService.deleteAttachment(
        prisma,
        req.params.attachmentId,
        req.user!.id
      );
      res.json(result);
    } catch (error: any) {
      console.error("DELETE /quality/attachments/:attachmentId error:", error);
      sendError(res, error, "Failed to delete proof");
    }
  }
);

// ---------------------------------------------------------------------------
// Dashboard Endpoints
// ---------------------------------------------------------------------------

/**
 * GET /quality/pending
 * Consignments awaiting QA approval, with per-ingredient progress and proof counts.
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
        prisma,
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
      sendError(res, error, "Failed to get pending consignments");
    }
  }
);

/**
 * GET /quality/approved
 * Approved consignments ready for stock manager distribution.
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
        prisma,
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
      sendError(res, error, "Failed to get approved consignments");
    }
  }
);

// ---------------------------------------------------------------------------
// Delete Quality Approval
// ---------------------------------------------------------------------------

/**
 * DELETE /quality/approvals/:approvalId
 * Delete a quality approval record (only if not yet approved) and revert the
 * consignment to RECEIVED. Associated proof files are cleaned up too.
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
        prisma,
        approvalId,
        req.user!.id
      );

      res.json(result);
    } catch (error: any) {
      console.error("DELETE /quality/approvals/:approvalId error:", error);

      if (error?.message?.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      if (error?.message?.includes("Cannot delete")) {
        return res.status(403).json({ error: error.message });
      }

      sendError(res, error, "Failed to delete quality approval");
    }
  }
);

// ---------------------------------------------------------------------------
// Inspection report (admins track all quality checks)
// ---------------------------------------------------------------------------

/**
 * GET /quality/inspections/report
 * Cross-consignment feed of every quality check + approved quantity changes.
 */
router.get(
  "/inspections/report",
  requirePermission("qa", "read"),
  async (req: Request, res: Response) => {
    try {
      const { dateFrom, dateTo, consignmentId, materialId, checkType, result, checkedById, approvalStatus, q, page, limit } = req.query;

      const report = await inspectionReportService.getInspectionReport({
        dateFrom: dateFrom as string | undefined,
        dateTo: dateTo as string | undefined,
        consignmentId: consignmentId as string | undefined,
        materialId: materialId as string | undefined,
        checkType: checkType as string | undefined,
        result: result as string | undefined,
        checkedById: checkedById as string | undefined,
        approvalStatus: approvalStatus as string | undefined,
        q: q as string | undefined,
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
      });

      res.json(report);
    } catch (error: any) {
      console.error("GET /quality/inspections/report error:", error);
      sendError(res, error, "Failed to generate inspection report");
    }
  }
);

// ---------------------------------------------------------------------------
// Quantity adjustments (QC proposes, Head of QC approves)
// ---------------------------------------------------------------------------

/**
 * POST /quality/quantity-adjustments
 * QC proposes a corrected quantity for a consignment ingredient.
 */
router.post(
  "/quantity-adjustments",
  requirePermission("qa", "update"),
  async (req: Request, res: Response) => {
    try {
      const { consignmentItemId, newQuantity, reasonCode, reason } = req.body;

      if (!consignmentItemId || newQuantity === undefined || newQuantity === null) {
        return res.status(400).json({ error: "consignmentItemId and newQuantity are required" });
      }

      const adjustment = await quantityAdjustmentService.proposeQuantityAdjustment({
        consignmentItemId,
        newQuantity: Number(newQuantity),
        reasonCode,
        reason,
        requestedById: req.user!.id,
      });

      res.status(201).json({ message: "Quantity change submitted for approval", data: adjustment });
    } catch (error: any) {
      console.error("POST /quality/quantity-adjustments error:", error);
      sendError(res, error, "Failed to submit quantity change");
    }
  }
);

/**
 * GET /quality/quantity-adjustments/pending
 * Head of QC approval queue.
 */
router.get(
  "/quantity-adjustments/pending",
  requirePermission("qa", "approve"),
  async (req: Request, res: Response) => {
    try {
      const { limit = 100 } = req.query;
      const adjustments = await quantityAdjustmentService.getPendingAdjustments(
        parseInt(limit as string) || 100
      );
      res.json({ adjustments });
    } catch (error: any) {
      console.error("GET /quality/quantity-adjustments/pending error:", error);
      sendError(res, error, "Failed to load pending quantity changes");
    }
  }
);

/**
 * GET /quality/quantity-adjustments/summary
 * Aggregated stats for the report.
 */
router.get(
  "/quantity-adjustments/summary",
  requirePermission("qa", "read"),
  async (req: Request, res: Response) => {
    try {
      const { days = 30 } = req.query;
      const summary = await quantityAdjustmentService.getAdjustmentSummary(
        parseInt(days as string) || 30
      );
      res.json({ summary });
    } catch (error: any) {
      console.error("GET /quality/quantity-adjustments/summary error:", error);
      sendError(res, error, "Failed to load quantity summary");
    }
  }
);

/**
 * POST /quality/quantity-adjustments/:id/approve
 * Only the Head of QC (or Super Admin) may approve. Applies the new quantity
 * and posts only the delta not already in the ledger.
 */
router.post(
  "/quantity-adjustments/:id/approve",
  requireAuth,
  requirePermission("qa", "approve"),
  requireRole("HEAD_OF_QC", "SUPER_ADMIN"),
  async (req: Request, res: Response) => {
    try {
      const result = await quantityAdjustmentService.approveQuantityAdjustment(
        req.params.id,
        req.user!.id
      );
      res.json({ message: "Quantity change approved", data: result });
    } catch (error: any) {
      console.error("POST /quality/quantity-adjustments/:id/approve error:", error);
      sendError(res, error, "Failed to approve quantity change");
    }
  }
);

/**
 * POST /quality/quantity-adjustments/:id/reject
 */
router.post(
  "/quantity-adjustments/:id/reject",
  requireAuth,
  requirePermission("qa", "approve"),
  requireRole("HEAD_OF_QC", "SUPER_ADMIN"),
  async (req: Request, res: Response) => {
    try {
      const { rejectionReason } = req.body;
      if (!rejectionReason) {
        return res.status(400).json({ error: "rejectionReason is required" });
      }
      const result = await quantityAdjustmentService.rejectQuantityAdjustment(
        req.params.id,
        req.user!.id,
        rejectionReason
      );
      res.json({ message: "Quantity change rejected", data: result });
    } catch (error: any) {
      console.error("POST /quality/quantity-adjustments/:id/reject error:", error);
      sendError(res, error, "Failed to reject quantity change");
    }
  }
);

/**
 * GET /quality/consignments/:consignmentId/quantity-adjustments
 * Full adjustment history for a consignment.
 */
router.get(
  "/consignments/:consignmentId/quantity-adjustments",
  requirePermission("qa", "read"),
  async (req: Request, res: Response) => {
    try {
      const adjustments = await quantityAdjustmentService.getConsignmentAdjustments(
        req.params.consignmentId
      );
      res.json({ adjustments });
    } catch (error: any) {
      console.error("GET /quality/consignments/:consignmentId/quantity-adjustments error:", error);
      sendError(res, error, "Failed to load quantity changes");
    }
  }
);

export default router;
