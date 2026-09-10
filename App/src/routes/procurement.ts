import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { prisma } from "../lib/db.js";
import { RequisitionStatus, PurchaseOrderStatus } from "@prisma/client";
import * as consignmentService from "../services/consignment.js";

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
      
      // If the user did not supply custom edited items, load from requisition defaults
      if (!Array.isArray(items) || items.length === 0) {
        poItems = req.items.map((it) => ({
          materialId: it.materialId,
          quantity: it.quantity,
          unitCost: 0,
          unitOfMeasure: it.unitOfMeasure,
        }));
      }
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

/**
 * DELETE /requisitions/:id — delete a requisition (only DRAFT status)
 */
router.delete("/requisitions/:id", requirePermission("procurement", "delete"), async (req: Request, res: Response) => {
  try {
    const requisition = await prisma.requisition.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });
    if (!requisition) {
      return res.status(404).json({ error: "Requisition not found" });
    }
    if (requisition.status !== "DRAFT") {
      return res.status(409).json({ error: "Can only delete DRAFT requisitions" });
    }

    // Delete in transaction to maintain integrity
    await prisma.$transaction(async (tx) => {
      // 1. Delete requisition items
      await tx.requisitionItem.deleteMany({
        where: { requisitionId: req.params.id },
      });

      // 2. Delete the requisition
      await tx.requisition.delete({
        where: { id: req.params.id },
      });
    });

    res.json({ ok: true, message: "Requisition deleted successfully" });
  } catch (error: any) {
    console.error("DELETE /procurement/requisitions/:id error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * DELETE /purchase-orders/:id — delete a purchase order (DRAFT or CLOSED status)
 */
router.delete("/purchase-orders/:id", requirePermission("procurement", "delete"), async (req: Request, res: Response) => {
  try {
    const purchaseOrder = await prisma.purchaseOrder.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });
    if (!purchaseOrder) {
      return res.status(404).json({ error: "Purchase order not found" });
    }
    
    // Only allow deletion of DRAFT (not yet sent) or CLOSED (finished) orders
    const allowedStatuses = ["DRAFT", "CLOSED"];
    if (!allowedStatuses.includes(purchaseOrder.status)) {
      return res.status(409).json({ 
        error: `Can only delete DRAFT or CLOSED purchase orders. Current status: ${purchaseOrder.status}` 
      });
    }

    // Delete in transaction to maintain integrity
    await prisma.$transaction(async (tx) => {
      // 1. Delete purchase order items
      await tx.purchaseOrderItem.deleteMany({
        where: { poId: req.params.id },
      });

      // 2. Delete the purchase order
      await tx.purchaseOrder.delete({
        where: { id: req.params.id },
      });
    });

    res.json({ ok: true, message: "Purchase order deleted successfully" });
  } catch (error: any) {
    console.error("DELETE /procurement/purchase-orders/:id error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// ---------------------------------------------------------------------------
// Consignments (Grouped shipments - warehouse stocking)
// ---------------------------------------------------------------------------

/**
 * GET /consignments — List all consignments with optional filtering
 */
router.get("/consignments", requirePermission("procurement", "read"), async (req: Request, res: Response) => {
  try {
    const { supplierId, warehouseId, status, skip, take } = req.query;
    const consignments = await consignmentService.getConsignments({
      supplierId: supplierId as string,
      warehouseId: warehouseId as string,
      status: status as any,
      skip: skip ? parseInt(skip as string) : undefined,
      take: take ? parseInt(take as string) : undefined,
    });
    res.json({ consignments });
  } catch (error) {
    console.error("GET /procurement/consignments error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * POST /consignments — Create new consignment
 */
router.post("/consignments", requirePermission("procurement", "create"), async (req: Request, res: Response) => {
  try {
    const { supplierId, warehouseId, poNumbers, shipDate, expectedDelivery } = req.body;
    if (!supplierId || !warehouseId) {
      return res.status(400).json({ error: "supplierId and warehouseId are required" });
    }

    const consignment = await consignmentService.createConsignment({
      supplierId,
      warehouseId,
      createdById: req.user!.id,
      poNumbers,
      shipDate: shipDate ? new Date(shipDate) : undefined,
      expectedDelivery: expectedDelivery ? new Date(expectedDelivery) : undefined,
    });

    res.status(201).json({ consignment });
  } catch (error) {
    console.error("POST /procurement/consignments error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * GET /consignments/:id — Get single consignment with all details
 */
router.get("/consignments/:id", requirePermission("procurement", "read"), async (req: Request, res: Response) => {
  try {
    const consignment = await consignmentService.getConsignment(req.params.id);
    res.json({ consignment });
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Consignment not found" });
    }
    console.error("GET /procurement/consignments/:id error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// ---------------------------------------------------------------------------
// Consignment Items
// ---------------------------------------------------------------------------

/**
 * POST /consignments/:id/items — Add item to consignment
 */
router.post("/consignments/:id/items", requirePermission("procurement", "create"), async (req: Request, res: Response) => {
  try {
    const { materialId, quantity, unitOfMeasure } = req.body;
    if (!materialId || !quantity || !unitOfMeasure) {
      return res.status(400).json({ error: "materialId, quantity, and unitOfMeasure are required" });
    }

    const item = await consignmentService.addItemToConsignment({
      consignmentId: req.params.id,
      materialId,
      quantity,
      unitOfMeasure,
    });

    res.status(201).json({ item });
  } catch (error: any) {
    console.error("POST /procurement/consignments/:id/items error:", error);
    res.status(500).json({ error: error.message || "Database error" });
  }
});

/**
 * PATCH /consignments/items/:itemId — Update consignment item
 */
router.patch("/consignments/items/:itemId", requirePermission("procurement", "update"), async (req: Request, res: Response) => {
  try {
    const { quantity, unitOfMeasure } = req.body;
    if (!quantity || !unitOfMeasure) {
      return res.status(400).json({ error: "quantity and unitOfMeasure are required" });
    }

    const item = await consignmentService.updateConsignmentItem({
      itemId: req.params.itemId,
      quantity,
      unitOfMeasure,
    });

    res.json({ item });
  } catch (error: any) {
    console.error("PATCH /procurement/consignments/items/:itemId error:", error);
    res.status(500).json({ error: error.message || "Database error" });
  }
});

/**
 * DELETE /consignments/items/:itemId — Remove item from consignment
 */
router.delete("/consignments/items/:itemId", requirePermission("procurement", "delete"), async (req: Request, res: Response) => {
  try {
    const deleted = await consignmentService.removeItemFromConsignment(req.params.itemId);
    res.json({ ok: true, item: deleted });
  } catch (error: any) {
    console.error("DELETE /procurement/consignments/items/:itemId error:", error);
    res.status(500).json({ error: error.message || "Database error" });
  }
});

// ---------------------------------------------------------------------------
// Consignment Status Transitions
// ---------------------------------------------------------------------------

/**
 * PATCH /consignments/:id/ready-for-shipment — Mark consignment ready for shipment
 */
router.patch("/consignments/:id/ready-for-shipment", requirePermission("procurement", "update"), async (req: Request, res: Response) => {
  try {
    const { shipDate, expectedDelivery } = req.body;
    if (!shipDate || !expectedDelivery) {
      return res.status(400).json({ error: "shipDate and expectedDelivery are required" });
    }

    const consignment = await consignmentService.markReadyForShipment({
      consignmentId: req.params.id,
      shipDate: new Date(shipDate),
      expectedDelivery: new Date(expectedDelivery),
    });

    res.json({ consignment });
  } catch (error: any) {
    console.error("PATCH /procurement/consignments/:id/ready-for-shipment error:", error);
    res.status(500).json({ error: error.message || "Database error" });
  }
});

/**
 * PATCH /consignments/:id/in-transit — Mark consignment in transit
 */
router.patch("/consignments/:id/in-transit", requirePermission("procurement", "update"), async (req: Request, res: Response) => {
  try {
    const consignment = await consignmentService.markInTransit(req.params.id);
    res.json({ consignment });
  } catch (error: any) {
    console.error("PATCH /procurement/consignments/:id/in-transit error:", error);
    res.status(500).json({ error: error.message || "Database error" });
  }
});

/**
 * PATCH /consignments/:id/receive — Receive consignment at warehouse
 */
router.patch("/consignments/:id/receive", requirePermission("procurement", "update"), async (req: Request, res: Response) => {
  try {
    const consignment = await consignmentService.receiveConsignment({
      consignmentId: req.params.id,
      receivedById: req.user!.id,
    });

    res.json({ consignment });
  } catch (error: any) {
    console.error("PATCH /procurement/consignments/:id/receive error:", error);
    res.status(500).json({ error: error.message || "Database error" });
  }
});

/**
 * PATCH /consignments/:id/distributed — Mark consignment as fully distributed
 */
router.patch("/consignments/:id/distributed", requirePermission("procurement", "update"), async (req: Request, res: Response) => {
  try {
    const consignment = await consignmentService.markAsDistributed(req.params.id);
    res.json({ consignment });
  } catch (error: any) {
    console.error("PATCH /procurement/consignments/:id/distributed error:", error);
    res.status(500).json({ error: error.message || "Database error" });
  }
});

/**
 * PATCH /consignments/:id/completed — Mark consignment as completed
 */
router.patch("/consignments/:id/completed", requirePermission("procurement", "update"), async (req: Request, res: Response) => {
  try {
    const consignment = await consignmentService.markAsCompleted(req.params.id);
    res.json({ consignment });
  } catch (error: any) {
    console.error("PATCH /procurement/consignments/:id/completed error:", error);
    res.status(500).json({ error: error.message || "Database error" });
  }
});

// ---------------------------------------------------------------------------
// Consignment Distribution to Warehouse Bins
// ---------------------------------------------------------------------------

/**
 * GET /consignments/:id/distributions — Get all distributions for consignment
 */
router.get("/consignments/:id/distributions", requirePermission("procurement", "read"), async (req: Request, res: Response) => {
  try {
    const distributions = await consignmentService.getConsignmentDistributions(req.params.id);
    res.json({ distributions });
  } catch (error) {
    console.error("GET /procurement/consignments/:id/distributions error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * POST /consignments/items/:itemId/distribute — Distribute item to warehouse bin
 */
router.post("/consignments/items/:itemId/distribute", requirePermission("procurement", "create"), async (req: Request, res: Response) => {
  try {
    const { binId, quantity } = req.body;
    if (!binId || !quantity) {
      return res.status(400).json({ error: "binId and quantity are required" });
    }

    const distribution = await consignmentService.distributeToWarehouseBin({
      consignmentItemId: req.params.itemId,
      binId,
      quantity,
      distributedById: req.user!.id,
    });

    res.status(201).json({ distribution });
  } catch (error: any) {
    console.error("POST /procurement/consignments/items/:itemId/distribute error:", error);
    res.status(500).json({ error: error.message || "Database error" });
  }
});

/**
 * PATCH /consignments/distributions/:distributionId/complete — Mark distribution complete
 */
router.patch("/consignments/distributions/:distributionId/complete", requirePermission("procurement", "update"), async (req: Request, res: Response) => {
  try {
    const distribution = await consignmentService.markDistributionComplete({
      distributionId: req.params.distributionId,
      completedById: req.user!.id,
    });

    res.json({ distribution });
  } catch (error: any) {
    console.error("PATCH /procurement/consignments/distributions/:distributionId/complete error:", error);
    res.status(500).json({ error: error.message || "Database error" });
  }
});

// ---------------------------------------------------------------------------
// Consignment Status Tracking
// ---------------------------------------------------------------------------

/**
 * GET /consignments/:id/distribution-status — Get distribution status for consignment
 */
router.get("/consignments/:id/distribution-status", requirePermission("procurement", "read"), async (req: Request, res: Response) => {
  try {
    const status = await consignmentService.calculateConsignmentDistributionStatus(req.params.id);
    res.json({ status });
  } catch (error) {
    console.error("GET /procurement/consignments/:id/distribution-status error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * GET /consignments/items/:itemId/distribution-status — Get distribution status for item
 */
router.get("/consignments/items/:itemId/distribution-status", requirePermission("procurement", "read"), async (req: Request, res: Response) => {
  try {
    const status = await consignmentService.calculateItemDistributionStatus(req.params.itemId);
    res.json({ status });
  } catch (error) {
    console.error("GET /procurement/consignments/items/:itemId/distribution-status error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * DELETE /consignments/:id
 * Delete a consignment (only DRAFT, RECEIVED, or QUALITY_PENDING)
 */
router.delete(
  "/consignments/:id",
  requirePermission("procurement", "delete"),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      if (!id) {
        return res.status(400).json({ error: "Consignment ID is required" });
      }

      const result = await consignmentService.deleteConsignment(id);
      res.json(result);
    } catch (error: any) {
      console.error("DELETE /consignments/:id error:", error);

      if (error.message.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      if (error.message.includes("Cannot delete")) {
        return res.status(403).json({ error: error.message });
      }

      res.status(500).json({ error: error?.message || "Failed to delete consignment" });
    }
  }
);

export default router;
