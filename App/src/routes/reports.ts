import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { prisma } from "../lib/db.js";
import { getStock } from "../lib/ledger.js";

const router: Router = Router();
router.use(requireAuth);

/**
 * GET /reports/production-efficiency — yield % per production order (actual/target).
 */
router.get("/production-efficiency", requirePermission("reports", "read"), async (req: Request, res: Response) => {
  try {
    const orders = await prisma.productionOrder.findMany({
      include: {
        bom: {
          select: {
            productName: true,
            finishedSku: { select: { name: true, sku: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const rows = orders.map((o) => {
      const target = Number(o.targetQuantity);
      const actual = o.actualYield ? Number(o.actualYield) : null;
      const yieldPct = actual !== null && target > 0 ? Math.round((actual / target) * 1000) / 10 : null;
      return {
        orderNumber: o.orderNumber,
        productName: o.bom.finishedSku?.name ?? o.bom.productName,
        sku: o.bom.finishedSku?.sku ?? "",
        status: o.status,
        targetQuantity: target,
        actualYield: actual,
        yieldPct,
        completedAt: o.actualEnd ?? null,
      };
    });

    const completed = rows.filter((r) => r.yieldPct !== null);
    const summary = {
      totalOrders: rows.length,
      completedOrders: completed.length,
      avgYieldPct: completed.length
        ? Math.round((completed.reduce((sum, r) => sum + (r.yieldPct ?? 0), 0) / completed.length) * 10) / 10
        : null,
      inProgress: rows.filter((r) => r.status === "PROCESSING").length,
      scheduled: rows.filter((r) => r.status === "SCHEDULED").length,
    };

    res.json({ rows, summary });
  } catch (error) {
    console.error("GET /reports/production-efficiency error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * GET /reports/inventory-valuation — on-hand stock × latest purchase cost per material.
 */
router.get("/inventory-valuation", requirePermission("reports", "read"), async (req: Request, res: Response) => {
  try {
    const stock = await getStock(prisma);
    const materialIds = [...new Set(stock.map((s) => s.materialId))];

    // Latest PO unit cost per material (best effort by PO order date)
    const poItems = materialIds.length
      ? await prisma.purchaseOrderItem.findMany({
          where: { materialId: { in: materialIds } },
          include: { po: { select: { orderDate: true } } },
        })
      : [];
    const costMap = new Map<string, { cost: number; date: Date | null }>();
    for (const item of poItems) {
      const existing = costMap.get(item.materialId);
      const itemDate = item.po.orderDate ?? null;
      if (!existing || (itemDate && (!existing.date || itemDate > existing.date))) {
        costMap.set(item.materialId, { cost: Number(item.unitCost), date: itemDate });
      }
    }

    // Aggregate stock per material
    const byMaterial = new Map<
      string,
      { materialId: string; materialName: string; sku: string; unitOfMeasure: string; quantity: number }
    >();
    for (const s of stock) {
      const existing = byMaterial.get(s.materialId) ?? {
        materialId: s.materialId,
        materialName: s.materialName,
        sku: s.sku,
        unitOfMeasure: s.unitOfMeasure,
        quantity: 0,
      };
      existing.quantity += Number(s.quantity);
      byMaterial.set(s.materialId, existing);
    }

    const rows = [...byMaterial.values()].map((m) => {
      const cost = costMap.get(m.materialId)?.cost ?? 0;
      return {
        materialId: m.materialId,
        materialName: m.materialName,
        sku: m.sku,
        unitOfMeasure: m.unitOfMeasure,
        quantity: Math.round(m.quantity * 10000) / 10000,
        unitCost: cost,
        value: Math.round(m.quantity * cost * 100) / 100,
      };
    });

    const totalValue = Math.round(rows.reduce((sum, r) => sum + r.value, 0) * 100) / 100;

    res.json({ rows, summary: { totalValue, materials: rows.length } });
  } catch (error) {
    console.error("GET /reports/inventory-valuation error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
