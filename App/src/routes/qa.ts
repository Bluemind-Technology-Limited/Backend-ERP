import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { prisma } from "../lib/db.js";
import { postLedgerEntry } from "../lib/ledger.js";
import { LedgerEventType } from "@prisma/client";

const router: Router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// QA Inspections — incoming GRNs + finished production batches
// ---------------------------------------------------------------------------

router.get("/inspections", requirePermission("qa", "read"), async (req: Request, res: Response) => {
  try {
    const { result, type } = req.query;
    const where: any = {};
    if (result) where.result = result;
    if (type) where.inspectionType = type;

    const inspections = await prisma.inspectionRecord.findMany({
      where,
      include: {
        material: { select: { id: true, name: true, sku: true, unitOfMeasure: true } },
        batchLot: { select: { id: true, batchNumber: true, status: true, expiryDate: true } },
        inspector: { select: { fullName: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    // Resolve the reference (GRN or Production Order) for context
    const grnIds = inspections.filter((i) => i.inspectionType === "GRN").map((i) => i.referenceId).filter(Boolean) as string[];
    const prodIds = inspections.filter((i) => i.inspectionType === "FINISHED_BATCH").map((i) => i.referenceId).filter(Boolean) as string[];
    const [grns, prodOrders] = await Promise.all([
      grnIds.length
        ? prisma.goodsReceipt.findMany({ where: { id: { in: grnIds } }, select: { id: true, number: true } })
        : Promise.resolve([]),
      prodIds.length
        ? prisma.productionOrder.findMany({ where: { id: { in: prodIds } }, select: { id: true, orderNumber: true } })
        : Promise.resolve([]),
    ]);
    const grnMap = new Map(grns.map((g) => [g.id, g.number]));
    const prodMap = new Map(prodOrders.map((p) => [p.id, p.orderNumber]));

    const rows = inspections.map((i) => ({
      ...i,
      referenceLabel:
        i.inspectionType === "GRN"
          ? grnMap.get(i.referenceId ?? "") ?? i.referenceId
          : prodMap.get(i.referenceId ?? "") ?? i.referenceId,
    }));

    res.json({ inspections: rows });
  } catch (error) {
    console.error("GET /qa/inspections error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * POST /inspections/:id/release
 * PASS the inspection and release the batch lot from QUARANTINE -> ACTIVE.
 */
router.post("/inspections/:id/release", requirePermission("qa", "approve"), async (req: Request, res: Response) => {
  try {
    const { notes } = req.body;
    const inspection = await prisma.inspectionRecord.findUnique({
      where: { id: req.params.id },
      include: { batchLot: true },
    });
    if (!inspection) return res.status(404).json({ error: "Inspection record not found" });
    if (inspection.result !== "PENDING") {
      return res.status(400).json({ error: "Only PENDING inspections can be released" });
    }

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.inspectionRecord.update({
        where: { id: inspection.id },
        data: { result: "PASSED", notes: notes ?? inspection.notes, inspectedById: req.user!.id, inspectedAt: new Date() },
      });
      if (inspection.batchLot) {
        await tx.batchLot.update({
          where: { id: inspection.batchLot.id },
          data: { status: "ACTIVE" },
        });
      }

      // If this is a GRN inspection, check if all inspections for this GRN are now PASSED
      if (inspection.inspectionType === "GRN" && inspection.referenceId) {
        const pendingInspections = await tx.inspectionRecord.count({
          where: {
            referenceId: inspection.referenceId,
            inspectionType: "GRN",
            result: "PENDING",
          },
        });

        // If no more pending inspections, mark GRN as APPROVED
        if (pendingInspections === 0) {
          await tx.goodsReceipt.update({
            where: { id: inspection.referenceId },
            data: { status: "APPROVED" },
          });
        }
      }
      return updated;
    });

    res.json({ ok: true, inspection: result, message: `Batch ${inspection.batchLot?.batchNumber ?? ""} released to stock` });
  } catch (error: any) {
    console.error("POST /qa/inspections/:id/release error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});

/**
 * POST /inspections/:id/reject
 * FAIL the inspection, mark the batch REJECTED and reverse its stock via a WASTE ledger entry.
 */
router.post("/inspections/:id/reject", requirePermission("qa", "approve"), async (req: Request, res: Response) => {
  try {
    const { notes } = req.body;
    const inspection = await prisma.inspectionRecord.findUnique({
      where: { id: req.params.id },
      include: { batchLot: true },
    });
    if (!inspection) return res.status(404).json({ error: "Inspection record not found" });
    if (inspection.result !== "PENDING") {
      return res.status(400).json({ error: "Only PENDING inspections can be rejected" });
    }

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.inspectionRecord.update({
        where: { id: inspection.id },
        data: { result: "FAILED", notes: notes ?? inspection.notes, inspectedById: req.user!.id, inspectedAt: new Date() },
      });

      if (inspection.batchLot) {
        await tx.batchLot.update({
          where: { id: inspection.batchLot.id },
          data: { status: "REJECTED" },
        });

        // Reverse the stock this batch put in (PO_RECEIPT / PROD_OUTPUT) via a WASTE entry.
        const incoming = await tx.inventoryTransaction.findMany({
          where: { batchLotId: inspection.batchLot.id, quantity: { gt: 0 } },
          select: { quantity: true, unitOfMeasure: true, warehouseId: true },
        });
        const totalIn = incoming.reduce((sum, t) => sum + Number(t.quantity), 0);
        if (totalIn > 0) {
          await postLedgerEntry(tx, {
            eventType: LedgerEventType.WASTE,
            materialId: inspection.materialId,
            batchLotId: inspection.batchLot.id,
            warehouseId: incoming[0].warehouseId,
            quantity: -totalIn,
            unitOfMeasure: incoming[0].unitOfMeasure,
            referenceType: "QA_REJECT",
            referenceId: inspection.id,
            createdById: req.user!.id,
            notes: `Rejected batch ${inspection.batchLot.batchNumber} (${notes ?? "failed inspection"})`,
          });
        }
      }

      // If this is a GRN inspection and it's FAILED, mark the GRN as REJECTED
      if (inspection.inspectionType === "GRN" && inspection.referenceId) {
        await tx.goodsReceipt.update({
          where: { id: inspection.referenceId },
          data: { status: "REJECTED" },
        });
      }
      return updated;
    });

    res.json({ ok: true, inspection: result, message: `Batch ${inspection.batchLot?.batchNumber ?? ""} rejected and quarantined stock reversed` });
  } catch (error: any) {
    console.error("POST /qa/inspections/:id/reject error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});

export default router;
