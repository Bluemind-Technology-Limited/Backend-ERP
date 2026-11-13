import { Router, raw, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { prisma } from "../lib/db.js";
import { postLedgerEntry } from "../lib/ledger.js";
import { LedgerEventType } from "@prisma/client";
import {
  buildR2PublicUrl,
  deleteR2Object,
  isR2Configured,
  sanitizeFileName,
  uploadR2Object,
} from "../lib/r2.js";
import { logActivity } from "../services/userActivityLogger.js";
import { updateBatchLotSetNumber, type SetNumberEditResult } from "../lib/lotCode.js";
import { recomputePurchaseOrderStatus } from "../services/purchaseOrderStatus.js";
import {
  applyFinishedBatchApproval,
  applyFinishedBatchRejection,
} from "../services/productionBatchService.js";

const router: Router = Router();
router.use(requireAuth);

/** Audit a QA set-number edit. No-op when the number did not change. */
async function logSetNumberChange(
  userId: string,
  change: SetNumberEditResult | null,
  fallbackBatchNumber?: string | null
) {
  if (!change || change.oldSetNumber === change.setNumber) return;
  await logActivity({
    userId,
    activityType: "UPDATE",
    module: "qa",
    description: `Lot code set number changed to ${change.setNumber} for ${
      change.lotCode ?? change.oldLotCode ?? fallbackBatchNumber ?? "batch"
    }`,
    entityType: "BatchLot",
    entityId: change.batchLotId,
    details: {
      oldSetNumber: change.oldSetNumber,
      newSetNumber: change.setNumber,
      oldLotCode: change.oldLotCode,
      newLotCode: change.lotCode,
    },
  });
}

// ---------------------------------------------------------------------------
// QA Inspections — incoming GRNs + finished production batches
// ---------------------------------------------------------------------------

router.get("/inspections", requirePermission("qa", "read"), async (req: Request, res: Response) => {
  try {
    const { result } = req.query;
    // QA reviews received goods and finished production batches.
    const where: any = { inspectionType: { in: ["GRN", "FINISHED_BATCH"] } };
    if (result) where.result = result;

    const inspections = await prisma.inspectionRecord.findMany({
      where,
      include: {
        material: { select: { id: true, name: true, sku: true, unitOfMeasure: true } },
        batchLot: {
          select: {
            id: true,
            batchNumber: true,
            lotCode: true,
            setNumber: true,
            vendorCode: true,
            ingredientCode: true,
            yearCode: true,
            status: true,
            expiryDate: true,
          },
        },
        inspector: { select: { fullName: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    // Resolve the reference (GRN or Production Order) for context
    const grnIds = inspections.filter((i) => i.inspectionType === "GRN").map((i) => i.referenceId).filter(Boolean) as string[];
    const prodIds = inspections.filter((i) => i.inspectionType === "FINISHED_BATCH").map((i) => i.referenceId).filter(Boolean) as string[];
    const [grns, prodOrders, planItems, grnItems] = await Promise.all([
      grnIds.length
        ? prisma.goodsReceipt.findMany({ where: { id: { in: grnIds } }, select: { id: true, number: true } })
        : Promise.resolve([]),
      prodIds.length
        ? prisma.productionOrder.findMany({ where: { id: { in: prodIds } }, select: { id: true, orderNumber: true } })
        : Promise.resolve([]),
      // Finished batches also originate from production-plan line items.
      prodIds.length
        ? prisma.productionPlanItem.findMany({
            where: { id: { in: prodIds } },
            select: {
              id: true,
              bom: { select: { productName: true } },
              productionPlan: { select: { planNumber: true } },
            },
          })
        : Promise.resolve([]),
      grnIds.length
        ? prisma.goodsReceiptItem.findMany({
            where: { grnId: { in: grnIds } },
            select: {
              grnId: true,
              materialId: true,
              batchLotId: true,
              quantity: true,
              unitOfMeasure: true,
            },
          })
        : Promise.resolve([]),
    ]);
    const grnMap = new Map(grns.map((g) => [g.id, g.number]));
    const prodMap = new Map(prodOrders.map((p) => [p.id, p.orderNumber]));
    const planItemMap = new Map(
      planItems.map((p) => [
        p.id,
        `${p.productionPlan?.planNumber ?? "PLAN"} · ${p.bom?.productName ?? "batch"}`,
      ])
    );
    const grnItemMap = new Map(
      grnItems.map((item) => [
        `${item.grnId}:${item.materialId}:${item.batchLotId}`,
        item,
      ])
    );

    const rows = inspections.map((i) => {
      const grnItem =
        i.inspectionType === "GRN" && i.referenceId
          ? grnItemMap.get(`${i.referenceId}:${i.materialId}:${i.batchLotId}`)
          : null;
      return {
        ...i,
        receivedQuantity: grnItem?.quantity ?? null,
        receivedUnitOfMeasure: grnItem?.unitOfMeasure ?? null,
        referenceLabel:
          i.inspectionType === "GRN"
            ? grnMap.get(i.referenceId ?? "") ?? i.referenceId
            : prodMap.get(i.referenceId ?? "") ?? planItemMap.get(i.referenceId ?? "") ?? i.referenceId,
      };
    });

    res.json({ inspections: rows });
  } catch (error) {
    console.error("GET /qa/inspections error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * QA-only received-quantity edit.
 * Updates the GRN line, posts the stock delta and keeps the PO balance/status in
 * step. Only PENDING GRN inspections reach this path.
 */
async function applyQaQuantityEdit(
  tx: any,
  inspection: { id: string; inspectionType: string; referenceId: string | null; materialId: string; batchLotId: string | null },
  rawQuantity: unknown,
  userId: string
) {
  if (inspection.inspectionType !== "GRN") return;
  if (rawQuantity === undefined || rawQuantity === null || String(rawQuantity).trim() === "") return;

  const quantity = Number(rawQuantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error("Received quantity must be greater than zero");
  }
  if (!inspection.referenceId) return;

  const item = await tx.goodsReceiptItem.findFirst({
    where: {
      grnId: inspection.referenceId,
      materialId: inspection.materialId,
      ...(inspection.batchLotId ? { batchLotId: inspection.batchLotId } : {}),
    },
    select: { id: true, quantity: true, unitOfMeasure: true, batchLotId: true, materialId: true },
  });
  if (!item) throw new Error("GRN line not found for this inspection");

  const delta = Number((quantity - Number(item.quantity)).toFixed(4));
  if (Math.abs(delta) < 0.0001) return;

  const movement = await tx.inventoryTransaction.findFirst({
    where: {
      referenceType: "GRN",
      referenceId: inspection.referenceId,
      batchLotId: item.batchLotId,
    },
    select: { warehouseId: true },
  });
  if (!movement?.warehouseId) {
    throw new Error("Cannot adjust quantity: original receipt movement not found");
  }

  await tx.goodsReceiptItem.update({
    where: { id: item.id },
    data: { quantity },
  });

  await postLedgerEntry(tx, {
    eventType: LedgerEventType.ADJUSTMENT,
    materialId: item.materialId,
    batchLotId: item.batchLotId,
    warehouseId: movement.warehouseId,
    quantity: delta,
    unitOfMeasure: item.unitOfMeasure,
    referenceType: "QA_QUANTITY_EDIT",
    referenceId: inspection.id,
    createdById: userId,
    notes: `QA adjusted received quantity ${item.quantity} → ${quantity}`,
  });

  const receipt = await tx.goodsReceipt.findUnique({
    where: { id: inspection.referenceId },
    select: { poId: true },
  });
  if (receipt?.poId) {
    const poItem = await tx.purchaseOrderItem.findFirst({
      where: { poId: receipt.poId, materialId: item.materialId },
      select: { id: true, receivedQty: true },
    });
    if (poItem) {
      await tx.purchaseOrderItem.update({
        where: { id: poItem.id },
        data: {
          receivedQty: Math.max(0, Number(poItem.receivedQty) + delta),
        },
      });
    }
    await recomputePurchaseOrderStatus(tx, receipt.poId);
  }
}
router.post("/inspections/:id/release", requirePermission("qa", "approve"), async (req: Request, res: Response) => {
  try {
    const { notes, setNumber, quantity } = req.body;
    const inspection = await prisma.inspectionRecord.findUnique({
      where: { id: req.params.id },
      include: { batchLot: true },
    });
    if (!inspection) return res.status(404).json({ error: "Inspection record not found" });
    if (inspection.result !== "PENDING") {
      return res.status(400).json({ error: "Only PENDING inspections can be released" });
    }

    const { updated, codeChange } = await prisma.$transaction(async (tx) => {
      const isFinishedBatch = inspection.inspectionType === "FINISHED_BATCH";
      const codeChange =
        inspection.batchLot
          ? await updateBatchLotSetNumber(tx, inspection.batchLot.id, setNumber)
          : null;

      await applyQaQuantityEdit(tx, inspection, quantity, req.user!.id);

      let updated;
      if (isFinishedBatch && inspection.batchLot) {
        await applyFinishedBatchApproval(tx, {
          inspectionId: inspection.id,
          batchLotId: inspection.batchLot.id,
          userId: req.user!.id,
          notes: notes ?? null,
          lotCode: codeChange?.lotCode ?? inspection.batchLot.lotCode,
        });
        updated = await tx.inspectionRecord.findUnique({ where: { id: inspection.id } });
      } else {
        updated = await tx.inspectionRecord.update({
          where: { id: inspection.id },
          data: { result: "PASSED", notes: notes ?? inspection.notes, inspectedById: req.user!.id, inspectedAt: new Date() },
        });
        if (inspection.batchLot) {
          await tx.batchLot.update({
            where: { id: inspection.batchLot.id },
            data: { status: "ACTIVE" },
          });
        }
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
      return { updated, codeChange };
    });

    await logSetNumberChange(req.user!.id, codeChange, inspection.batchLot?.batchNumber);

    res.json({
      ok: true,
      inspection: updated,
      lotCode: codeChange?.lotCode ?? inspection.batchLot?.lotCode ?? null,
      setNumber: codeChange?.setNumber ?? inspection.batchLot?.setNumber ?? null,
      message: `Lot ${codeChange?.lotCode ?? inspection.batchLot?.lotCode ?? inspection.batchLot?.batchNumber ?? ""} released to stock`,
    });
  } catch (error: any) {
    if (error?.message?.includes("already used")) {
      return res.status(409).json({ error: error.message });
    }
    if (error?.code === "P2002") {
      return res.status(409).json({ error: "That set number is already in use — choose another one." });
    }
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
    const { notes, setNumber } = req.body;
    const inspection = await prisma.inspectionRecord.findUnique({
      where: { id: req.params.id },
      include: { batchLot: true },
    });
    if (!inspection) return res.status(404).json({ error: "Inspection record not found" });
    if (inspection.result !== "PENDING") {
      return res.status(400).json({ error: "Only PENDING inspections can be rejected" });
    }

    const { updated, codeChange } = await prisma.$transaction(async (tx) => {
      const isFinishedBatch = inspection.inspectionType === "FINISHED_BATCH";
      const codeChange =
        inspection.batchLot
          ? await updateBatchLotSetNumber(tx, inspection.batchLot.id, setNumber)
          : null;

      let updated;
      if (isFinishedBatch && inspection.batchLot) {
        await applyFinishedBatchRejection(tx, {
          inspectionId: inspection.id,
          batchLotId: inspection.batchLot.id,
          userId: req.user!.id,
          notes: notes ?? inspection.notes,
        });
        updated = await tx.inspectionRecord.findUnique({ where: { id: inspection.id } });
      } else {
        updated = await tx.inspectionRecord.update({
          where: { id: inspection.id },
          data: { result: "FAILED", notes: notes ?? inspection.notes, inspectedById: req.user!.id, inspectedAt: new Date() },
        });
        if (inspection.batchLot) {
          await tx.batchLot.update({
            where: { id: inspection.batchLot.id },
            data: { status: "REJECTED" },
          });
        }
      }

      if (inspection.batchLot) {
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
            notes: `Rejected lot ${codeChange?.lotCode ?? inspection.batchLot.lotCode ?? inspection.batchLot.batchNumber} (${notes ?? "failed inspection"})`,
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
      return { updated, codeChange };
    });

    await logSetNumberChange(req.user!.id, codeChange, inspection.batchLot?.batchNumber);

    res.json({
      ok: true,
      inspection: updated,
      lotCode: codeChange?.lotCode ?? inspection.batchLot?.lotCode ?? null,
      setNumber: codeChange?.setNumber ?? inspection.batchLot?.setNumber ?? null,
      message: `Lot ${codeChange?.lotCode ?? inspection.batchLot?.lotCode ?? inspection.batchLot?.batchNumber ?? ""} rejected and quarantined stock reversed`,
    });
  } catch (error: any) {
    if (error?.message?.includes("already used")) {
      return res.status(409).json({ error: error.message });
    }
    if (error?.code === "P2002") {
      return res.status(409).json({ error: "That set number is already in use — choose another one." });
    }
    console.error("POST /qa/inspections/:id/reject error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});

// ---------------------------------------------------------------------------
// QA comment
// ---------------------------------------------------------------------------

/**
 * PATCH /inspections/:id/comment
 * Saves the inspector's observations and (optionally) an edited set number while
 * the item is pending. Editing the set number rebuilds the lot code. Release /
 * reject freeze both.
 */
router.patch(
  "/inspections/:id/comment",
  requirePermission("qa", "update"),
  async (req: Request, res: Response) => {
    try {
      const { notes, setNumber, quantity } = req.body ?? {};
      if (notes !== undefined && notes !== null && typeof notes !== "string") {
        return res.status(400).json({ error: "notes must be text" });
      }

      const inspection = await prisma.inspectionRecord.findUnique({
        where: { id: req.params.id },
        select: { id: true, result: true, batchLotId: true, inspectionType: true, referenceId: true, materialId: true },
      });
      if (!inspection) return res.status(404).json({ error: "Inspection record not found" });
      if (inspection.result !== "PENDING") {
        return res.status(409).json({ error: "Comments are locked once the item is released or rejected" });
      }

      const { updated, codeChange } = await prisma.$transaction(async (tx) => {
        const codeChange =
          inspection.batchLotId
            ? await updateBatchLotSetNumber(tx, inspection.batchLotId, setNumber)
            : null;

        await applyQaQuantityEdit(
          tx,
          {
            id: inspection.id,
            inspectionType: inspection.inspectionType,
            referenceId: inspection.referenceId,
            materialId: inspection.materialId,
            batchLotId: inspection.batchLotId,
          },
          quantity,
          req.user!.id
        );

        if (codeChange?.lotCode && inspection.batchLotId) {
          await tx.productionStageRecord.updateMany({
            where: { batchLotId: inspection.batchLotId },
            data: { batchNumber: codeChange.lotCode },
          });
        }

        const updated = await tx.inspectionRecord.update({
          where: { id: inspection.id },
          data: {
            ...(notes !== undefined
              ? { notes: typeof notes === "string" ? notes.trim() || null : null }
              : {}),
          },
        });

        return { updated, codeChange };
      });

      await logSetNumberChange(req.user!.id, codeChange);

      res.json({
        inspection: updated,
        lotCode: codeChange?.lotCode ?? null,
        setNumber: codeChange?.setNumber ?? null,
      });
    } catch (error: any) {
      const message = error?.message || "Database error";
      if (error?.code === "P2002") {
        return res.status(409).json({ error: "That set number is already in use — choose another one." });
      }
      if (/not found/i.test(message)) return res.status(404).json({ error: message });
      if (/already used/i.test(message)) return res.status(409).json({ error: message });
      if (/must be/i.test(message)) return res.status(400).json({ error: message });
      console.error("PATCH /qa/inspections/:id/comment error:", error);
      res.status(500).json({ error: message });
    }
  }
);

// ---------------------------------------------------------------------------
// QA review document (Cloudflare R2)
//
// The browser uploads directly to R2 and posts back only the resulting URL.
// If the browser is blocked (bucket CORS), it falls back to the upload route
// below, which streams the file from the API to R2 instead.
// ---------------------------------------------------------------------------

/**
 * POST /inspections/:id/review-document/upload?fileName=...
 * Fallback upload: raw file body, MIME type in `x-file-type`.
 */
router.post(
  "/inspections/:id/review-document/upload",
  requirePermission("qa", "update"),
  raw({ type: "application/octet-stream", limit: "25mb" }),
  async (req: Request, res: Response) => {
    try {
      if (!isR2Configured()) {
        return res.status(503).json({ error: "Review document storage is not configured" });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: "file body is required" });
      }

      const inspection = await prisma.inspectionRecord.findUnique({
        where: { id: req.params.id },
        select: { id: true },
      });
      if (!inspection) return res.status(404).json({ error: "Inspection record not found" });

      const fileName =
        typeof req.query.fileName === "string" && req.query.fileName.trim()
          ? req.query.fileName.trim()
          : "document";
      const contentType =
        typeof req.headers["x-file-type"] === "string" && req.headers["x-file-type"].trim()
          ? req.headers["x-file-type"].trim()
          : "application/octet-stream";

      const stamp = Date.now();
      const rand = Math.random().toString(36).slice(2, 10);
      const key = `inspections/${inspection.id}/review-docs/${stamp}-${rand}-${sanitizeFileName(fileName)}`;

      const url = await uploadR2Object(key, req.body, contentType);
      res.status(201).json({ url, key });
    } catch (error: any) {
      console.error("POST /qa/inspections/:id/review-document/upload error:", error);
      res.status(500).json({ error: error?.message || "Failed to upload review document" });
    }
  }
);

/**
 * POST /inspections/:id/review-document
 * Body: { url, fileName, mimeType?, fileSize? }
 * Persists the URL returned by the direct browser -> R2 upload. The key is
 * derived from the URL so the object can still be replaced/deleted.
 */
router.post(
  "/inspections/:id/review-document",
  requirePermission("qa", "update"),
  async (req: Request, res: Response) => {
    try {
      const { url, fileName, mimeType, fileSize } = req.body ?? {};
      if (typeof url !== "string" || !url.trim()) {
        return res.status(400).json({ error: "url is required" });
      }
      if (typeof fileName !== "string" || !fileName.trim()) {
        return res.status(400).json({ error: "fileName is required" });
      }
      if (!isR2Configured()) {
        return res.status(503).json({ error: "Review document storage is not configured" });
      }

      const expectedPrefix = buildR2PublicUrl(
        `inspections/${req.params.id}/review-docs/`
      );
      const cleanUrl = url.trim();
      if (!cleanUrl.startsWith(expectedPrefix)) {
        return res.status(400).json({ error: "url does not belong to this inspection" });
      }

      const key = cleanUrl.slice(expectedPrefix.length);

      const inspection = await prisma.inspectionRecord.findUnique({
        where: { id: req.params.id },
        select: { id: true, reviewDocumentKey: true },
      });
      if (!inspection) return res.status(404).json({ error: "Inspection record not found" });

      const updated = await prisma.inspectionRecord.update({
        where: { id: inspection.id },
        data: {
          reviewDocumentUrl: cleanUrl,
          reviewDocumentKey: key,
          reviewDocumentName: fileName.trim(),
          reviewDocumentMime:
            typeof mimeType === "string" && mimeType.trim()
              ? mimeType.trim()
              : "application/octet-stream",
          reviewDocumentSize:
            Number.isFinite(Number(fileSize)) && Number(fileSize) > 0
              ? Math.round(Number(fileSize))
              : null,
          reviewDocumentUploadedAt: new Date(),
          reviewDocumentUploadedById: req.user!.id,
        },
      });

      // Replacing a document: remove the previous object (best effort).
      if (inspection.reviewDocumentKey && inspection.reviewDocumentKey !== key) {
        deleteR2Object(inspection.reviewDocumentKey).catch((err) =>
          console.error("Failed to remove previous review document:", err)
        );
      }

      await logActivity({
        userId: req.user!.id,
        activityType: "UPDATE",
        module: "qa",
        description: `Attached review document ${fileName.trim()} to inspection ${inspection.id}`,
        entityType: "InspectionRecord",
        entityId: inspection.id,
        details: { fileName: fileName.trim(), url: cleanUrl },
      });

      res.status(201).json({ inspection: updated });
    } catch (error: any) {
      console.error("POST /qa/inspections/:id/review-document error:", error);
      res.status(500).json({ error: error?.message || "Failed to save review document" });
    }
  }
);

/**
 * DELETE /inspections/:id/review-document
 * Removes the object from R2 and clears the stored document fields.
 */
router.delete(
  "/inspections/:id/review-document",
  requirePermission("qa", "update"),
  async (req: Request, res: Response) => {
    try {
      const inspection = await prisma.inspectionRecord.findUnique({
        where: { id: req.params.id },
        select: { id: true, reviewDocumentKey: true },
      });
      if (!inspection) return res.status(404).json({ error: "Inspection record not found" });

      if (inspection.reviewDocumentKey) {
        try {
          await deleteR2Object(inspection.reviewDocumentKey);
        } catch (error) {
          // Still clear the row so the UI isn't stuck showing a broken link.
          console.error("Failed to remove review document object:", error);
        }
      }

      await prisma.inspectionRecord.update({
        where: { id: inspection.id },
        data: {
          reviewDocumentUrl: null,
          reviewDocumentKey: null,
          reviewDocumentName: null,
          reviewDocumentMime: null,
          reviewDocumentSize: null,
          reviewDocumentUploadedAt: null,
          reviewDocumentUploadedById: null,
        },
      });

      await logActivity({
        userId: req.user!.id,
        activityType: "DELETE",
        module: "qa",
        description: `Removed review document from inspection ${inspection.id}`,
        entityType: "InspectionRecord",
        entityId: inspection.id,
      });

      res.json({ ok: true });
    } catch (error: any) {
      console.error("DELETE /qa/inspections/:id/review-document error:", error);
      res.status(500).json({ error: error?.message || "Failed to remove review document" });
    }
  }
);

export default router;
