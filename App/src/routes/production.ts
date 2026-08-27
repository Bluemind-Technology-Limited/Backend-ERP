import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { prisma } from "../lib/db.js";
import { postLedgerEntry } from "../lib/ledger.js";
import { LedgerEventType, ProductionOrderStatus } from "@prisma/client";

const router: Router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// BOM / Recipes (version-controlled)
// ---------------------------------------------------------------------------

router.get("/boms", requirePermission("production", "read"), async (_req: Request, res: Response) => {
  try {
    const boms = await prisma.bom.findMany({
      include: {
        versions: {
          orderBy: { version: "desc" },
          include: {
            finishedSku: { select: { id: true, name: true, sku: true } },
            ingredients: {
              include: { material: { select: { id: true, name: true, sku: true, type: true, unitOfMeasure: true } } },
            },
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    });
    res.json({ boms });
  } catch (error) {
    console.error("GET /production/boms error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.post("/boms", requirePermission("production", "create"), async (req: Request, res: Response) => {
  try {
    const { productName, description, version, expectedYield, yieldUnit, finishedSkuId, ingredients } = req.body;
    if (!productName || !finishedSkuId || !expectedYield || !yieldUnit) {
      return res.status(400).json({ error: "productName, finishedSkuId, expectedYield and yieldUnit are required" });
    }
    if (!Array.isArray(ingredients) || ingredients.length === 0) {
      return res.status(400).json({ error: "At least one ingredient is required" });
    }

    const bom = await prisma.$transaction(async (tx) => {
      const created = await tx.bom.create({
        data: { productName, description: description ?? null },
      });
      await tx.bomVersion.create({
        data: {
          bomId: created.id,
          version: version ?? 1,
          description: description ?? null,
          expectedYield: Number(expectedYield),
          yieldUnit,
          finishedSkuId,
          ingredients: {
            create: ingredients.map((ing: any) => ({
              materialId: ing.materialId,
              quantity: Number(ing.quantity),
              unitOfMeasure: ing.unitOfMeasure,
              isPercentage: ing.isPercentage ?? false,
            })),
          },
        },
      });
      return created;
    });

    res.status(201).json({ bom });
  } catch (error) {
    console.error("POST /production/boms error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * DELETE /boms/:id — delete a BOM and all its versions
 */
router.delete("/boms/:id", requirePermission("production", "delete"), async (req: Request, res: Response) => {
  try {
    await prisma.bom.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (error: any) {
    if (error?.code === "P2025") {
      return res.status(404).json({ error: "BOM not found" });
    }
    console.error("DELETE /production/boms/:id error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.patch("/boms/:id/versions/:version/status", requirePermission("production", "approve"), async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    if (!["DRAFT", "ACTIVE", "APPROVED", "ARCHIVED"].includes(status)) {
      return res.status(400).json({ error: "Invalid BOM status" });
    }
    const bomVersion = await prisma.bomVersion.update({
      where: { bomId_version: { bomId: req.params.id, version: Number(req.params.version) } },
      data: { status },
    });
    res.json({ bomVersion });
  } catch (error) {
    console.error("PATCH /production/boms/:id/versions/:version/status error:", error);
    res.status(500).json({ error: "Database error" });
  }
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
        bomVersion: { include: { bom: true, finishedSku: { select: { name: true, sku: true } } } },
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
    const { bomVersionId, targetQuantity, scheduledStart, machineId, shiftId } = req.body;
    if (!bomVersionId || !targetQuantity) {
      return res.status(400).json({ error: "bomVersionId and targetQuantity are required" });
    }
    const bomVersion = await prisma.bomVersion.findUnique({
      where: { id: bomVersionId },
      include: { ingredients: true },
    });
    if (!bomVersion) return res.status(404).json({ error: "BOM version not found" });
    if (bomVersion.status === "DRAFT") {
      return res.status(400).json({ error: "BOM must be APPROVED/ACTIVE before creating a production order" });
    }

    const orderNumber = `PRD-${Date.now().toString().slice(-8)}`;
    
    const productionOrder = await prisma.$transaction(async (tx) => {
      const order = await tx.productionOrder.create({
        data: {
          orderNumber,
          bomVersionId,
          targetQuantity: Number(targetQuantity),
          status: "SCHEDULED",
          scheduledStart: scheduledStart ? new Date(scheduledStart) : null,
          machineId: machineId ?? null,
          shiftId: shiftId ?? null,
          createdById: req.user!.id,
        },
        include: { bomVersion: true },
      });

      // Pre-populate ingredients list
      for (const ing of bomVersion.ingredients) {
        const scale = Number(targetQuantity) / Number(bomVersion.expectedYield);
        const projectedQty = ing.isPercentage
          ? (Number(ing.quantity) / 100) * scale * Number(bomVersion.expectedYield)
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
      include: { bomVersion: true },
    });
    if (!order) return res.status(404).json({ error: "Production order not found" });
    if (order.status !== "PROCESSING") return res.status(400).json({ error: "Order must be PROCESSING to complete" });

    const finishedSkuId = order.bomVersion.finishedSkuId;
    const yieldQty = Number(actualYield);

    const targetQty = Number(order.targetQuantity);
    const errorPercentage = targetQty > 0 ? (Math.abs(yieldQty - targetQty) / targetQty) * 100 : 0;

    const expiryDate = new Date();
    expiryDate.setFullYear(expiryDate.getFullYear() + 2);

    const result = await prisma.$transaction(async (tx) => {
      const batchLot = await tx.batchLot.create({
        data: {
          materialId: finishedSkuId,
          batchNumber,
          manufacturingDate: new Date(),
          expiryDate: expiryDate,
          status: "QUARANTINE",
        },
      });

      await postLedgerEntry(tx, {
        eventType: LedgerEventType.PROD_OUTPUT,
        materialId: finishedSkuId,
        batchLotId: batchLot.id,
        warehouseId,
        quantity: yieldQty,
        unitOfMeasure: order.bomVersion.yieldUnit,
        referenceType: "PROD_ORDER",
        referenceId: order.id,
        createdById: req.user!.id,
        notes: `Output for ${order.orderNumber} (batch ${batchNumber})`,
      });

      await tx.inspectionRecord.create({
        data: {
          inspectionType: "FINISHED_BATCH",
          materialId: finishedSkuId,
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
      bomVersion: {
        include: {
          bom: { select: { id: true, productName: true } },
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
      bomId: prodOrder.bomVersion.bom.id,
      bomProductName: prodOrder.bomVersion.bom.productName,
      bomVersion: prodOrder.bomVersion.version,
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
      prodOrder.bomVersion.ingredients.map(async (ing) => {
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

export default router;
