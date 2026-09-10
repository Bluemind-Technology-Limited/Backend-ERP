import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import * as batchMachineAllocationService from "../services/batchMachineAllocationService.js";
import * as dailyProductionReconciliationService from "../services/dailyProductionReconciliationService.js";
import * as supervisorProductionService from "../services/supervisorProductionService.js";

const router: Router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Production Plan Visibility Endpoints
// ---------------------------------------------------------------------------

/**
 * GET /supervisor/production-plans
 * List all active production plans
 */
router.get(
  "/production-plans",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const { status, page = 1, limit = 20 } = req.query;
      const pageNum = parseInt(page as string) || 1;
      const limitNum = parseInt(limit as string) || 20;
      const skip = (pageNum - 1) * limitNum;

      const where = status
        ? { status: status as string }
        : { status: { in: ["SCHEDULED", "IN_PROGRESS", "COMPLETED"] } };

      const [plans, total] = await Promise.all([
        (req as any).prisma.productionPlan.findMany({
          where,
          include: {
            items: true,
            createdBy: { select: { fullName: true } },
          },
          orderBy: { scheduledFor: "asc" },
          skip,
          take: limitNum,
        }),
        (req as any).prisma.productionPlan.count({ where }),
      ]);

      // Get execution status for each plan
      const plansWithStatus = await Promise.all(
        plans.map(async (plan) => ({
          ...plan,
          executionStatus: await supervisorProductionService.getPlanExecutionStatus(plan.id),
        }))
      );

      res.json({
        plans: plansWithStatus,
        pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
      });
    } catch (error: any) {
      console.error("GET /supervisor/production-plans error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /supervisor/production-plans/:planId
 * Get detailed production plan with items and aggregated ingredients
 */
router.get(
  "/production-plans/:planId",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const plan = await (req as any).prisma.productionPlan.findUnique({
        where: { id: req.params.planId },
        include: {
          items: {
            include: {
              bom: { include: { finishedSku: { select: { name: true, sku: true } } } },
            },
          },
          aggregatedIngredients: {
            include: { material: { select: { name: true, sku: true, unitOfMeasure: true } } },
          },
          createdBy: { select: { fullName: true } },
        },
      });

      if (!plan) return res.status(404).json({ error: "Production plan not found" });

      // Get execution status
      const executionStatus = await supervisorProductionService.getPlanExecutionStatus(plan.id);

      res.json({ plan, executionStatus });
    } catch (error: any) {
      console.error("GET /supervisor/production-plans/:planId error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /supervisor/production-plans/:planId/items
 * Get production items in plan with status
 */
router.get(
  "/production-plans/:planId/items",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const items = await (req as any).prisma.productionPlanItem.findMany({
        where: { productionPlanId: req.params.planId },
        include: {
          bom: { include: { finishedSku: { select: { name: true, sku: true, unitOfMeasure: true } } } },
          batchMachineAllocations: {
            include: { machine: true, productionOrder: true },
          },
        },
        orderBy: { sequence: "asc" },
      });

      res.json({ items });
    } catch (error: any) {
      console.error("GET /supervisor/production-plans/:planId/items error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /supervisor/production-plans/:planId/ingredients
 * Get aggregated ingredients needed for plan
 */
router.get(
  "/production-plans/:planId/ingredients",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const ingredients = await (req as any).prisma.planAggregatedIngredient.findMany({
        where: { productionPlanId: req.params.planId },
        include: { material: { select: { name: true, sku: true, unitOfMeasure: true } } },
      });

      res.json({ ingredients });
    } catch (error: any) {
      console.error("GET /supervisor/production-plans/:planId/ingredients error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

// ---------------------------------------------------------------------------
// Batch-to-Machine Allocation Endpoints
// ---------------------------------------------------------------------------

/**
 * POST /supervisor/batch-allocations
 * Allocate a batch (production order) to a machine
 */
router.post(
  "/batch-allocations",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const { productionPlanItemId, productionOrderId, machineId, notes, scheduledStartTime, scheduledEndTime } =
        req.body;

      if (!productionPlanItemId || !productionOrderId || !machineId) {
        return res.status(400).json({
          error: "productionPlanItemId, productionOrderId, and machineId are required",
        });
      }

      const allocation = await batchMachineAllocationService.allocateBatchToMachine({
        productionPlanItemId,
        productionOrderId,
        machineId,
        supervisorId: (req as any).user.id,
        notes,
        scheduledStartTime: scheduledStartTime ? new Date(scheduledStartTime) : undefined,
        scheduledEndTime: scheduledEndTime ? new Date(scheduledEndTime) : undefined,
      });

      res.status(201).json({ allocation });
    } catch (error: any) {
      console.error("POST /supervisor/batch-allocations error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /supervisor/batch-allocations
 * Get supervisor's allocations (optionally filtered by date)
 */
router.get(
  "/batch-allocations",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const { date } = req.query;
      const queryDate = date ? new Date(date as string) : new Date();

      const allocations = await batchMachineAllocationService.getSupervisorDailyAllocations(
        (req as any).user.id,
        queryDate
      );

      res.json({ allocations });
    } catch (error: any) {
      console.error("GET /supervisor/batch-allocations error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /supervisor/batch-allocations/:machineId/workload
 * Get machine workload for a specific date
 */
router.get(
  "/batch-allocations/:machineId/workload",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const { date } = req.query;
      const queryDate = date ? new Date(date as string) : new Date();

      const workload = await batchMachineAllocationService.getMachineWorkload(req.params.machineId, queryDate);

      res.json({ machine: req.params.machineId, date: queryDate, workload });
    } catch (error: any) {
      console.error("GET /supervisor/batch-allocations/:machineId/workload error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * POST /supervisor/batch-allocations/:id/start
 * Mark batch production as started
 */
router.post(
  "/batch-allocations/:id/start",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const { actualStartTime } = req.body;

      const allocation = await batchMachineAllocationService.startBatchProduction(
        req.params.id,
        (req as any).user.id,
        actualStartTime ? new Date(actualStartTime) : undefined
      );

      res.json({ allocation, message: "Batch production started" });
    } catch (error: any) {
      console.error("POST /supervisor/batch-allocations/:id/start error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * POST /supervisor/batch-allocations/:id/complete
 * Mark batch production as completed
 */
router.post(
  "/batch-allocations/:id/complete",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const { batchNumber, actualEndTime } = req.body;

      const allocation = await batchMachineAllocationService.completeBatchProduction(
        req.params.id,
        (req as any).user.id,
        batchNumber,
        actualEndTime ? new Date(actualEndTime) : undefined
      );

      res.json({ allocation, message: "Batch production completed" });
    } catch (error: any) {
      console.error("POST /supervisor/batch-allocations/:id/complete error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * PATCH /supervisor/batch-allocations/:id/reallocate
 * Reallocate batch to a different machine
 */
router.patch(
  "/batch-allocations/:id/reallocate",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const { newMachineId } = req.body;

      if (!newMachineId) {
        return res.status(400).json({ error: "newMachineId is required" });
      }

      const allocation = await batchMachineAllocationService.reallocateBatchToMachine(
        req.params.id,
        newMachineId,
        (req as any).user.id
      );

      res.json({ allocation, message: "Batch reallocated to new machine" });
    } catch (error: any) {
      console.error("PATCH /supervisor/batch-allocations/:id/reallocate error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /supervisor/batch-allocations/:id/details
 * Get detailed allocation information
 */
router.get(
  "/batch-allocations/:id/details",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const allocation = await batchMachineAllocationService.getAllocationDetails(req.params.id);

      if (!allocation) {
        return res.status(404).json({ error: "Allocation not found" });
      }

      res.json({ allocation });
    } catch (error: any) {
      console.error("GET /supervisor/batch-allocations/:id/details error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

// ---------------------------------------------------------------------------
// Daily Reconciliation Endpoints
// ---------------------------------------------------------------------------

/**
 * POST /supervisor/daily-reconciliations
 * Create end-of-day reconciliation
 */
router.post(
  "/daily-reconciliations",
  requirePermission("production", "create"),
  async (req: Request, res: Response) => {
    try {
      const { productionPlanId, reconciliationDate } = req.body;

      if (!productionPlanId) {
        return res.status(400).json({ error: "productionPlanId is required" });
      }

      const reconciliation = await dailyProductionReconciliationService.createDailyReconciliation({
        productionPlanId,
        supervisorId: (req as any).user.id,
        reconciliationDate: reconciliationDate ? new Date(reconciliationDate) : new Date(),
      });

      res.status(201).json({ reconciliation });
    } catch (error: any) {
      console.error("POST /supervisor/daily-reconciliations error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /supervisor/daily-reconciliations
 * Get reconciliations (optionally filtered by date or plan)
 */
router.get(
  "/daily-reconciliations",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const { date } = req.query;

      if (date) {
        const reconciliations = await dailyProductionReconciliationService.getReconciliationsByDate(
          new Date(date as string)
        );
        res.json({ reconciliations });
      } else {
        const reconciliations = await (req as any).prisma.dailyProductionReconciliation.findMany({
          include: {
            productionPlan: { select: { planNumber: true } },
            supervisor: { select: { fullName: true } },
          },
          orderBy: { reconciliationDate: "desc" },
          take: 50,
        });
        res.json({ reconciliations });
      }
    } catch (error: any) {
      console.error("GET /supervisor/daily-reconciliations error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /supervisor/daily-reconciliations/:id
 * Get detailed reconciliation with item breakdown
 */
router.get(
  "/daily-reconciliations/:id",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const details = await dailyProductionReconciliationService.getReconciliationDetails(req.params.id);

      if (!details) {
        return res.status(404).json({ error: "Reconciliation not found" });
      }

      res.json(details);
    } catch (error: any) {
      console.error("GET /supervisor/daily-reconciliations/:id error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * POST /supervisor/daily-reconciliations/:id/verify
 * Verify/approve reconciliation
 */
router.post(
  "/daily-reconciliations/:id/verify",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const { notes } = req.body;

      const reconciliation = await dailyProductionReconciliationService.verifyReconciliation(
        req.params.id,
        (req as any).user.id,
        notes
      );

      res.json({ reconciliation, message: "Reconciliation verified" });
    } catch (error: any) {
      console.error("POST /supervisor/daily-reconciliations/:id/verify error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * POST /supervisor/daily-reconciliations/:id/flag
 * Flag discrepancy in reconciliation
 */
router.post(
  "/daily-reconciliations/:id/flag",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const { issue, potentialCause, recommendedAction } = req.body;

      if (!issue) {
        return res.status(400).json({ error: "issue is required" });
      }

      const reconciliation = await dailyProductionReconciliationService.flagDiscrepancy(
        req.params.id,
        (req as any).user.id,
        issue,
        potentialCause,
        recommendedAction
      );

      res.json({ reconciliation, message: "Discrepancy flagged" });
    } catch (error: any) {
      console.error("POST /supervisor/daily-reconciliations/:id/flag error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /supervisor/production-plans/:planId/reconciliation-history
 * Get reconciliation history for a plan
 */
router.get(
  "/production-plans/:planId/reconciliation-history",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const { limit = 30 } = req.query;

      const reconciliations = await dailyProductionReconciliationService.getReconciliationHistory(
        req.params.planId,
        parseInt(limit as string) || 30
      );

      res.json({ reconciliations });
    } catch (error: any) {
      console.error("GET /supervisor/production-plans/:planId/reconciliation-history error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

// ---------------------------------------------------------------------------
// Supervisor Dashboard & Analytics Endpoints
// ---------------------------------------------------------------------------

/**
 * GET /supervisor/dashboard
 * Get supervisor dashboard with active plans, allocations, and reconciliation status
 */
router.get(
  "/dashboard",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const { date } = req.query;
      const queryDate = date ? new Date(date as string) : new Date();

      const dashboard = await supervisorProductionService.getSupervisorDashboard((req as any).user.id, queryDate);

      res.json(dashboard);
    } catch (error: any) {
      console.error("GET /supervisor/dashboard error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /supervisor/machines/schedule
 * Get all machines' daily schedules
 */
router.get(
  "/machines/schedule",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const { date } = req.query;
      const queryDate = date ? new Date(date as string) : new Date();

      const schedules = await supervisorProductionService.getAllMachinesSchedule(queryDate);

      res.json({ date: queryDate, schedules });
    } catch (error: any) {
      console.error("GET /supervisor/machines/schedule error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /supervisor/metrics
 * Get supervisor's KPI metrics
 */
router.get(
  "/metrics",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const { days = 30 } = req.query;

      const metrics = await supervisorProductionService.getSupervisorMetrics((req as any).user.id, parseInt(days as string) || 30);

      res.json({ metrics });
    } catch (error: any) {
      console.error("GET /supervisor/metrics error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /supervisor/production-plans/:planId/report
 * Get comprehensive summary report for a plan
 */
router.get(
  "/production-plans/:planId/report",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const report = await supervisorProductionService.getPlanSummaryReport(req.params.planId);

      res.json({ report });
    } catch (error: any) {
      console.error("GET /supervisor/production-plans/:planId/report error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

export default router;
