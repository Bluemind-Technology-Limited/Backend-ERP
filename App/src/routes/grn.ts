import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { prisma } from "../lib/db.js";
import { postLedgerEntry } from "../lib/ledger.js";
import { LedgerEventType, GoodsReceiptStatus } from "@prisma/client";
import * as consignmentService from "../services/consignment.js";

const router: Router = Router();
router.use(requireAuth);

/**
 * GET /grn — list goods receipts.
 */
router.get("/", requirePermission("procurement", "read"), async (req: Request, res: Response) => {
  try {
    const { status } = req.query;
    const grns = await prisma.goodsReceipt.findMany({
      where: status ? { status: status as GoodsReceiptStatus } : {},
      include: {
        po: { select: { id: true, number: true, status: true, supplier: { select: { name: true } } } },
        receivedBy: { select: { fullName: true, email: true } },
        items: {
          include: {
            material: { select: { name: true, sku: true } },
            batchLot: { select: { id: true, batchNumber: true, expiryDate: true, status: true } },
          },
        },
      },
      orderBy: { receivedAt: "desc" },
    });
    res.json({ grns });
  } catch (error) {
    console.error("GET /grn error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * POST /grn — receive goods against a PO.
 * In ONE atomic transaction:
 *   1. creates/links BatchLot (with batch number + expiry)
 *   2. creates GoodsReceiptItem
 *   3. posts PO_RECEIPT ledger entries (+quantity) — the ONLY way stock enters
 *   4. creates a PENDING_QA InspectionRecord per batch
 *   5. bumps PO receivedQty / status
 */
router.post("/", requirePermission("procurement", "create"), async (req: Request, res: Response) => {
  try {
    const { poId, notes, items } = req.body;
    if (!poId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "poId and items are required" });
    }

    const po = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: { items: true },
    });
    if (!po) return res.status(404).json({ error: "Purchase order not found" });
    if (po.status === "CLOSED") return res.status(400).json({ error: "PO is already closed" });

    const number = `GRN-${Date.now().toString().slice(-8)}`;

    const grn = await prisma.$transaction(async (tx) => {
      const receipt = await tx.goodsReceipt.create({
        data: {
          number,
          poId,
          receivedById: req.user!.id,
          status: "PENDING_QA",
          receivedAt: new Date(),
          notes,
        },
      });

      for (const it of items) {
        const { materialId, quantity, unitOfMeasure, batchNumber, expiryDate, manufacturingDate, warehouseId } = it;
        if (!materialId || !quantity || !unitOfMeasure || !batchNumber || !warehouseId) {
          throw new Error("Each item needs materialId, quantity, unitOfMeasure, batchNumber and warehouseId");
        }

        // 1. Batch lot (unique per material + batch number)
        const batchLot = await tx.batchLot.upsert({
          where: { materialId_batchNumber: { materialId, batchNumber } },
          update: {},
          create: {
            materialId,
            batchNumber,
            expiryDate: expiryDate ? new Date(expiryDate) : null,
            manufacturingDate: manufacturingDate ? new Date(manufacturingDate) : null,
          },
        });

        // 2. GRN item
        await tx.goodsReceiptItem.create({
          data: {
            grnId: receipt.id,
            materialId,
            batchLotId: batchLot.id,
            quantity,
            unitOfMeasure,
          },
        });

        // 3. Ledger entry — stock IN
        await postLedgerEntry(tx, {
          eventType: LedgerEventType.PO_RECEIPT,
          materialId,
          batchLotId: batchLot.id,
          warehouseId,
          quantity: Number(quantity),
          unitOfMeasure,
          referenceType: "GRN",
          referenceId: receipt.id,
          createdById: req.user!.id,
          notes: `GRN ${number} against PO ${po.number}`,
        });

        // 4. QA inspection hook
        await tx.inspectionRecord.create({
          data: {
            inspectionType: "GRN",
            materialId,
            batchLotId: batchLot.id,
            referenceId: receipt.id,
            result: "PENDING",
          },
        });

        // 5. Update PO received quantities
        const poItem = po.items.find((p) => p.materialId === materialId);
        if (poItem) {
          await tx.purchaseOrderItem.update({
            where: { id: poItem.id },
            data: { receivedQty: { increment: Number(quantity) } },
          });
        }
      }

      // 6. Roll PO status to PARTIAL / RECEIVED
      const allReceived = po.items.every((p) => {
        const item = items.filter((i: any) => i.materialId === p.materialId);
        return item.reduce((s: number, i: any) => s + Number(i.quantity), 0) >= Number(p.quantity);
      });
      await tx.purchaseOrder.update({
        where: { id: poId },
        data: { status: allReceived ? "RECEIVED" : "PARTIAL" },
      });

      return receipt;
    });

    res.status(201).json({ grn });
  } catch (error: any) {
    console.error("POST /grn error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});

/**
 * POST /grn/consignment — receive goods against a consignment.
 * Alternative to PO-based GRN. Goods arrive via consignment (grouped shipment).
 * Workflow:
 *   1. Consignment arrives in IN_TRANSIT status
 *   2. Warehouse receives it -> marks RECEIVED
 *   3. Items distributed to warehouse bins -> marked DISTRIBUTED
 *   4. GRN created to formalize the receipt for QA & ledger
 * 
 * This endpoint receives items from a RECEIVED consignment and creates a GRN.
 */
router.post("/consignment", requirePermission("procurement", "create"), async (req: Request, res: Response) => {
  try {
    const { consignmentId, notes, items } = req.body;
    if (!consignmentId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "consignmentId and items are required" });
    }

    const consignment = await prisma.consignment.findUnique({
      where: { id: consignmentId },
      include: { items: true },
    });

    if (!consignment) {
      return res.status(404).json({ error: "Consignment not found" });
    }

    if (consignment.status !== "RECEIVED") {
      return res.status(400).json({ error: "Consignment must be in RECEIVED status to create GRN" });
    }

    // Generate GRN number (not linked to PO, but to consignment)
    const number = `GRN-CSN-${Date.now().toString().slice(-8)}`;

    const grn = await prisma.$transaction(async (tx) => {
      // Create GRN without PO reference for consignment-based receives
      // Note: poId can be null for consignment-based GRNs, or we keep it for audit trail
      const receipt = await tx.goodsReceipt.create({
        data: {
          number,
          poId: "consignment-based", // Mark as consignment-based (alternative: nullable field)
          receivedById: req.user!.id,
          status: "PENDING_QA",
          receivedAt: new Date(),
          notes: notes ? `${notes} (via Consignment: ${consignment.consignmentNumber})` : `Received via Consignment: ${consignment.consignmentNumber}`,
        },
      });

      // Process each item from consignment
      for (const it of items) {
        const { consignmentItemId, quantity, unitOfMeasure, batchNumber, warehouseId, expiryDate, manufacturingDate } = it;
        if (!consignmentItemId || !quantity || !unitOfMeasure || !batchNumber || !warehouseId) {
          throw new Error("Each item needs consignmentItemId, quantity, unitOfMeasure, batchNumber and warehouseId");
        }

        // Get the consignment item to find the material
        const consignmentItem = await tx.consignmentItem.findUnique({
          where: { id: consignmentItemId },
          include: { material: true },
        });

        if (!consignmentItem) {
          throw new Error(`Consignment item not found: ${consignmentItemId}`);
        }

        const materialId = consignmentItem.material.id;

        // 1. Create or get batch lot
        const batchLot = await tx.batchLot.upsert({
          where: { materialId_batchNumber: { materialId, batchNumber } },
          update: {},
          create: {
            materialId,
            batchNumber,
            expiryDate: expiryDate ? new Date(expiryDate) : null,
            manufacturingDate: manufacturingDate ? new Date(manufacturingDate) : null,
          },
        });

        // 2. Create GRN item
        await tx.goodsReceiptItem.create({
          data: {
            grnId: receipt.id,
            materialId,
            batchLotId: batchLot.id,
            quantity,
            unitOfMeasure,
          },
        });

        // 3. Post ledger entry — stock IN (via consignment)
        await postLedgerEntry(tx, {
          eventType: LedgerEventType.PO_RECEIPT,
          materialId,
          batchLotId: batchLot.id,
          warehouseId,
          quantity: Number(quantity),
          unitOfMeasure,
          referenceType: "GRN",
          referenceId: receipt.id,
          createdById: req.user!.id,
          notes: `GRN ${number} via Consignment ${consignment.consignmentNumber}`,
        });

        // 4. Create QA inspection record
        await tx.inspectionRecord.create({
          data: {
            inspectionType: "GRN",
            materialId,
            batchLotId: batchLot.id,
            referenceId: receipt.id,
            result: "PENDING",
          },
        });
      }

      return receipt;
    });

    res.status(201).json({ grn });
  } catch (error: any) {
    console.error("POST /grn/consignment error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});

export default router;
