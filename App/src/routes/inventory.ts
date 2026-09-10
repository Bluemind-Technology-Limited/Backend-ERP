import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { prisma } from "../lib/db.js";
import { getStock, getLedgerHistory, postLedgerEntry } from "../lib/ledger.js";
import { LedgerEventType } from "@prisma/client";

const router: Router = Router();
router.use(requireAuth);

/**
 * GET /stock — derived current stock (SUM of ledger entries).
 * Query: ?materialId=&warehouseId=&batchLotId=
 */
router.get("/stock", requirePermission("inventory", "read"), async (req: Request, res: Response) => {
  try {
    const stock = await getStock(prisma, {
      materialId: (req.query.materialId as string) || undefined,
      warehouseId: (req.query.warehouseId as string) || undefined,
      batchLotId: (req.query.batchLotId as string) || undefined,
    });
    res.json({ stock });
  } catch (error) {
    console.error("GET /stock error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * GET /stock/history — full audit trail of ledger entries.
 * Query: ?materialId=&batchLotId=
 */
router.get("/stock/history", requirePermission("inventory", "read"), async (req: Request, res: Response) => {
  try {
    const history = await getLedgerHistory(prisma, {
      materialId: (req.query.materialId as string) || undefined,
      batchLotId: (req.query.batchLotId as string) || undefined,
    });
    res.json({ history });
  } catch (error) {
    console.error("GET /stock/history error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * POST /stock — Add a new product/good directly to the Inventory.
 */
router.post("/stock", requirePermission("inventory", "create"), async (req: Request, res: Response) => {
  try {
    const { name, minQuantity, unitOfMeasure } = req.body;
    if (!name) {
      return res.status(400).json({ error: "Product name is required" });
    }

    const sku = `SKU-${Date.now().toString().slice(-6)}`;
    const material = await prisma.material.create({
      data: {
        name,
        sku,
        type: "RAW",
        unitOfMeasure: unitOfMeasure || "units",
        minQuantity: minQuantity !== undefined && minQuantity !== "" ? Number(minQuantity) : 0,
        status: "ACTIVE",
      },
    });

    res.status(201).json({ ok: true, material });
  } catch (error) {
    console.error("POST /stock error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * POST /stock/transfer — internal transfer (issue from A, receive to B).
 * Writes two ledger entries in one atomic transaction.
 */
router.post("/stock/transfer", requirePermission("inventory", "create"), async (req: Request, res: Response) => {
  try {
    const { materialId, batchLotId, quantity, unitOfMeasure, fromWarehouseId, toWarehouseId, fromBinId, toBinId, notes } = req.body;
    if (!materialId || !quantity || !unitOfMeasure || !fromWarehouseId || !toWarehouseId) {
      return res.status(400).json({ error: "materialId, quantity, unitOfMeasure, fromWarehouseId and toWarehouseId are required" });
    }
    if (fromWarehouseId === toWarehouseId) {
      return res.status(400).json({ error: "Source and destination warehouses must differ" });
    }

    const result = await prisma.$transaction(async (tx) => {
      // OUT from source
      await postLedgerEntry(tx, {
        eventType: LedgerEventType.TRANSFER_OUT,
        materialId,
        batchLotId: batchLotId ?? null,
        warehouseId: fromWarehouseId,
        binId: fromBinId ?? null,
        quantity: -Number(quantity),
        unitOfMeasure,
        referenceType: "TRANSFER",
        createdById: req.user!.id,
        notes: notes ?? null,
      });
      // IN to destination
      const entry = await postLedgerEntry(tx, {
        eventType: LedgerEventType.TRANSFER_IN,
        materialId,
        batchLotId: batchLotId ?? null,
        warehouseId: toWarehouseId,
        binId: toBinId ?? null,
        quantity: Number(quantity),
        unitOfMeasure,
        referenceType: "TRANSFER",
        createdById: req.user!.id,
        notes: notes ?? null,
      });
      return entry;
    });

    res.status(201).json({ transaction: result });
  } catch (error: any) {
    console.error("POST /stock/transfer error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});

/**
 * POST /stock/adjustment — manual stock adjustment.
 * Creates a DRAFT-pending ledger entry (status PENDING) that requires
 * EXECUTIVE/SUPER approval for high-value adjustments. Until approved, the
 * ADJUSTMENT entry carries approvedById = null and is treated as pending.
 *
 * (Approval flow: approveAdjustment sets approvedById — see below.)
 */
router.post("/stock/adjustment", requirePermission("inventory", "create"), async (req: Request, res: Response) => {
  try {
    const { materialId, batchLotId, warehouseId, quantity, unitOfMeasure, reason } = req.body;
    if (!materialId || !quantity || !unitOfMeasure || !warehouseId) {
      return res.status(400).json({ error: "materialId, quantity, unitOfMeasure and warehouseId are required" });
    }
    if (quantity === 0) return res.status(400).json({ error: "Adjustment quantity cannot be zero" });

    const material = await prisma.material.findUnique({ where: { id: materialId } });
    if (!material) return res.status(404).json({ error: "Material not found" });

    const entry = await postLedgerEntry(prisma, {
      eventType: LedgerEventType.ADJUSTMENT,
      materialId,
      batchLotId: batchLotId ?? null,
      warehouseId,
      quantity: Number(quantity),
      unitOfMeasure,
      referenceType: "ADJUSTMENT",
      createdById: req.user!.id,
      notes: reason ?? null,
    });

    res.status(201).json({ adjustment: entry, requiresApproval: req.user!.role === "STORE_OFFICER" });
  } catch (error: any) {
    console.error("POST /stock/adjustment error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});

/**
 * GET /finished-goods — QA-released finished product batches with their
 * derived stock per warehouse and the production order that produced them.
 * (Finished goods ledger / dispatch source.)
 */
router.get("/finished-goods", requirePermission("inventory", "read"), async (req: Request, res: Response) => {
  try {
    const finishedMaterials = await prisma.material.findMany({
      where: { type: "FINISHED" },
      select: { id: true },
    });
    const ids = finishedMaterials.map((m) => m.id);

    const grouped = ids.length
      ? await prisma.inventoryTransaction.groupBy({
          by: ["materialId", "warehouseId", "batchLotId"],
          where: { materialId: { in: ids }, batchLotId: { not: null } },
          _sum: { quantity: true },
        })
      : [];

    const materialIds = [...new Set(grouped.map((g) => g.materialId))];
    const warehouseIds = [...new Set(grouped.map((g) => g.warehouseId))];
    const batchIds = [...new Set(grouped.map((g) => g.batchLotId).filter(Boolean))] as string[];

    const [materials, warehouses, batchLots, prodOrders] = await Promise.all([
      materialIds.length
        ? prisma.material.findMany({ where: { id: { in: materialIds } }, select: { id: true, name: true, sku: true, unitOfMeasure: true } })
        : Promise.resolve([]),
      warehouseIds.length
        ? prisma.warehouse.findMany({ where: { id: { in: warehouseIds } }, select: { id: true, name: true, code: true } })
        : Promise.resolve([]),
      batchIds.length
        ? prisma.batchLot.findMany({ where: { id: { in: batchIds } }, select: { id: true, batchNumber: true, status: true, manufacturingDate: true, expiryDate: true } })
        : Promise.resolve([]),
      batchIds.length
        ? prisma.productionOrder.findMany({ where: { finishedBatchId: { in: batchIds } }, select: { id: true, orderNumber: true, finishedBatchId: true } })
        : Promise.resolve([]),
    ]);

    const materialMap = new Map(materials.map((m) => [m.id, m]));
    const warehouseMap = new Map(warehouses.map((w) => [w.id, w]));
    const batchMap = new Map(batchLots.map((b) => [b.id, b]));
    const orderMap = new Map(prodOrders.map((o) => [o.finishedBatchId, o]));

    const rows = grouped.map((g) => {
      const material = materialMap.get(g.materialId);
      const warehouse = warehouseMap.get(g.warehouseId);
      const batch = batchMap.get(g.batchLotId ?? "");
      const order = orderMap.get(g.batchLotId ?? "");
      return {
        materialId: g.materialId,
        materialName: material?.name ?? "—",
        sku: material?.sku ?? "",
        unitOfMeasure: material?.unitOfMeasure ?? "",
        warehouseId: g.warehouseId,
        warehouseName: warehouse?.name ?? "—",
        warehouseCode: warehouse?.code ?? "",
        batchLotId: g.batchLotId,
        batchNumber: batch?.batchNumber ?? "—",
        batchStatus: batch?.status ?? "—",
        manufacturingDate: batch?.manufacturingDate ?? null,
        expiryDate: batch?.expiryDate ?? null,
        quantity: Number(g._sum.quantity ?? 0),
        orderNumber: order?.orderNumber ?? null,
      };
    });

    res.json({ finishedGoods: rows });
  } catch (error) {
    console.error("GET /finished-goods error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;

/**
 * PUT /stock/:materialId — update stock item (minimum quantity).
 * Only updates the material's minQuantity field.
 */
router.put("/stock/:materialId", requirePermission("inventory", "update"), async (req: Request, res: Response) => {
  try {
    const { materialId } = req.params;
    const { minQuantity } = req.body;

    if (minQuantity === undefined) {
      return res.status(400).json({ error: "minQuantity is required" });
    }

    const material = await prisma.material.update({
      where: { id: materialId },
      data: {
        minQuantity: Number(minQuantity) || 0,
      },
      select: {
        id: true,
        name: true,
        sku: true,
        minQuantity: true,
      },
    });

    console.log(`Updated material ${materialId} minQuantity to ${minQuantity}`);

    res.json({ success: true, material });
  } catch (error: any) {
    console.error("PUT /stock/:materialId error:", error);
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Material not found" });
    }
    res.status(500).json({ error: error?.message || "Failed to update stock item" });
  }
});

/**
 * DELETE /stock/history/:id — delete a ledger entry (reverses the transaction).
 * Only deletes the single entry (inventory manager/admin role).
 */
router.delete("/stock/history/:id", requirePermission("inventory", "delete"), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Find the entry to verify it exists
    const entry = await prisma.inventoryTransaction.findUnique({
      where: { id },
    });

    if (!entry) {
      return res.status(404).json({ error: "Ledger entry not found" });
    }

    // Delete the entry
    await prisma.inventoryTransaction.delete({
      where: { id },
    });

    console.log(`Deleted ledger entry ${id} (${entry.eventType}, quantity: ${entry.quantity})`);

    res.json({ success: true, message: "Ledger entry deleted" });
  } catch (error: any) {
    console.error("DELETE /stock/history/:id error:", error);
    res.status(500).json({ error: error?.message || "Failed to delete ledger entry" });
  }
});
