import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { prisma } from "../lib/db.js";
import { postLedgerEntry } from "../lib/ledger.js";
import { LedgerEventType, GoodsReceiptStatus } from "../generated/prisma/client.js";

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
router.post("/grn", requirePermission("procurement", "create"), async (req: Request, res: Response) => {
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

export default router;
