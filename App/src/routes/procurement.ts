import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { prisma } from "../lib/db.js";
import { RequisitionStatus, PurchaseOrderStatus } from "@prisma/client";
import * as consignmentService from "../services/consignment.js";
import { logActivity } from "../services/userActivityLogger.js";
import {
  getLpoPreview,
  sendLpos,
  LpoValidationError,
} from "../services/lpoService.js";

const router: Router = Router();
router.use(requireAuth);

/** Shared shape for requisition list/detail/edit responses. */
const REQUISITION_INCLUDE = {
  requestedBy: { select: { id: true, fullName: true, email: true } },
  items: {
    include: {
      material: {
        select: {
          id: true,
          name: true,
          sku: true,
          unitOfMeasure: true,
          type: true,
          suppliers: {
            include: {
              supplier: {
                select: {
                  id: true,
                  name: true,
                  contactPerson: true,
                  email: true,
                  phone: true,
                },
              },
            },
          },
        },
      },
    },
  },
  purchaseOrders: { select: { id: true, number: true, status: true } },
};

// ---------------------------------------------------------------------------
// Requisitions  (STORE_OFFICER creates; PROCUREMENT_OFFICER approves -> PO)
// ---------------------------------------------------------------------------

router.get("/requisitions", requirePermission("procurement", "read"), async (req: Request, res: Response) => {
  try {
    const { status } = req.query;
    const requisitions = await prisma.requisition.findMany({
      where: status ? { status: status as RequisitionStatus } : {},
      include: REQUISITION_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
    res.json({ requisitions });
  } catch (error) {
    console.error("GET /procurement/requisitions error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * GET /procurement/requisitions/:id
 * Full detail for the approver (items + material suppliers + linked POs).
 */
router.get("/requisitions/:id", requirePermission("procurement", "read"), async (req: Request, res: Response) => {
  try {
    const requisition = await prisma.requisition.findUnique({
      where: { id: req.params.id },
      include: REQUISITION_INCLUDE,
    });
    if (!requisition) return res.status(404).json({ error: "Requisition not found" });
    res.json({ requisition });
  } catch (error) {
    console.error("GET /procurement/requisitions/:id error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * GET /procurement/requisitions/:id/lpo/preview
 * Supplier grouping + line data for the Generate & Send modal.
 */
router.get(
  "/requisitions/:id/lpo/preview",
  requirePermission("procurement", "read"),
  async (req: Request, res: Response) => {
    try {
      const preview = await getLpoPreview(req.params.id);
      res.json(preview);
    } catch (error: any) {
      if (/not found/i.test(error?.message ?? "")) {
        return res.status(404).json({ error: error.message });
      }
      if (/approved/i.test(error?.message ?? "")) {
        return res.status(400).json({ error: error.message });
      }
      console.error("GET /procurement/requisitions/:id/lpo/preview error:", error);
      res.status(500).json({ error: error?.message || "Failed to prepare LPO preview" });
    }
  }
);

/**
 * POST /procurement/requisitions/:id/lpo/send
 * Creates/reuses the single internal PO, generates one LPO PDF per supplier,
 * emails each supplier, and marks the PO SENT when every email succeeds.
 */
router.post(
  "/requisitions/:id/lpo/send",
  requirePermission("procurement", "update"),
  async (req: Request, res: Response) => {
    try {
      const { selections, unitCosts, notes, expectedDelivery } = req.body ?? {};
      const result = await sendLpos({
        requisitionId: req.params.id,
        userId: req.user!.id,
        selections: selections && typeof selections === "object" ? selections : {},
        unitCosts: unitCosts && typeof unitCosts === "object" ? unitCosts : {},
        notes,
        expectedDelivery,
      });
      res.status(201).json(result);
    } catch (error: any) {
      if (error instanceof LpoValidationError) {
        return res.status(400).json({ error: error.message, issues: error.issues });
      }
      if (/not found/i.test(error?.message ?? "")) {
        return res.status(404).json({ error: error.message });
      }
      if (/approved|already|receipts|email/i.test(error?.message ?? "")) {
        return res.status(409).json({ error: error.message });
      }
      console.error("POST /procurement/requisitions/:id/lpo/send error:", error);
      res.status(500).json({ error: error?.message || "Failed to send LPOs" });
    }
  }
);

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

    // Finished products are produced in-house, never requisitioned from suppliers.
    const materialIds = [...new Set(items.map((it: any) => String(it.materialId)))];
    const materials = await prisma.material.findMany({
      where: { id: { in: materialIds } },
      select: { id: true, name: true, type: true },
    });
    if (materials.length !== materialIds.length) {
      return res.status(400).json({ error: "One or more materials were not found" });
    }
    const finished = materials.find((m) => m.type === "FINISHED");
    if (finished) {
      return res.status(400).json({
        error: `"${finished.name}" is a finished product and cannot be requisitioned`,
      });
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
      include: REQUISITION_INCLUDE,
    });
    res.status(201).json({ requisition });
  } catch (error) {
    console.error("POST /procurement/requisitions error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * PATCH /procurement/requisitions/:id/items
 * Approver edits line items (quantity up/down, add/remove) before deciding,
 * and creators can edit drafts. Only allowed while DRAFT or PENDING_APPROVAL
 * and while no purchase order exists.
 */
router.patch("/requisitions/:id/items", requirePermission("procurement", "update"), async (req: Request, res: Response) => {
  try {
    const { items, notes } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "At least one item is required" });
    }
    for (const it of items) {
      if (!it.materialId || !(Number(it.quantity) > 0) || !it.unitOfMeasure) {
        return res.status(400).json({ error: "Each item needs materialId, a quantity greater than zero and unitOfMeasure" });
      }
    }

    const existing = await prisma.requisition.findUnique({
      where: { id: req.params.id },
      include: {
        items: { include: { material: { select: { name: true } } } },
        purchaseOrders: { select: { id: true } },
      },
    });
    if (!existing) return res.status(404).json({ error: "Requisition not found" });
    if (existing.status !== "DRAFT" && existing.status !== "PENDING_APPROVAL") {
      return res.status(409).json({ error: "Only draft or pending requisitions can be edited" });
    }
    if (existing.purchaseOrders.length > 0) {
      return res.status(409).json({ error: "A purchase order already exists for this requisition" });
    }

    // Finished products are produced in-house, never requisitioned from suppliers.
    const materialIds = [...new Set(items.map((it: any) => String(it.materialId)))];
    const materials = await prisma.material.findMany({
      where: { id: { in: materialIds } },
      select: { id: true, name: true, type: true },
    });
    if (materials.length !== materialIds.length) {
      return res.status(400).json({ error: "One or more materials were not found" });
    }
    const finished = materials.find((m) => m.type === "FINISHED");
    if (finished) {
      return res.status(400).json({
        error: `"${finished.name}" is a finished product and cannot be requisitioned`,
      });
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.requisitionItem.deleteMany({ where: { requisitionId: existing.id } });
      return tx.requisition.update({
        where: { id: existing.id },
        data: {
          ...(notes !== undefined ? { notes } : {}),
          items: {
            create: items.map((it: any) => ({
              materialId: it.materialId,
              quantity: Number(it.quantity),
              unitOfMeasure: it.unitOfMeasure,
            })),
          },
        },
        include: REQUISITION_INCLUDE,
      });
    });

    await logActivity({
      userId: req.user!.id,
      activityType: "UPDATE",
      module: "procurement",
      description: `Edited requisition ${updated.number} (${updated.items.length} item(s))`,
      entityType: "Requisition",
      entityId: updated.id,
      details: {
        before: existing.items.map((it) => ({
          material: it.material.name,
          quantity: Number(it.quantity),
          unitOfMeasure: it.unitOfMeasure,
        })),
        after: items,
      },
    }).catch((logError) => {
      // The edit already committed; a failed audit write should not fail the request.
      console.error("Failed to log requisition edit:", logError);
    });

    res.json({ requisition: updated });
  } catch (error) {
    console.error("PATCH /procurement/requisitions/:id/items error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.patch("/requisitions/:id/submit", requirePermission("procurement", "update"), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.requisition.findUnique({
      where: { id: req.params.id },
      select: { status: true },
    });
    if (!existing) return res.status(404).json({ error: "Requisition not found" });
    if (existing.status !== "DRAFT") {
      return res.status(409).json({ error: "Only draft requisitions can be submitted" });
    }

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
        items: {
          include: {
            material: { select: { id: true, name: true, sku: true, unitOfMeasure: true } },
            supplier: { select: { id: true, name: true } },
          },
        },
        consignments: {
          select: { id: true, consignmentNumber: true, receivedAt: true, status: true },
          orderBy: { receivedAt: "asc" },
        },
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
    if (!requisitionId) {
      return res.status(400).json({
        error: "A purchase order must be raised from an approved requisition — select the requisition first.",
      });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "At least one item is required" });
    }

    // SOP KIB/QCA/010: the supplier needs a vendor code, otherwise every lot code
    // received against this PO would be unbuildable.
    const supplier = await prisma.supplier.findUnique({
      where: { id: supplierId },
      select: { name: true, vendorCode: true },
    });
    if (!supplier) return res.status(404).json({ error: "Supplier not found" });
    if (!supplier.vendorCode) {
      return res.status(400).json({
        error: `Supplier "${supplier.name}" has no vendor code. Add it in Master Data → Suppliers before raising this PO.`,
      });
    }

    // Each item must actually be sourced from this supplier — a material knows
    // who supplies it (Master Data → Materials).
    const requestedMaterialIds = items
      .map((it: any) => it.materialId)
      .filter(Boolean);
    if (requestedMaterialIds.length) {
      const linked = await prisma.materialSupplier.findMany({
        where: { supplierId, materialId: { in: requestedMaterialIds } },
        select: { materialId: true },
      });
      const linkedIds = new Set(linked.map((l) => l.materialId));
      const unlinkedIds = requestedMaterialIds.filter((id: string) => !linkedIds.has(id));

      if (unlinkedIds.length) {
        const material = await prisma.material.findFirst({
          where: { id: { in: unlinkedIds } },
          select: { name: true },
        });
        return res.status(400).json({
          error: `"${material?.name ?? "A material"}" is not supplied by ${supplier.name}. Link it in Master Data → Materials, or raise a separate PO with its own supplier.`,
        });
      }
    }

    // A PO only carries lines that were approved on its requisition — never
    // free-typed materials.
    const requisition = await prisma.requisition.findUnique({
      where: { id: requisitionId },
      include: { items: true },
    });
    if (!requisition) return res.status(404).json({ error: "Requisition not found" });
    if (requisition.status !== "APPROVED") {
      return res.status(400).json({ error: "Requisition must be APPROVED before raising a purchase order" });
    }

    const requisitionMaterialIds = new Set(requisition.items.map((it) => it.materialId));
    const offRequisition = items.find((it: any) => !requisitionMaterialIds.has(it.materialId));
    if (offRequisition) {
      const material = await prisma.material.findUnique({
        where: { id: offRequisition.materialId },
        select: { name: true },
      });
      return res.status(400).json({
        error: `"${material?.name ?? "A material"}" is not on ${requisition.number}. Add it to a requisition first.`,
      });
    }

    // If the caller supplied no items, take them straight from the requisition.
    let poItems = items;
    if (items.length === 0) {
      poItems = requisition.items.map((it) => ({
        materialId: it.materialId,
        quantity: it.quantity,
        unitCost: 0,
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
    if (!["DRAFT", "SENT", "PARTIALLY_RECEIVED", "RECEIVED", "CLOSED"].includes(status)) {
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
    const { supplierId, warehouseId, poId, poNumbers, shipDate, expectedDelivery, receivedAt, notes, items } = req.body;
    if (!supplierId || !warehouseId) {
      return res.status(400).json({ error: "supplierId and warehouseId are required" });
    }
    if (!poId) {
      return res.status(400).json({ error: "Select a purchase order — a consignment records what arrived from it" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Select at least one material that arrived" });
    }

    const consignment = await consignmentService.createConsignment({
      supplierId,
      warehouseId,
      createdById: req.user!.id,
      poId,
      notes: notes ?? null,
      poNumbers,
      shipDate: shipDate ? new Date(shipDate) : undefined,
      expectedDelivery: expectedDelivery ? new Date(expectedDelivery) : undefined,
      receivedAt: receivedAt ? new Date(receivedAt) : undefined,
      items,
    });

    res.status(201).json({ consignment });
  } catch (error: any) {
    console.error("POST /procurement/consignments error:", error);
    res.status(400).json({ error: error?.message || "Database error" });
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
    const { materialId, quantity, unitOfMeasure, poItemId } = req.body;
    if (!materialId || !quantity || !unitOfMeasure) {
      return res.status(400).json({ error: "materialId, quantity, and unitOfMeasure are required" });
    }

    const item = await consignmentService.addItemToConsignment({
      consignmentId: req.params.id,
      materialId,
      quantity,
      unitOfMeasure,
      poItemId: poItemId ?? null,
    });

    res.status(201).json({ item });
  } catch (error: any) {
    console.error("POST /procurement/consignments/:id/items error:", error);
    res.status(400).json({ error: error.message || "Database error" });
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
