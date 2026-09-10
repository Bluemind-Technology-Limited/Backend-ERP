import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { prisma } from "../lib/db.js";
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
  getProductionPlans,
  getProductionPlan,
  addFormulationToPlan,
  removeFormulationFromPlan,
  aggregateIngredientsForPlan,
  getPlanAggregatedIngredients,
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

      if (!productName || !finishedSkuId || expectedYield === undefined || !yieldUnit) {
        return res.status(400).json({
          error: "productName, finishedSkuId, expectedYield, and yieldUnit are required",
        });
      }

      if (!Array.isArray(ingredients) || ingredients.length === 0) {
        return res.status(400).json({ error: "At least one ingredient is required" });
      }

      const bom = await createBatchFormulation({
        productName,
        description,
        expectedYield: Number(expectedYield),
        yieldUnit,
        finishedSkuId,
        ingredients: ingredients.map((ing: any) => ({
          materialId: ing.materialId,
          quantity: Number(ing.quantity),
          unitOfMeasure: ing.unitOfMeasure,
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
      const { materialId, quantity, unitOfMeasure, isPercentage } = req.body;

      if (!materialId || quantity === undefined || !unitOfMeasure) {
        return res.status(400).json({ error: "materialId, quantity, and unitOfMeasure are required" });
      }

      const ingredient = await addIngredient(
        req.params.id,
        materialId,
        Number(quantity),
        unitOfMeasure,
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
      const { description, scheduledFor } = req.body;

      const plan = await createProductionPlan({
        description,
        scheduledFor: scheduledFor ? new Date(scheduledFor) : undefined,
        createdById: req.user!.id,
      });

      res.status(201).json({ productionPlan: plan });
    } catch (error: any) {
      console.error("POST /production/production-plans error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
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

      if (!bomId || targetQuantity === undefined) {
        return res.status(400).json({ error: "bomId and targetQuantity are required" });
      }

      const item = await addFormulationToPlan(
        req.params.id,
        bomId,
        Number(targetQuantity),
        sequence ? Number(sequence) : undefined
      );

      res.status(201).json({ item, message: "Formulation added to production plan" });
    } catch (error: any) {
      if (error?.message?.includes("not found") || error?.message?.includes("Cannot modify")) {
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
 * POST /production-plans/:id/schedule — Schedule production plan (DRAFT → SCHEDULED)
 */
router.post(
  "/production-plans/:id/schedule",
  requirePermission("production", "update"),
  async (req: Request, res: Response) => {
    try {
      const { scheduledFor } = req.body;

      if (!scheduledFor) {
        return res.status(400).json({ error: "scheduledFor date is required" });
      }

      const plan = await scheduleProductionPlan(req.params.id, new Date(scheduledFor));
      res.json({ productionPlan: plan, message: "Production plan scheduled" });
    } catch (error: any) {
      if (error?.message?.includes("not found") || error?.message?.includes("Cannot schedule")) {
        return res.status(400).json({ error: error.message });
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

router.post("/machines", requirePermission("production", "create"), async (req: Request, res: Response) => {
  try {
    const { name, code } = req.body;
    if (!name || !code) return res.status(400).json({ error: "name and code are required" });
    const machine = await prisma.machine.create({ data: { name, code } });
    res.status(201).json({ machine });
  } catch (error) {
    console.error("POST /production/machines error:", error);
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
// Production Orders (wizard: BOM -> Schedule -> Machine/Shift)
// ---------------------------------------------------------------------------

router.get("/production-orders", requirePermission("production", "read"), async (req: Request, res: Response) => {
  try {
    const { status } = req.query;
    const orders = await prisma.productionOrder.findMany({
      where: status ? { status: status as ProductionOrderStatus } : {},
      include: {
        bom: { include: { finishedSku: { select: { name: true, sku: true } } } },
        machine: { select: { name: true, code: true } },
        shift: { select: { name: true } },
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
    res.json({ productionOrders: orders });
  } catch (error) {
    console.error("GET /production/production-orders error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.post("/production-orders", requirePermission("production", "create"), async (req: Request, res: Response) => {
  try {
    const { bomId, targetQuantity, scheduledStart, machineId, shiftId } = req.body;
    if (!bomId || !targetQuantity) {
      return res.status(400).json({ error: "bomId and targetQuantity are required" });
    }
    const bom = await prisma.bom.findUnique({
      where: { id: bomId },
      include: { ingredients: true },
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
          machineId: machineId ?? null,
          shiftId: shiftId ?? null,
          createdById: req.user!.id,
        },
        include: { bom: true },
      });

      // Pre-populate ingredients list
      for (const ing of bom.ingredients) {
        const scale = Number(targetQuantity) / Number(bom.expectedYield ?? 1);
        const projectedQty = ing.isPercentage
          ? (Number(ing.quantity) / 100) * scale * Number(bom.expectedYield ?? 1)
          : Number(ing.quantity) * scale;

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
  } catch (error) {
    console.error("POST /production/production-orders error:", error);
    res.status(500).json({ error: "Database error" });
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
    const { warehouseId, ingredients } = req.body;
    if (!warehouseId) {
      return res.status(400).json({ error: "warehouseId is required" });
    }
    if (!ingredients || !Array.isArray(ingredients)) {
      return res.status(400).json({ error: "ingredients list is required" });
    }

    const order = await prisma.productionOrder.findUnique({
      where: { id: req.params.id },
      include: { productionIngredients: true },
    });
    if (!order) return res.status(404).json({ error: "Production order not found" });

    await prisma.$transaction(async (tx) => {
      for (const ingReq of ingredients) {
        const matchingIng = order.productionIngredients.find(i => i.id === ingReq.id);
        if (!matchingIng) throw new Error(`Ingredient requirement ${ingReq.id} not found in this order`);

        const releasedQty = Number(ingReq.releasedQuantity);
        if (releasedQty <= 0) continue;

        await tx.productionIngredient.update({
          where: { id: matchingIng.id },
          data: {
            releasedQuantity: releasedQty,
            batchLotId: ingReq.batchLotId || null,
            releasedAt: new Date(),
            releasedById: req.user!.id,
          },
        });

        const material = await tx.material.findUnique({
          where: { id: matchingIng.materialId },
          select: { unitOfMeasure: true }
        });

        await postLedgerEntry(tx, {
          eventType: LedgerEventType.PROD_CONSUMPTION,
          materialId: matchingIng.materialId,
          batchLotId: ingReq.batchLotId || null,
          warehouseId,
          quantity: -releasedQty,
          unitOfMeasure: material?.unitOfMeasure || "kg",
          referenceType: "PROD_ORDER",
          referenceId: order.id,
          createdById: req.user!.id,
          notes: `Released ingredients for order ${order.orderNumber}`,
        });
      }

      await tx.productionOrder.update({
        where: { id: order.id },
        data: {
          status: "RELEASED",
          ingredientsReleasedAt: new Date(),
          ingredientsReleasedById: req.user!.id,
        },
      });
    });

    res.json({ ok: true, message: `Ingredients released for ${order.orderNumber}` });
  } catch (error: any) {
    console.error("POST /production-orders/:id/release error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});

/**
 * POST /production-orders/:id/mix
 * Records the unit mix generated, generates a mixCode, and transitions status to PROCESSING.
 */
router.post("/production-orders/:id/mix", requirePermission("production", "update"), async (req: Request, res: Response) => {
  try {
    const { mixUnits } = req.body;
    if (!mixUnits || Number(mixUnits) <= 0) {
      return res.status(400).json({ error: "mixUnits is required and must be greater than 0" });
    }

    const order = await prisma.productionOrder.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: "Production order not found" });

    const today = new Date();
    const dateStr = today.toISOString().split("T")[0].replace(/-/g, "");
    const todayStart = new Date(today.setHours(0,0,0,0));
    const count = await prisma.productionOrder.count({
      where: {
        mixLogDate: { gte: todayStart }
      }
    });
    const seqStr = String(count + 1).padStart(3, "0");
    const mixCode = `MIX-${dateStr}-${seqStr}`;

    await prisma.productionOrder.update({
      where: { id: order.id },
      data: {
        mixCode,
        mixUnits: Number(mixUnits),
        mixLogDate: new Date(),
        status: "PROCESSING"
      }
    });

    res.json({ ok: true, mixCode, message: `Batch mix recorded: ${mixCode}` });
  } catch (error: any) {
    console.error("POST /production-orders/:id/mix error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});

/**
 * POST /production-orders/:id/returns
 * Logs returned/deficit ingredients, writing positive ledger entries to restore stock.
 */
router.post("/production-orders/:id/returns", requirePermission("production", "update"), async (req: Request, res: Response) => {
  try {
    const { warehouseId, returns } = req.body;
    if (!warehouseId) {
      return res.status(400).json({ error: "warehouseId is required" });
    }
    if (!returns || !Array.isArray(returns)) {
      return res.status(400).json({ error: "returns list is required" });
    }

    const order = await prisma.productionOrder.findUnique({
      where: { id: req.params.id },
      include: { productionIngredients: true },
    });
    if (!order) return res.status(404).json({ error: "Production order not found" });

    await prisma.$transaction(async (tx) => {
      for (const ret of returns) {
        const matchingIng = order.productionIngredients.find(i => i.id === ret.id);
        if (!matchingIng) throw new Error(`Ingredient ${ret.id} not found in this order`);

        const returnedQty = Number(ret.returnedQuantity);
        if (returnedQty <= 0) continue;

        await tx.productionIngredient.update({
          where: { id: matchingIng.id },
          data: {
            returnedQuantity: returnedQty,
          },
        });

        const material = await tx.material.findUnique({
          where: { id: matchingIng.materialId },
          select: { unitOfMeasure: true }
        });

        await postLedgerEntry(tx, {
          eventType: LedgerEventType.ADJUSTMENT,
          materialId: matchingIng.materialId,
          batchLotId: matchingIng.batchLotId || null,
          warehouseId,
          quantity: returnedQty,
          unitOfMeasure: material?.unitOfMeasure || "kg",
          referenceType: "PROD_ORDER",
          referenceId: order.id,
          createdById: req.user!.id,
          notes: `Deficit return from order ${order.orderNumber}`,
        });
      }
    });

    res.json({ ok: true, message: "Deficit/returns recorded successfully" });
  } catch (error: any) {
    console.error("POST /production-orders/:id/returns error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});

/**
 * POST /production-orders/:id/complete
 * Logs actual yield, creates finished batch lot (expiry 2 years out), and completes the order.
 */
router.post("/production-orders/:id/complete", requirePermission("production", "update"), async (req: Request, res: Response) => {
  try {
    const { batchNumber, warehouseId, actualYield } = req.body;
    if (!batchNumber || !warehouseId || actualYield === undefined) {
      return res.status(400).json({ error: "batchNumber, warehouseId, and actualYield are required" });
    }

    const order = await prisma.productionOrder.findUnique({
      where: { id: req.params.id },
      include: { bom: true },
    });
    if (!order) return res.status(404).json({ error: "Production order not found" });
    if (order.status !== "PROCESSING") return res.status(400).json({ error: "Order must be PROCESSING to complete" });

    const finishedSkuId = order.bom.finishedSkuId;
    const yieldQty = Number(actualYield);

    const targetQty = Number(order.targetQuantity);
    const errorPercentage = targetQty > 0 ? (Math.abs(yieldQty - targetQty) / targetQty) * 100 : 0;

    const expiryDate = new Date();
    expiryDate.setFullYear(expiryDate.getFullYear() + 2);

    const result = await prisma.$transaction(async (tx) => {
      const batchLot = await tx.batchLot.create({
        data: {
          materialId: finishedSkuId!,
          batchNumber,
          manufacturingDate: new Date(),
          expiryDate: expiryDate,
          status: "QUARANTINE",
        },
      });

      await postLedgerEntry(tx, {
        eventType: LedgerEventType.PROD_OUTPUT,
        materialId: finishedSkuId!,
        batchLotId: batchLot.id,
        warehouseId,
        quantity: yieldQty,
        unitOfMeasure: order.bom.yieldUnit || "kg",
        referenceType: "PROD_ORDER",
        referenceId: order.id,
        createdById: req.user!.id,
        notes: `Output for ${order.orderNumber} (batch ${batchNumber})`,
      });

      await tx.inspectionRecord.create({
        data: {
          inspectionType: "FINISHED_BATCH",
          materialId: finishedSkuId!,
          batchLotId: batchLot.id,
          referenceId: order.id,
          result: "PENDING",
        },
      });

      await tx.productionOrder.update({
        where: { id: order.id },
        data: {
          status: "COMPLETED",
          actualEnd: new Date(),
          actualYield: yieldQty,
          errorPercentage: errorPercentage,
          finishedBatchId: batchLot.id,
          yieldLoggedAt: new Date(),
          yieldLoggedById: req.user!.id,
        },
      });

      return batchLot;
    });

    res.json({ ok: true, batchLot: result, message: `Batch ${batchNumber} completed with ${errorPercentage.toFixed(2)}% error` });
  } catch (error: any) {
    console.error("POST /production-orders/:id/complete error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});

// ---------------------------------------------------------------------------
// Traceability (Phase 5): Finished batch -> Production Order -> BOM ingredients
// -> consumed raw batches -> GRN -> PO -> Supplier
// ---------------------------------------------------------------------------

async function getBatchInbound(batchLotId: string) {
  const grnItem = await prisma.goodsReceiptItem.findFirst({
    where: { batchLotId },
    include: {
      grn: {
        include: {
          po: { include: { supplier: { select: { id: true, name: true, contactPerson: true } } } },
        },
      },
    },
  });
  if (!grnItem) return null;
  return {
    grnNumber: grnItem.grn.number,
    receivedAt: grnItem.grn.receivedAt,
    quantity: Number(grnItem.quantity),
    unitOfMeasure: grnItem.unitOfMeasure,
    poNumber: grnItem.grn.po.number,
    orderDate: grnItem.grn.po.orderDate,
    supplier: grnItem.grn.po.supplier,
  };
}

async function buildTraceTree(batchId: string) {
  const batch = await prisma.batchLot.findUnique({
    where: { id: batchId },
    include: {
      material: { select: { id: true, name: true, sku: true, type: true, unitOfMeasure: true } },
    },
  });
  if (!batch) return null;

  const inbound = await getBatchInbound(batch.id);

  // Was this batch produced by a production order (finished good)?
  const prodOrder = await prisma.productionOrder.findFirst({
    where: { finishedBatchId: batch.id },
    include: {
      bom: {
        include: {
          ingredients: {
            include: { material: { select: { id: true, name: true, sku: true, type: true } } },
          },
        },
      },
    },
  });

  let producedBy: any = null;
  let ingredients: any[] = [];
  if (prodOrder) {
    producedBy = {
      orderNumber: prodOrder.orderNumber,
      targetQuantity: Number(prodOrder.targetQuantity),
      actualYield: prodOrder.actualYield ? Number(prodOrder.actualYield) : null,
      completedAt: prodOrder.actualEnd,
      bomId: prodOrder.bom.id,
      bomProductName: prodOrder.bom.productName,
    };

    // Raw batches consumed by this order (from the immutable ledger)
    const consumption = await prisma.inventoryTransaction.findMany({
      where: {
        referenceType: "PROD_ORDER",
        referenceId: prodOrder.id,
        eventType: LedgerEventType.PROD_CONSUMPTION,
        batchLotId: { not: null },
      },
      select: { materialId: true, batchLotId: true },
    });

    ingredients = await Promise.all(
      prodOrder.bom.ingredients.map(async (ing) => {
        const rawBatchIds = consumption
          .filter((t) => t.materialId === ing.materialId)
          .map((t) => t.batchLotId as string);
        const distinct = [...new Set(rawBatchIds)];
        const rawBatches = distinct.length
          ? await prisma.batchLot.findMany({
              where: { id: { in: distinct } },
              select: { id: true, batchNumber: true, status: true, expiryDate: true, manufacturingDate: true },
            })
          : [];
        const rawBatchesWithInbound = await Promise.all(
          rawBatches.map(async (rb) => ({ batch: rb, inbound: await getBatchInbound(rb.id) }))
        );
        return {
          materialId: ing.materialId,
          materialName: ing.material.name,
          sku: ing.material.sku,
          type: ing.material.type,
          quantity: Number(ing.quantity),
          unitOfMeasure: ing.unitOfMeasure,
          isPercentage: ing.isPercentage,
          rawBatches: rawBatchesWithInbound,
        };
      })
    );
  }

  return {
    batch: {
      id: batch.id,
      batchNumber: batch.batchNumber,
      status: batch.status,
      manufacturingDate: batch.manufacturingDate,
      expiryDate: batch.expiryDate,
      material: batch.material,
    },
    inbound,
    producedBy,
    ingredients,
  };
}

/**
 * GET /production/trace/:batchId — traceability tree by batch id.
 */
router.get("/trace/:batchId", requirePermission("production", "read"), async (req: Request, res: Response) => {
  try {
    const tree = await buildTraceTree(req.params.batchId);
    if (!tree) return res.status(404).json({ error: "Batch not found" });
    res.json({ tree });
  } catch (error) {
    console.error("GET /production/trace/:batchId error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * GET /production/trace?batchNumber=XXX — traceability tree by batch number.
 */
router.get("/trace", requirePermission("production", "read"), async (req: Request, res: Response) => {
  try {
    const { batchNumber } = req.query;
    if (!batchNumber) return res.status(400).json({ error: "batchNumber query is required" });
    const batch = await prisma.batchLot.findFirst({ where: { batchNumber: String(batchNumber) } });
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    const tree = await buildTraceTree(batch.id);
    res.json({ tree });
  } catch (error) {
    console.error("GET /production/trace error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * POST /production/waste
 * Logs production / packaging waste via a negative WASTE ledger entry.
 */
router.post("/waste", requirePermission("production", "update"), async (req: Request, res: Response) => {
  try {
    const { materialId, warehouseId, quantity, unitOfMeasure, batchLotId, notes } = req.body;
    if (!materialId || !warehouseId || !quantity || !unitOfMeasure) {
      return res.status(400).json({ error: "materialId, warehouseId, quantity and unitOfMeasure are required" });
    }
    const qty = Number(quantity);
    if (!qty || qty <= 0) return res.status(400).json({ error: "quantity must be a positive number" });

    await postLedgerEntry(prisma, {
      eventType: LedgerEventType.WASTE,
      materialId,
      warehouseId,
      batchLotId: batchLotId ?? null,
      quantity: -qty,
      unitOfMeasure,
      referenceType: "PRODUCTION_WASTE",
      createdById: req.user!.id,
      notes: notes ?? "Production waste",
    });

    res.json({ ok: true, message: `Waste of ${qty} ${unitOfMeasure} recorded` });
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
