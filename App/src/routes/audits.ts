import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import * as auditTrail from "../services/auditTrail.js";
import * as userActivityLogger from "../services/userActivityLogger.js";

const router: Router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Entity Lifecycle Endpoints
// ---------------------------------------------------------------------------

/**
 * GET /audits/requisitions/:id — Get requisition approval timeline
 */
router.get(
  "/requisitions/:id",
  requirePermission("procurement", "read"),
  async (req: Request, res: Response) => {
    try {
      const timeline = await auditTrail.getRequisitionTimeline(req.params.id);
      res.json({ timeline });
    } catch (error: any) {
      console.error("GET /audits/requisitions/:id error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /audits/purchase-orders/:id — Get PO status timeline
 */
router.get(
  "/purchase-orders/:id",
  requirePermission("procurement", "read"),
  async (req: Request, res: Response) => {
    try {
      const timeline = await auditTrail.getPurchaseOrderTimeline(req.params.id);
      res.json({ timeline });
    } catch (error: any) {
      console.error("GET /audits/purchase-orders/:id error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /audits/goods-receipts/:id — Get GRN approval timeline
 */
router.get(
  "/goods-receipts/:id",
  requirePermission("procurement", "read"),
  async (req: Request, res: Response) => {
    try {
      const timeline = await auditTrail.getGoodsReceiptTimeline(req.params.id);
      res.json({ timeline });
    } catch (error: any) {
      console.error("GET /audits/goods-receipts/:id error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /audits/production-orders/:id — Get production order lifecycle timeline
 */
router.get(
  "/production-orders/:id",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const timeline = await auditTrail.getProductionOrderTimeline(req.params.id);
      res.json({ timeline });
    } catch (error: any) {
      console.error("GET /audits/production-orders/:id error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /audits/boms/:id — Get BOM lifecycle timeline (creation, approval, archival)
 */
router.get(
  "/boms/:id",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const timeline = await auditTrail.getBomTimeline(req.params.id);
      res.json({ timeline });
    } catch (error: any) {
      console.error("GET /audits/boms/:id error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

// ---------------------------------------------------------------------------
// User & System Activity
// ---------------------------------------------------------------------------

/**
 * GET /audits/user/:userId/activity — Get user activity summary
 */
router.get(
  "/user/:userId/activity",
  requirePermission("procurement", "read"),
  async (req: Request, res: Response) => {
    try {
      const { days } = req.query;
      const activity = await auditTrail.getUserActivity(req.params.userId, days ? parseInt(days as string) : 30);
      res.json({ activity });
    } catch (error: any) {
      console.error("GET /audits/user/:userId/activity error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /audits/system-activity — Get system-wide activity timeline
 */
router.get(
  "/system-activity",
  requirePermission("procurement", "read"),
  async (req: Request, res: Response) => {
    try {
      const { days, limit } = req.query;
      const activities = await auditTrail.getSystemActivityTimeline(
        days ? parseInt(days as string) : 7,
        limit ? parseInt(limit as string) : 100
      );
      res.json({ activities });
    } catch (error: any) {
      console.error("GET /audits/system-activity error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

// ---------------------------------------------------------------------------
// Metrics & Analytics
// ---------------------------------------------------------------------------

/**
 * GET /audits/metrics/approval-velocity — Approval rate metrics
 */
router.get(
  "/metrics/approval-velocity",
  requirePermission("procurement", "read"),
  async (req: Request, res: Response) => {
    try {
      const { days } = req.query;
      const metrics = await auditTrail.getApprovalVelocityMetrics(days ? parseInt(days as string) : 30);
      res.json({ metrics });
    } catch (error: any) {
      console.error("GET /audits/metrics/approval-velocity error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /audits/metrics/production — Production completion metrics
 */
router.get(
  "/metrics/production",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const { days } = req.query;
      const metrics = await auditTrail.getProductionMetrics(days ? parseInt(days as string) : 30);
      res.json({ metrics });
    } catch (error: any) {
      console.error("GET /audits/metrics/production error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

// ---------------------------------------------------------------------------
// User Activity Tracking Endpoints
// ---------------------------------------------------------------------------

/**
 * GET /audits/user-activities — Get all user activities (admin only)
 */
router.get(
  "/user-activities",
  requirePermission("audit", "read"),
  async (req: Request, res: Response) => {
    try {
      const { days, limit } = req.query;
      const activities = await userActivityLogger.getSystemUserActivities(
        days ? parseInt(days as string) : 7,
        limit ? parseInt(limit as string) : 100
      );
      res.json({ activities });
    } catch (error: any) {
      console.error("GET /audits/user-activities error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /audits/user/:userId/activities — Get specific user's activities
 */
router.get(
  "/user/:userId/activities",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      // Users can only view their own activities, except admins
      const userId = req.params.userId;
      const currentUser = req.user as any;
      
      if (userId !== currentUser.id && currentUser.role !== 'SUPER_ADMIN' && currentUser.role !== 'EXECUTIVE_ADMIN') {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const { days, limit } = req.query;
      const activities = await userActivityLogger.getUserActivityHistory(
        userId,
        days ? parseInt(days as string) : 30,
        limit ? parseInt(limit as string) : 100
      );
      res.json({ activities });
    } catch (error: any) {
      console.error("GET /audits/user/:userId/activities error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /audits/user/:userId/summary — Get user activity summary (aggregated)
 */
router.get(
  "/user/:userId/summary",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const userId = req.params.userId;
      const currentUser = req.user as any;
      
      if (userId !== currentUser.id && currentUser.role !== 'SUPER_ADMIN' && currentUser.role !== 'EXECUTIVE_ADMIN') {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const { days } = req.query;
      const summary = await userActivityLogger.getUserActivitySummary(
        userId,
        days ? parseInt(days as string) : 30
      );
      res.json({ summary });
    } catch (error: any) {
      console.error("GET /audits/user/:userId/summary error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /audits/activity-stats — Get activity statistics
 */
router.get(
  "/activity-stats",
  requirePermission("audit", "read"),
  async (req: Request, res: Response) => {
    try {
      const { days } = req.query;
      const stats = await userActivityLogger.getActivityStatistics(
        days ? parseInt(days as string) : 30
      );
      res.json({ stats });
    } catch (error: any) {
      console.error("GET /audits/activity-stats error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

export default router;
