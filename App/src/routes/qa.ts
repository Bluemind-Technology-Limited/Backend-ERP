import { Router, raw, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { prisma } from "../lib/db.js";
import { postLedgerEntry } from "../lib/ledger.js";
import { LedgerEventType, type Prisma } from "@prisma/client";
import {
  buildR2PublicUrl,
  deleteR2Object,
  isR2Configured,
  sanitizeFileName,
  uploadR2Object,
} from "../lib/r2.js";
import { logActivity } from "../services/userActivityLogger.js";

const router: Router = Router();
router.use(requireAuth);

/**
 * QA assigns the physical batch number during inspection. Receiving only
 * creates a provisional lot reference (the SOP lot code, or `PENDING-…`), which
 * this replaces. Two lots of the same material can never share a number.
 */
async function assignBatchNumber(
  tx: Prisma.TransactionClient,
  batchLotId: string,
  materialId: string,
  rawBatchNumber: unknown
) {
  const batchNumber = String(rawBatchNumber ?? "").trim();
  if (!batchNumber) return null;

  const clash = await tx.batchLot.findFirst({
    where: { materialId, batchNumber, NOT: { id: batchLotId } },
    select: { id: true },
  });
  if (clash) {
    throw new Error(`Batch number "${batchNumber}" is already used for this material`);
  }

  await tx.batchLot.update({ where: { id: batchLotId }, data: { batchNumber } });
  return batchNumber;
}

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
    const [grns, prodOrders, planItems] = await Promise.all([
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
    ]);
    const grnMap = new Map(grns.map((g) => [g.id, g.number]));
    const prodMap = new Map(prodOrders.map((p) => [p.id, p.orderNumber]));
    const planItemMap = new Map(
      planItems.map((p) => [
        p.id,
        `${p.productionPlan?.planNumber ?? "PLAN"} · ${p.bom?.productName ?? "batch"}`,
      ])
    );

    const rows = inspections.map((i) => ({
      ...i,
      referenceLabel:
        i.inspectionType === "GRN"
          ? grnMap.get(i.referenceId ?? "") ?? i.referenceId
          : prodMap.get(i.referenceId ?? "") ?? planItemMap.get(i.referenceId ?? "") ?? i.referenceId,
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
    const { notes, batchNumber } = req.body;
    const inspection = await prisma.inspectionRecord.findUnique({
      where: { id: req.params.id },
      include: { batchLot: true },
    });
    if (!inspection) return res.status(404).json({ error: "Inspection record not found" });
    if (inspection.result !== "PENDING") {
      return res.status(400).json({ error: "Only PENDING inspections can be released" });
    }

    // Receiving never assigns a batch number — QA must do it before release.
    if (
      inspection.batchLot &&
      !String(batchNumber ?? "").trim() &&
      inspection.batchLot.batchNumber.startsWith("PENDING-")
    ) {
      return res.status(400).json({ error: "Assign a batch number before releasing this batch" });
    }

    const result = await prisma.$transaction(async (tx) => {
      if (inspection.batchLot) {
        await assignBatchNumber(tx, inspection.batchLot.id, inspection.materialId, batchNumber);
      }

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

    res.json({ ok: true, inspection: result, message: `Batch ${(batchNumber ?? inspection.batchLot?.batchNumber) || ""} released to stock` });
  } catch (error: any) {
    if (error?.message?.includes("already used")) {
      return res.status(409).json({ error: error.message });
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
    const { notes, batchNumber } = req.body;
    const inspection = await prisma.inspectionRecord.findUnique({
      where: { id: req.params.id },
      include: { batchLot: true },
    });
    if (!inspection) return res.status(404).json({ error: "Inspection record not found" });
    if (inspection.result !== "PENDING") {
      return res.status(400).json({ error: "Only PENDING inspections can be rejected" });
    }

    const result = await prisma.$transaction(async (tx) => {
      if (inspection.batchLot) {
        await assignBatchNumber(tx, inspection.batchLot.id, inspection.materialId, batchNumber);
      }

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

    res.json({ ok: true, inspection: result, message: `Batch ${(batchNumber ?? inspection.batchLot?.batchNumber) || ""} rejected and quarantined stock reversed` });
  } catch (error: any) {
    if (error?.message?.includes("already used")) {
      return res.status(409).json({ error: error.message });
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
 * Records the inspector's comments/observations on one received item. Comments
 * stay editable while the item is pending; release/reject freezes them.
 */
router.patch(
  "/inspections/:id/comment",
  requirePermission("qa", "update"),
  async (req: Request, res: Response) => {
    try {
      const { notes } = req.body ?? {};
      if (notes !== undefined && notes !== null && typeof notes !== "string") {
        return res.status(400).json({ error: "notes must be text" });
      }

      const inspection = await prisma.inspectionRecord.findUnique({
        where: { id: req.params.id },
        select: { id: true, result: true },
      });
      if (!inspection) return res.status(404).json({ error: "Inspection record not found" });
      if (inspection.result !== "PENDING") {
        return res.status(409).json({ error: "Comments are locked once the item is released or rejected" });
      }

      const updated = await prisma.inspectionRecord.update({
        where: { id: inspection.id },
        data: { notes: typeof notes === "string" ? notes.trim() || null : null },
      });

      res.json({ inspection: updated });
    } catch (error: any) {
      console.error("PATCH /qa/inspections/:id/comment error:", error);
      res.status(500).json({ error: error?.message || "Database error" });
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
