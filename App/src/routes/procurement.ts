import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { prisma } from "../lib/db.js";
import { RequisitionStatus, PurchaseOrderStatus } from "../generated/prisma/client.js";

const router: Router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Requisitions  (STORE_OFFICER creates; PROCUREMENT_OFFICER approves -> PO)
// ---------------------------------------------------------------------------

router.get("/requisitions", requirePermission("procurement", "read"), async (req: Request, res: Response) => {
  try {
    const { status } = req.query;
    const requisitions = await prisma.requisition.findMany({
      where: status ? { status: status as RequisitionStatus } : {},
      include: {
        requestedBy: { select: { id: true, fullName: true, email: true } },
        items: { include: { material: { select: { id: true, name: true, sku: true, unitOfMeasure: true } } } },
        purchaseOrders: { select: { id: true, number: true, status: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ requisitions });
  } catch (error) {
    console.error("GET /procurement/requisitions error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.post("/requisitions", requirePermission("procurement", "create"), async (req: Request, res: Response) => {
  try {
    const { notes, items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "At least one item is required" });
    }
    for (const it of items) {
      if (!it.materialId || !it.quantity || !it.unitOfMeasure) {
        return res.status(400).json({ error: "Each item needs materialId, quantity and unitOfMeasure" });
      }
    }
    const number = `REQ-${Date.now().toString().slice(-8)}`;
    const requisition = await prisma.requisition.create({
      data: {
        number,
        requestedById: req.user!.id,
        notes,
        status: "DRAFT",
        items: {
          create: items.map((it) => ({
            materialId: it.materialId,
            quantity: it.quantity,
            unitOfMeasure: it.unitOfMeasure,
          })),
        },
      },
      include: { items: true },
    });
    res.status(201).json({ requisition });
  } catch (error) {
    console.error("POST /procurement/requisitions error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.patch("/requisitions/:id/submit", requirePermission("procurement", "update"), async (req: Request, res: Response) => {
  try {
    const requisition = await prisma.requisition.update({
      where: { id: req.params.id },
      data: { status: "PENDING_APPROVAL" },
    });
    res.json({ requisition });
  } catch (error) {
    console.error("PATCH /procurement/requisitions/:id/submit error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.patch("/requisitions/:id/approve", requirePermission("procurement", "approve"), async (req: Request, res: Response) => {
  try {
    const requisition = await prisma.requisition.update({
      where: { id: req.params.id },
      data: { status: "APPROVED" },
    });
    res.json({ requisition });
  } catch (error) {
    console.error("PATCH /procurement/requisitions/:id/approve error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.patch("/requisitions/:id/reject", requirePermission("procurement", "approve"), async (req: Request, res: Response) => {
  try {
    const requisition = await prisma.requisition.update({
      where: { id: req.params.id },
      data: { status: "REJECTED" },
    });
    res.json({ requisition });
  } catch (error) {
    console.error("PATCH /procurement/requisitions/:id/reject error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// ---------------------------------------------------------------------------
// Purchase Orders  (PROCUREMENT_OFFICER creates from approved requisition)
// ---------------------------------------------------------------------------

router.get("/purchase-orders", requirePermission("procurement", "read"), async (req: Request, res: Response) => {
  try {
    const { status } = req.query;
    const purchaseOrders = await prisma.purchaseOrder.findMany({
      where: status ? { status: status as PurchaseOrderStatus } : {},
      include: {
        supplier: { select: { id: true, name: true } },
        requisition: { select: { id: true, number: true, status: true } },
        createdBy: { select: { id: true, fullName: true } },
        items: { include: { material: { select: { id: true, name: true, sku: true, unitOfMeasure: true } } } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ purchaseOrders });
  } catch (error) {
    console.error("GET /procurement/purchase-orders error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.post("/purchase-orders", requirePermission("procurement", "create"), async (req: Request, res: Response) => {
  try {
    const { supplierId, requisitionId, notes, expectedDelivery, items } = req.body;
    if (!supplierId) return res.status(400).json({ error: "supplierId is required" });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "At least one item is required" });
    }

    // If converting from an approved requisition, pull its items.
    let poItems = items;
    if (requisitionId) {
      const req = await prisma.requisition.findUnique({
        where: { id: requisitionId },
        include: { items: true },
      });
      if (!req) return res.status(404).json({ error: "Requisition not found" });
      if (req.status !== "APPROVED") return res.status(400).json({ error: "Requisition must be APPROVED first" });
      poItems = req.items.map((it) => ({
        materialId: it.materialId,
        quantity: it.quantity,
        unitCost: 0, // set by procurement officer
        unitOfMeasure: it.unitOfMeasure,
      }));
    }

    const number = `PO-${Date.now().toString().slice(-8)}`;
    const purchaseOrder = await prisma.purchaseOrder.create({
      data: {
        number,
        supplierId,
        requisitionId: requisitionId ?? null,
        createdById: req.user!.id,
        status: "DRAFT",
        notes,
        expectedDelivery: expectedDelivery ? new Date(expectedDelivery) : null,
        items: {
          create: poItems.map((it) => ({
            materialId: it.materialId,
            quantity: it.quantity,
            unitCost: it.unitCost ?? 0,
            unitOfMeasure: it.unitOfMeasure,
          })),
        },
      },
      include: { items: true },
    });
    res.status(201).json({ purchaseOrder });
  } catch (error) {
    console.error("POST /procurement/purchase-orders error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.patch("/purchase-orders/:id/status", requirePermission("procurement", "update"), async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    if (!["DRAFT", "SENT", "PARTIAL", "RECEIVED", "CLOSED"].includes(status)) {
      return res.status(400).json({ error: "Invalid PO status" });
    }
    const purchaseOrder = await prisma.purchaseOrder.update({
      where: { id: req.params.id },
      data: { status: status as PurchaseOrderStatus },
    });
    res.json({ purchaseOrder });
  } catch (error) {
    console.error("PATCH /procurement/purchase-orders/:id/status error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
