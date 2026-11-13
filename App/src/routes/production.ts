import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { prisma } from "../lib/db.js";
import { percentageIngredientPacks } from "../lib/uom.js";
import { postLedgerEntry } from "../lib/ledger.js";
import { LedgerEventType, ProductionOrderStatus } from "@prisma/client";
import {
  createBatchFormulation,
  getBatchFormulations,
  getBatchFormulation,
  updateBatchFormulation,
  addIngredient,
  removeIngredient,
  approveBatchFormulation,
  archiveBatchFormulation,
  duplicateBatchFormulation,
} from "../services/batchFormulation.js";
import {
  createProductionPlan,
  updateProductionPlan,
  getProductionPlans,
  getProductionPlan,
  addFormulationToPlan,
  removeFormulationFromPlan,
  aggregateIngredientsForPlan,
  getPlanAggregatedIngredients,
  getPlanIngredientRequirements,
  releasePlanIngredients,
  PlanReleaseError,
  scheduleProductionPlan,
  startProductionPlan,
  completeProductionPlan,
  cancelProductionPlan,
} from "../services/productionPlan.js";
import * as ingredientLifecycle from "../services/ingredientLifecycle.js";

const router: Router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Batch Formulations (BOM - simplified, no versioning)
// ---------------------------------------------------------------------------

/**
 * GET /batch-formulations — Get all batch formulations
 */
router.get(
  "/batch-formulations",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const { status, search, finishedSkuId } = req.query;
      const boms = await getBatchFormulations({
        status: status ? String(status) : undefined,
        search: search ? String(search) : undefined,
        finishedSkuId: finishedSkuId ? String(finishedSkuId) : undefined,
      });
      res.json({ batchFormulations: boms });
    } catch (error) {
      console.error("GET /production/batch-formulations error:", error);
      res.status(500).json({ error: "Database error" });
    }
  }
);

/**
 * POST /batch-formulations — Create new batch formulation
 */
router.post(
  "/batch-formulations",
  requirePermission("production", "create"),
  async (req: Request, res: Response) => {
    try {
      const { productName, description, expectedYield, yieldUnit, finishedSkuId, ingredients } = req.body;

      if (!finishedSkuId || expectedYield === undefined || !yieldUnit) {
        return res.status(400).json({
          error: "finishedSkuId, expectedYield, and yieldUnit are required",
        });
      }

      // The formulation's product name always comes from the finished good it
      // produces, so the two can never drift apart.
      const finishedProduct = await prisma.material.findUnique({
        where: { id: finishedSkuId },
        select: { name: true, type: true },
      });
      if (!finishedProduct) {
        return res.status(404).json({ error: "Finished product not found" });
      }
      if (finishedProduct.type !== "FINISHED") {
        return res.status(400).json({
          error: `"${finishedProduct.name}" is not a finished product. Pick a product from Master Data → Products.`,
        });
      }
      const resolvedProductName = finishedProduct.name;

      if (!Array.isArray(ingredients) || ingredients.length === 0) {
        return res.status(400).json({ error: "At least one ingredient is required" });
      }

      // SOP KIB/QCA/010: every ingredient needs a traceability code, otherwise
      // its lot code can never be built when the material is received.
      const ingredientIds = ingredients.map((ing: any) => ing.materialId).filter(Boolean);
      const missingCode = await prisma.material.findFirst({
        where: { id: { in: ingredientIds }, OR: [{ traceabilityCode: null }, { traceabilityCode: "" }] },
        select: { name: true },
      });
      if (missingCode) {
        return res.status(400).json({
          error: `Ingredient "${missingCode.name}" has no traceability code. Add it in Master Data → Materials before saving this formulation.`,
        });
      }

      const bom = await createBatchFormulation({
        productName: resolvedProductName,
        description,
        expectedYield: Number(expectedYield),
        yieldUnit,
        finishedSkuId,
        ingredients: ingredients.map((ing: any) => ({
          materialId: ing.materialId,
          quantity: Number(ing.quantity),
          isPercentage: ing.isPercentage ?? false,
        })),
        createdById: req.user!.id,
      });

      res.status(201).json({ batchFormulation: bom });
    } catch (error: any) {
      console.error("POST /production/batch-formulations error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /batch-formulations/:id — Get single batch formulation
 */
router.get(
  "/batch-formulations/:id",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const bom = await getBatchFormulation(req.params.id);
      res.json({ batchFormulation: bom });
    } catch (error: any) {
      if (error?.message?.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      console.error("GET /production/batch-formulations/:id error:", error);
      res.status(500).json({ error: "Database error" });
    }
  }
);

/**
 * PATCH /batch-formulations/:id — Update batch formulation (DRAFT only)
 */
router.patch(
  "/batch-formulations/:id",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const { productName, description, expectedYield, yieldUnit } = req.body;

      const bom = await updateBatchFormulation(req.params.id, {
        productName,
        description,
        expectedYield: expectedYield !== undefined ? Number(expectedYield) : undefined,
        yieldUnit,
        updatedById: req.user!.id,
      });

      res.json({ batchFormulation: bom });
    } catch (error: any) {
      if (error?.message?.includes("not found") || error?.message?.includes("Cannot update")) {
        return res.status(400).json({ error: error.message });
      }
      console.error("PATCH /production/batch-formulations/:id error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * POST /batch-formulations/:id/ingredients — Add ingredient
 */
router.post(
  "/batch-formulations/:id/ingredients",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const { materialId, quantity, isPercentage } = req.body;

      if (!materialId || quantity === undefined) {
        return res.status(400).json({ error: "materialId and quantity are required" });
      }

      const ingredient = await addIngredient(
        req.params.id,
        materialId,
        Number(quantity),
        isPercentage ?? false
      );

      res.status(201).json({ ingredient });
    } catch (error: any) {
      if (error?.message?.includes("not found") || error?.message?.includes("Cannot add")) {
        return res.status(400).json({ error: error.message });
      }
      console.error("POST /production/batch-formulations/:id/ingredients error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * DELETE /batch-formulations/ingredients/:ingredientId — Remove ingredient
 */
router.delete(
  "/batch-formulations/ingredients/:ingredientId",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const result = await removeIngredient(req.params.ingredientId);
      res.json(result);
    } catch (error: any) {
      if (error?.message?.includes("not found") || error?.message?.includes("Cannot remove")) {
        return res.status(400).json({ error: error.message });
      }
      console.error("DELETE /production/batch-formulations/ingredients/:id error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * POST /batch-formulations/:id/approve — Approve batch formulation (DRAFT → ACTIVE)
 */
router.post(
  "/batch-formulations/:id/approve",
  requirePermission("production", "approve"),
  async (req: Request, res: Response) => {
    try {
      const bom = await approveBatchFormulation(req.params.id, req.user!.id);
      res.json({ batchFormulation: bom, message: `Batch formulation approved` });
    } catch (error: any) {
      if (error?.message?.includes("not found") || error?.message?.includes("Cannot approve")) {
        return res.status(400).json({ error: error.message });
      }
      console.error("POST /production/batch-formulations/:id/approve error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * POST /batch-formulations/:id/archive — Archive batch formulation
 */
router.post(
  "/batch-formulations/:id/archive",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const bom = await archiveBatchFormulation(req.params.id);
      res.json({ batchFormulation: bom, message: "Batch formulation archived" });
    } catch (error: any) {
      if (error?.message?.includes("not found") || error?.message?.includes("already archived")) {
        return res.status(400).json({ error: error.message });
      }
      console.error("POST /production/batch-formulations/:id/archive error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * POST /batch-formulations/:id/duplicate — Duplicate batch formulation
 */
router.post(
  "/batch-formulations/:id/duplicate",
  requirePermission("production", "create"),
  async (req: Request, res: Response) => {
    try {
      const { newProductName } = req.body;

      if (!newProductName) {
        return res.status(400).json({ error: "newProductName is required" });
      }

      const bom = await duplicateBatchFormulation(
        req.params.id,
        newProductName,
        req.user!.id
      );

      res.status(201).json({ batchFormulation: bom, message: "Batch formulation duplicated" });
    } catch (error: any) {
      if (error?.message?.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      console.error("POST /production/batch-formulations/:id/duplicate error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * DELETE /batch-formulations/:id — Delete batch formulation
 */
router.delete(
  "/batch-formulations/:id",
  requirePermission("production", "delete"),
  async (req: Request, res: Response) => {
    try {
      await prisma.bom.delete({ where: { id: req.params.id } });
      res.json({ ok: true });
    } catch (error: any) {
      if (error?.code === "P2025") {
        return res.status(404).json({ error: "Batch formulation not found" });
      }
      console.error("DELETE /production/batch-formulations/:id error:", error);
      res.status(500).json({ error: "Database error" });
    }
  }
);

// ---------------------------------------------------------------------------
// Production Plans (Multi-Product Planning)
// ---------------------------------------------------------------------------

/**
 * GET /production-plans — Get all production plans
 */
router.get(
  "/production-plans",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const { status, search } = req.query;
      const plans = await getProductionPlans({
        status: status ? String(status) : undefined,
        search: search ? String(search) : undefined,
      });
      res.json({ productionPlans: plans });
    } catch (error) {
      console.error("GET /production/production-plans error:", error);
      res.status(500).json({ error: "Database error" });
    }
  }
);

/**
 * POST /production-plans — Create new production plan
 */
router.post(
  "/production-plans",
  requirePermission("production", "create"),
  async (req: Request, res: Response) => {
    try {
      const { description, scheduledFor, items } = req.body;

      const plan = await createProductionPlan({
        description,
        scheduledFor: scheduledFor ? new Date(scheduledFor) : undefined,
        createdById: req.user!.id,
        items: Array.isArray(items)
          ? items.map((it: any) => ({
              bomId: String(it.bomId),
              targetQuantity: Number(it.targetQuantity),
            }))
          : undefined,
      });

      res.status(201).json({ productionPlan: plan });
    } catch (error: any) {
      // Validation failures (duplicate product, missing quantity, unapproved
      // formulation) are user-facing, not server errors.
      if (error instanceof Error && !("code" in error)) {
        console.error("POST /production/production-plans rejected:", error.message);
        return res.status(400).json({ error: error.message });
      }
      console.error("POST /production/production-plans error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * PATCH /production-plans/:id — edit a DRAFT plan and its batch formulas.
 */
router.patch(
  "/production-plans/:id",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const { description, scheduledFor, items } = req.body;
      const plan = await updateProductionPlan(req.params.id, {
        description,
        scheduledFor:
          scheduledFor === undefined
            ? undefined
            : scheduledFor
              ? new Date(scheduledFor)
              : null,
        items: Array.isArray(items)
          ? items.map((it: any) => ({
              bomId: String(it.bomId),
              targetQuantity: Number(it.targetQuantity),
            }))
          : [],
      });
      res.json({ productionPlan: plan });
    } catch (error: any) {
      if (error?.message) {
        return res.status(400).json({ error: error.message });
      }
      console.error("PATCH /production/production-plans/:id error:", error);
      res.status(500).json({ error: "Database error" });
    }
  }
);

/**
 * GET /production-plans/:id — Get single production plan with all details
 */
router.get(
  "/production-plans/:id",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const plan = await getProductionPlan(req.params.id);
      res.json({ productionPlan: plan });
    } catch (error: any) {
      if (error?.message?.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      console.error("GET /production/production-plans/:id error:", error);
      res.status(500).json({ error: "Database error" });
    }
  }
);

/**
 * POST /production-plans/:id/formulations — Add batch formulation to plan
 */
router.post(
  "/production-plans/:id/formulations",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const { bomId, targetQuantity, sequence } = req.body;

      if (!bomId || !(Number(targetQuantity) > 0)) {
        return res.status(400).json({ error: "bomId and a positive targetQuantity are required" });
      }

      const item = await addFormulationToPlan(
        req.params.id,
        bomId,
        Number(targetQuantity),
        sequence ? Number(sequence) : undefined
      );

      res.status(201).json({ item, message: "Formulation added to production plan" });
    } catch (error: any) {
      if (
        error?.message?.includes("not found") ||
        error?.message?.includes("Cannot modify") ||
        error?.message?.includes("greater than zero") ||
        error?.message?.includes("percentage ingredients need") ||
        error?.message?.includes("Cannot calculate")
      ) {
        return res.status(400).json({ error: error.message });
      }
      console.error("POST /production/production-plans/:id/formulations error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * DELETE /production-plans/:id/formulations/:itemId — Remove formulation from plan
 */
router.delete(
  "/production-plans/:planId/formulations/:itemId",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const result = await removeFormulationFromPlan(req.params.planId, req.params.itemId);
      res.json({ ...result, message: "Formulation removed from production plan" });
    } catch (error: any) {
      if (error?.message?.includes("not found") || error?.message?.includes("Cannot modify")) {
        return res.status(400).json({ error: error.message });
      }
      console.error("DELETE /production/production-plans/:planId/formulations/:itemId error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /production-plans/:id/ingredient-requirements
 * Formula-level calculation: per-batch quantity × batches = total required,
 * plus the consolidated requirement that feeds the Ingredient Station.
 */
router.get(
  "/production-plans/:id/ingredient-requirements",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const requirements = await getPlanIngredientRequirements(req.params.id);
      res.json(requirements);
    } catch (error: any) {
      console.error("GET /production/production-plans/:id/ingredient-requirements error:", error);
      if (error?.message?.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      res.status(400).json({ error: error?.message || "Failed to calculate requirements" });
    }
  }
);

/**
 * GET /production-plans/:id/aggregated-ingredients — Get aggregated ingredients for plan
 */
router.get(
  "/production-plans/:id/aggregated-ingredients",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const ingredients = await getPlanAggregatedIngredients(req.params.id);
      res.json({ aggregatedIngredients: ingredients });
    } catch (error: any) {
      console.error("GET /production/production-plans/:id/aggregated-ingredients error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * POST /production-plans/:id/release-ingredients
 * The single, centralized ingredient release action. Confirmation summary is
 * fetched by the client from the ingredient-requirements endpoint.
 */
router.post(
  "/production-plans/:id/release-ingredients",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const { scheduledFor, warehouseId } = req.body ?? {};
      const result = await releasePlanIngredients({
        planId: req.params.id,
        releasedById: req.user!.id,
        scheduledFor: scheduledFor ? new Date(scheduledFor) : undefined,
        warehouseId,
      });
      res.status(201).json({
        message: `Ingredients released for ${result.planNumber}`,
        ...result,
      });
    } catch (error: any) {
      if (error instanceof PlanReleaseError || error?.statusCode) {
        return res.status(error.statusCode ?? 400).json({ error: error.message });
      }
      console.error("POST /production/production-plans/:id/release-ingredients error:", error);
      res.status(500).json({ error: error?.message || "Failed to release ingredients" });
    }
  }
);

/**
 * POST /production-plans/:id/schedule — Legacy alias for the centralized
 * release action, kept so existing clients share the same transaction-safe path.
 */
router.post(
  "/production-plans/:id/schedule",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const { scheduledFor, warehouseId } = req.body;

      if (!scheduledFor) {
        return res.status(400).json({ error: "scheduledFor date is required" });
      }

      const plan = await scheduleProductionPlan(
        req.params.id,
        new Date(scheduledFor),
        req.user!.id,
        warehouseId
      );
      res.json({ productionPlan: plan, message: "Ingredients released" });
    } catch (error: any) {
      if (error instanceof PlanReleaseError || error?.statusCode) {
        return res.status(error.statusCode ?? 400).json({ error: error.message });
      }
      if (error?.message?.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      console.error("POST /production/production-plans/:id/schedule error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * POST /production-plans/:id/start — Start production (SCHEDULED → IN_PROGRESS)
 */
router.post(
  "/production-plans/:id/start",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const plan = await startProductionPlan(req.params.id);
      res.json({ productionPlan: plan, message: "Production plan started" });
    } catch (error: any) {
      if (error?.message?.includes("not found") || error?.message?.includes("Can only start")) {
        return res.status(400).json({ error: error.message });
      }
      console.error("POST /production/production-plans/:id/start error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * POST /production-plans/:id/complete — Complete production (IN_PROGRESS → COMPLETED)
 */
router.post(
  "/production-plans/:id/complete",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const plan = await completeProductionPlan(req.params.id);
      res.json({ productionPlan: plan, message: "Production plan completed" });
    } catch (error: any) {
      if (error?.message?.includes("not found") || error?.message?.includes("Can only complete")) {
        return res.status(400).json({ error: error.message });
      }
      console.error("POST /production/production-plans/:id/complete error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * POST /production-plans/:id/cancel — Cancel production plan
 */
router.post(
  "/production-plans/:id/cancel",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const plan = await cancelProductionPlan(req.params.id);
      res.json({ productionPlan: plan, message: "Production plan cancelled" });
    } catch (error: any) {
      if (error?.message?.includes("not found") || error?.message?.includes("Cannot cancel")) {
        return res.status(400).json({ error: error.message });
      }
      console.error("POST /production/production-plans/:id/cancel error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

// ---------------------------------------------------------------------------
// Legacy BOM endpoints (for backward compatibility) - redirect to batch-formulations
// ---------------------------------------------------------------------------

router.get("/boms", requirePermission("production", "read"), async (req: Request, res: Response) => {
  res.redirect(307, "/api/production/batch-formulations");
});

router.post("/boms", requirePermission("production", "create"), async (req: Request, res: Response) => {
  res.redirect(307, "/api/production/batch-formulations");
});

// ---------------------------------------------------------------------------
// Machines & Shifts
// ---------------------------------------------------------------------------

router.get("/machines", requirePermission("production", "read"), async (_req: Request, res: Response) => {
  try {
    const machines = await prisma.machine.findMany({ orderBy: { name: "asc" } });
    res.json({ machines });
  } catch (error) {
    console.error("GET /production/machines error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/shifts", requirePermission("production", "read"), async (_req: Request, res: Response) => {
  try {
    const shifts = await prisma.shift.findMany({ orderBy: { startTime: "asc" } });
    res.json({ shifts });
  } catch (error) {
    console.error("GET /production/shifts error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// ---------------------------------------------------------------------------
// Production Orders (wizard: BOM -> Schedule)
// Machine and shift are intentionally out of the active planning workflow. The
// nullable columns remain for future ERP integration.
// ---------------------------------------------------------------------------

router.get("/production-orders", requirePermission("production", "read"), async (req: Request, res: Response) => {
  try {
    const { status } = req.query;
    const orders = await prisma.productionOrder.findMany({
      where: status ? { status: status as ProductionOrderStatus } : {},
      include: {
        bom: { include: { finishedSku: { select: { name: true, sku: true } } } },
        createdBy: { select: { fullName: true } },
        finishedBatch: { select: { batchNumber: true, status: true } },
        ingredientsReleasedBy: { select: { fullName: true } },
        yieldLoggedBy: { select: { fullName: true } },
        productionIngredients: {
          include: {
            material: { select: { id: true, name: true, sku: true, unitOfMeasure: true } },
            batchLot: { select: { id: true, batchNumber: true, expiryDate: true } },
            releasedBy: { select: { fullName: true } },
          }
        }
      },
      orderBy: { createdAt: "desc" },
    });

    // Flag which orders already have their station-side plan, so the UI can
    // route progress to the stations. The plan number matches the order number.
    const orderNumbers = orders.map((o) => o.orderNumber);
    const plans = orderNumbers.length
      ? await prisma.productionPlan.findMany({
          where: { planNumber: { in: orderNumbers } },
          select: { id: true, planNumber: true, status: true },
        })
      : [];
    const planByNumber = new Map(plans.map((p) => [p.planNumber, p]));

    // ProductionOrder stores `machineId` without a Prisma relation. Machine and
    // shift are not part of the active planning response anymore.
    res.json({
      productionOrders: orders.map((o) => ({
        ...o,
        planLinked: planByNumber.has(o.orderNumber),
        planId: planByNumber.get(o.orderNumber)?.id ?? null,
        planNumber: planByNumber.get(o.orderNumber)?.planNumber ?? null,
      })),
    });
  } catch (error) {
    console.error("GET /production/production-orders error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.post("/production-orders", requirePermission("production", "create"), async (req: Request, res: Response) => {
  try {
    const { bomId, targetQuantity, scheduledStart } = req.body;
    if (!bomId || !(Number(targetQuantity) > 0)) {
      return res.status(400).json({ error: "bomId and a positive targetQuantity are required" });
    }
    const bom = await prisma.bom.findUnique({
      where: { id: bomId },
      include: {
        finishedSku: { select: { packSize: true, packUnit: true, unitOfMeasure: true } },
        ingredients: {
          include: {
            material: {
              select: {
                id: true,
                name: true,
                packSize: true,
                packUnit: true,
                unitOfMeasure: true,
              },
            },
          },
        },
      },
    });
    if (!bom) return res.status(404).json({ error: "Batch formulation not found" });
    if (bom.status !== "ACTIVE") {
      return res.status(400).json({ error: "Batch formulation must be ACTIVE before creating a production order" });
    }

    const orderNumber = `PRD-${Date.now().toString().slice(-8)}`;
    
    const productionOrder = await prisma.$transaction(async (tx) => {
      const order = await tx.productionOrder.create({
        data: {
          orderNumber,
          bomId,
          targetQuantity: Number(targetQuantity),
          status: "SCHEDULED",
          scheduledStart: scheduledStart ? new Date(scheduledStart) : null,
          createdById: req.user!.id,
        },
        include: { bom: true },
      });

      // Pre-populate ingredients list
      for (const ing of bom.ingredients) {
        const expectedYield = Number(bom.expectedYield);
        const scale = Number(targetQuantity) / (expectedYield > 0 ? expectedYield : 1);
        const projectedQty = ing.isPercentage
          ? percentageIngredientPacks(
              ing.quantity,
              targetQuantity,
              bom.finishedSku,
              ing.material
            )
          : Number(ing.quantity) * scale;

        if (projectedQty === null || !Number.isFinite(projectedQty)) {
          throw new Error(
            `Cannot calculate ${ing.material.name}: percentage ingredients need a weight per pack on both the finished product and the ingredient`
          );
        }

        await tx.productionIngredient.create({
          data: {
            productionOrderId: order.id,
            materialId: ing.materialId,
            projectedQuantity: projectedQty,
          },
        });
      }

      return order;
    });

    res.status(201).json({ productionOrder });
  } catch (error: any) {
    if (error?.message?.includes("percentage ingredients need") || error?.message?.includes("Cannot calculate")) {
      return res.status(400).json({ error: error.message });
    }
    console.error("POST /production/production-orders error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * POST /production-orders/batch — plan several products in one go.
 *
 * All orders are created in a single transaction, so a failure (inactive
 * formulation, duplicate product, bad quantity) creates none of them.
 */
router.post("/production-orders/batch", requirePermission("production", "create"), async (req: Request, res: Response) => {
  try {
    const { orders, scheduledStart } = req.body;

    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ error: "Select at least one product to produce" });
    }

    const bomIds = orders.map((o: any) => String(o.bomId));
    if (new Set(bomIds).size !== bomIds.length) {
      return res.status(400).json({ error: "Each product can only be ordered once" });
    }
    const badQty = orders.find((o: any) => !o.bomId || !(Number(o.targetQuantity) > 0));
    if (badQty) {
      return res.status(400).json({ error: "Every selected product needs a positive target quantity" });
    }

    const boms = await prisma.bom.findMany({
      where: { id: { in: bomIds } },
      include: {
        finishedSku: { select: { packSize: true, packUnit: true, unitOfMeasure: true } },
        ingredients: {
          include: {
            material: {
              select: {
                id: true,
                name: true,
                packSize: true,
                packUnit: true,
                unitOfMeasure: true,
              },
            },
          },
        },
      },
    });
    if (boms.length !== bomIds.length) {
      return res.status(404).json({ error: "One or more batch formulations were not found" });
    }

    const notActive = boms.find((b) => b.status !== "ACTIVE");
    if (notActive) {
      return res.status(400).json({
        error: `"${notActive.productName}" is ${notActive.status}. Set the formulation to ACTIVE before planning it.`,
      });
    }

    const stamp = Date.now().toString().slice(-8);

    const created = await prisma.$transaction(async (tx) => {
      const results = [];
      for (let i = 0; i < orders.length; i++) {
        const bom = boms.find((b) => b.id === orders[i].bomId)!;
        const targetQuantity = Number(orders[i].targetQuantity);

        const order = await tx.productionOrder.create({
          data: {
            orderNumber: `PRD-${stamp}${i}`,
            bomId: bom.id,
            targetQuantity,
            status: "SCHEDULED",
            scheduledStart: scheduledStart ? new Date(scheduledStart) : null,
            createdById: req.user!.id,
          },
          include: { bom: true },
        });

        for (const ing of bom.ingredients) {
          const expectedYield = Number(bom.expectedYield);
          const scale = targetQuantity / (expectedYield > 0 ? expectedYield : 1);
          const projectedQty = ing.isPercentage
            ? percentageIngredientPacks(
                ing.quantity,
                targetQuantity,
                bom.finishedSku,
                ing.material
              )
            : Number(ing.quantity) * scale;

          if (projectedQty === null || !Number.isFinite(projectedQty)) {
            throw new Error(
              `Cannot calculate ${ing.material.name}: percentage ingredients need a weight per pack on both the finished product and the ingredient`
            );
          }

          await tx.productionIngredient.create({
            data: {
              productionOrderId: order.id,
              materialId: ing.materialId,
              projectedQuantity: projectedQty,
            },
          });
        }

        results.push(order);
      }
      return results;
    });

    res.status(201).json({ productionOrders: created });
  } catch (error: any) {
    if (error?.message?.includes("percentage ingredients need") || error?.message?.includes("Cannot calculate")) {
      return res.status(400).json({ error: error.message });
    }
    console.error("POST /production/production-orders/batch error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});

// ---------------------------------------------------------------------------
// Execution (Phase 4): Release / Mix / Returns / Complete -> auto-consumption via the ledger
// ---------------------------------------------------------------------------

router.post("/production-orders/:id/start", requirePermission("production", "update"), async (req: Request, res: Response) => {
  res.redirect(307, `/production/production-orders/${req.params.id}/release`);
});

/**
 * POST /production-orders/:id/release
 * Releases ingredients, updates releasedQuantity/batchLotId, and logs negative PROD_CONSUMPTION entries.
 */
router.post("/production-orders/:id/release", requirePermission("production", "update"), async (req: Request, res: Response) => {
  try {
    const { warehouseId } = req.body ?? {};
    if (!warehouseId) {
      return res.status(400).json({ error: "Select the warehouse the ingredients are released from" });
    }

    const order = await prisma.productionOrder.findUnique({
      where: { id: req.params.id },
      include: { bom: { select: { id: true, productName: true } } },
    });
    if (!order) return res.status(404).json({ error: "Production order not found" });

    if (order.status !== "SCHEDULED") {
      return res.status(409).json({
        error:
          order.status === "RELEASED"
            ? "Ingredients for this order have already been released"
            : `Only scheduled orders can release ingredients (current: ${order.status})`,
      });
    }

    // One order = one plan item. The station-side record is created here, on
    // release, and carries the order number so the plan, the three stations and
    // the ledger all show the same identifier.
    const existing = await prisma.productionPlan.findUnique({
      where: { planNumber: order.orderNumber },
      select: { id: true },
    });

    let planId = existing?.id;
    if (!planId) {
      const created = await createProductionPlan({
        planNumber: order.orderNumber,
        description: `${order.bom?.productName ?? "Production"} — ${order.orderNumber}`,
        scheduledFor: order.scheduledStart ?? new Date(),
        createdById: req.user!.id,
        items: [{ bomId: order.bomId, targetQuantity: Number(order.targetQuantity) }],
      });
      planId = created.id;
    }

    const result = await releasePlanIngredients({
      planId,
      releasedById: req.user!.id,
      scheduledFor: order.scheduledStart ?? undefined,
      warehouseId,
    });

    await prisma.productionOrder.update({
      where: { id: order.id },
      data: {
        status: "RELEASED",
        ingredientsReleasedAt: new Date(),
        ingredientsReleasedById: req.user!.id,
        actualStart: order.scheduledStart ?? null,
      },
    });

    res.status(201).json({
      ok: true,
      planId,
      summary: result.summary,
      message: `Ingredients released for ${order.orderNumber}`,
    });
  } catch (error: any) {
    if (error instanceof PlanReleaseError || error?.statusCode) {
      return res.status(error.statusCode ?? 400).json({ error: error.message });
    }
    console.error("POST /production/production-orders/:id/release error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});

/**
 * POST /production-orders/:id/mix — retired.
 * The mix is recorded at the Grinding Station, alongside the grinding batch number.
 */
router.post("/production-orders/:id/mix", requirePermission("production", "update"), async (_req: Request, res: Response) => {
  // Retired: the mix is captured at the Grinding Station, which stamps the
  // MIX- code on the order together with the grinding batch number.
  res.status(409).json({
    error:
      "Mixing is recorded at the Grinding Station now. Record the grinding batch and its mix units there.",
  });
});

/**
 * POST /production-orders/:id/returns — retired.
 * The station holding the material records the return, so it is never counted twice.
 */
router.post("/production-orders/:id/returns", requirePermission("production", "update"), async (_req: Request, res: Response) => {
  // Retired: unused material is returned by the station that physically holds
  // it (grinding remainders / production losses) so it can never be counted twice.
  res.status(409).json({
    error:
      "Returns are recorded at the station holding the material (Grinding or Production Station).",
  });
});

/**
 * POST /production-orders/:id/complete — retired.
 * Finished goods are posted once, by the Production Station.
 */
router.post("/production-orders/:id/complete", requirePermission("production", "update"), async (_req: Request, res: Response) => {
  // Retired: finished goods are posted once, by the Production Station. This
  // path used to create a second batch lot and a second output ledger entry.
  res.status(409).json({
    error:
      "Production is completed at the Production Station. Record the finished output there.",
  });
});

// ---------------------------------------------------------------------------
// Traceability (Phase 5): Finished batch -> Production Order -> BOM ingredients
// -> consumed raw batches -> GRN -> PO -> Supplier
// ---------------------------------------------------------------------------

// (trace helpers removed — see services/traceabilityService.ts)

// (buildTraceTree removed — see services/traceabilityService.ts)

// Traceability endpoints moved to /api/traceability (routes/traceability.ts,
// services/traceabilityService.ts) — unified upstream + downstream trace across
// both production paths, with consignment-aware inbound resolution.

/**
 * POST /production/waste
 * Logs production / packaging waste via a negative WASTE ledger entry.
 */
router.post("/waste", requirePermission("production", "update"), async (req: Request, res: Response) => {
  try {
    const { materialId, warehouseId, quantity, batchLotId, notes } = req.body;
    if (!materialId || !warehouseId || !quantity) {
      return res.status(400).json({ error: "materialId, warehouseId and quantity are required" });
    }
    const qty = Number(quantity);
    if (!qty || qty <= 0) return res.status(400).json({ error: "quantity must be a positive number" });

    const material = await prisma.material.findUnique({
      where: { id: materialId },
      select: { unitOfMeasure: true },
    });
    if (!material) return res.status(404).json({ error: "Material not found" });

    await postLedgerEntry(prisma, {
      eventType: LedgerEventType.WASTE,
      materialId,
      warehouseId,
      batchLotId: batchLotId ?? null,
      quantity: -qty,
      unitOfMeasure: material.unitOfMeasure,
      referenceType: "PRODUCTION_WASTE",
      createdById: req.user!.id,
      notes: notes ?? "Production waste",
    });

    res.json({ ok: true, message: `Waste of ${qty} ${material.unitOfMeasure} recorded` });
  } catch (error: any) {
    console.error("POST /production/waste error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});

/**
 * DELETE /production-orders/:id — delete a production order (only SCHEDULED status)
 */
router.delete("/production-orders/:id", requirePermission("production", "delete"), async (req: Request, res: Response) => {
  try {
    const order = await prisma.productionOrder.findUnique({
      where: { id: req.params.id },
    });
    if (!order) {
      return res.status(404).json({ error: "Production order not found" });
    }
    if (order.status !== "SCHEDULED") {
      return res.status(409).json({ error: "Can only delete SCHEDULED production orders" });
    }
    await prisma.productionOrder.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (error: any) {
    console.error("DELETE /production/production-orders/:id error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// ---------------------------------------------------------------------------
// Ingredient Lifecycle (Non-Depleting Production Flow)
// ---------------------------------------------------------------------------

/**
 * POST /production-orders/:id/ingredients/release — Release ingredients for production.
 * Transitions from RESERVED → RELEASED when production starts.
 */
router.post(
  "/production-orders/:id/ingredients/release",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const result = await ingredientLifecycle.releaseIngredients({
        productionOrderId: req.params.id,
        releasedById: req.user!.id,
      });
      res.json({ result });
    } catch (error: any) {
      console.error("POST /production/production-orders/:id/ingredients/release error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * PATCH /production-orders/ingredients/:ingredientId/released-quantity — Update released quantity.
 * Tracks consumption as ingredients are used during production.
 */
router.patch(
  "/production-orders/ingredients/:ingredientId/released-quantity",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const { releasedQuantity } = req.body;
      if (releasedQuantity === undefined) {
        return res.status(400).json({ error: "releasedQuantity is required" });
      }

      const ingredient = await ingredientLifecycle.updateReleasedQuantity({
        ingredientId: req.params.ingredientId,
        releasedQuantity: Number(releasedQuantity),
        updatedById: req.user!.id,
      });

      res.json({ ingredient });
    } catch (error: any) {
      console.error("PATCH /production/production-orders/ingredients/:ingredientId/released-quantity error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * POST /production-orders/:id/ingredients/return — Return unused ingredients.
 * Called on production order completion to calculate returned/waste quantities.
 */
router.post(
  "/production-orders/:id/ingredients/return",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const result = await ingredientLifecycle.returnIngredients({
        productionOrderId: req.params.id,
        returnedById: req.user!.id,
      });
      res.json({ result });
    } catch (error: any) {
      console.error("POST /production/production-orders/:id/ingredients/return error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /production-orders/:id/ingredients/lifecycle-status — Get ingredient lifecycle status.
 */
router.get(
  "/production-orders/:id/ingredients/lifecycle-status",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const status = await ingredientLifecycle.getIngredientLifecycleStatus(req.params.id);
      res.json({ status });
    } catch (error: any) {
      console.error("GET /production/production-orders/:id/ingredients/lifecycle-status error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * GET /production-orders/:id/waste-metrics — Get waste and efficiency metrics.
 */
router.get(
  "/production-orders/:id/waste-metrics",
  requirePermission("production", "read"),
  async (req: Request, res: Response) => {
    try {
      const metrics = await ingredientLifecycle.calculateWasteMetrics(req.params.id);
      res.json({ metrics });
    } catch (error: any) {
      console.error("GET /production/production-orders/:id/waste-metrics error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

/**
 * POST /production-orders/:id/complete — Complete production order with waste calculation.
 * Key endpoint that:
 *   1. Calls completeProductionAndProcessWaste()
 *   2. Posts all ledger entries (PROD_CONSUMPTION, WASTE, PROD_OUTPUT)
 *   3. Marks order as COMPLETED
 *   4. Finalizes ingredient lifecycle
 */
router.post(
  "/production-orders/:id/complete",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const { warehouseId } = req.body;
      if (!warehouseId) {
        return res.status(400).json({ error: "warehouseId is required" });
      }

      const order = await prisma.productionOrder.findUnique({
        where: { id: req.params.id },
      });

      if (!order) {
        return res.status(404).json({ error: "Production order not found" });
      }

      // First return any unused ingredients
      await ingredientLifecycle.returnIngredients({
        productionOrderId: req.params.id,
        returnedById: req.user!.id,
      });

      // Then complete and process waste/consumption
      const result = await ingredientLifecycle.completeProductionAndProcessWaste({
        productionOrderId: req.params.id,
        warehouseId,
        completedById: req.user!.id,
      });

      // Get final waste metrics
      const metrics = await ingredientLifecycle.calculateWasteMetrics(req.params.id);

      res.json({
        order: result,
        metrics,
        message: `Production order ${order.orderNumber} completed with ${metrics.wastePercentage}% waste`,
      });
    } catch (error: any) {
      console.error("POST /production/production-orders/:id/complete error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
    }
  }
);

export default router;
