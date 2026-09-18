import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { prisma } from "../lib/db.js";
import { postLedgerEntry } from "../lib/ledger.js";
import { buildLotCode, buildYearCode, isValidSetNumber, missingLotCodeParts, nextSetNumber } from "../lib/lotCode.js";
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
            batchLot: {
              select: {
                id: true,
                batchNumber: true,
                expiryDate: true,
                status: true,
                origin: true,
                lotCode: true,
                setNumber: true,
                vendorCode: true,
                ingredientCode: true,
                yearCode: true,
                supplierBatchNumber: true,
              },
            },
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
 * GET /grn/lot-preview — the lot code a receipt line will get (SOP KIB/QCA/010).
 *
 * The server owns the format so the UI never reimplements it, and the response
 * carries the resolved names so a code is always shown next to the ingredient
 * and supplier it belongs to.
 */
router.get("/lot-preview", requirePermission("procurement", "read"), async (req: Request, res: Response) => {
  try {
    const poId = req.query.poId ? String(req.query.poId) : null;
    const yearCode = buildYearCode();

    // PO mode — preview every line of a receipt in one call.
    if (poId) {
      const po = await prisma.purchaseOrder.findUnique({
        where: { id: poId },
        include: {
          supplier: { select: { id: true, name: true, vendorCode: true } },
          items: {
            include: {
              material: {
                select: {
                  id: true,
                  name: true,
                  sku: true,
                  unitOfMeasure: true,
                  traceabilityCode: true,
                },
              },
            },
          },
        },
      });
      if (!po) return res.status(404).json({ error: "Purchase order not found" });

      // Two lines for the same material must not be offered the same set number.
      const lastSuggested = new Map<string, number>();
      const items = [];

      for (const item of po.items) {
        const next = await nextSetNumber(prisma, {
          supplierId: po.supplierId ?? null,
          materialId: item.materialId,
          yearCode,
        });
        const setNumber = Math.max(next, (lastSuggested.get(item.materialId) ?? 0) + 1);
        lastSuggested.set(item.materialId, setNumber);

        const parts = {
          vendorCode: po.supplier?.vendorCode ?? null,
          ingredientCode: item.material.traceabilityCode ?? null,
          setNumber,
          yearCode,
        };

        items.push({
          materialId: item.materialId,
          materialName: item.material.name,
          materialSku: item.material.sku,
          unitOfMeasure: item.unitOfMeasure,
          setNumber,
          lotCode: buildLotCode(parts),
          missing: missingLotCodeParts(parts),
        });
      }

      return res.json({ supplier: po.supplier, yearCode, items });
    }

    // Single mode — one material + supplier.
    const materialId = req.query.materialId ? String(req.query.materialId) : null;
    const supplierId = req.query.supplierId ? String(req.query.supplierId) : null;

    const [material, supplier] = await Promise.all([
      materialId
        ? prisma.material.findUnique({
            where: { id: materialId },
            select: { id: true, name: true, sku: true, unitOfMeasure: true, traceabilityCode: true },
          })
        : Promise.resolve(null),
      supplierId
        ? prisma.supplier.findUnique({
            where: { id: supplierId },
            select: { id: true, name: true, vendorCode: true },
          })
        : Promise.resolve(null),
    ]);

    const setNumber = material
      ? await nextSetNumber(prisma, {
          supplierId: supplier?.id ?? null,
          materialId: material.id,
          yearCode,
        })
      : null;

    const parts = {
      vendorCode: supplier?.vendorCode ?? null,
      ingredientCode: material?.traceabilityCode ?? null,
      setNumber,
      yearCode,
    };

    res.json({
      material,
      supplier,
      yearCode,
      setNumber,
      lotCode: buildLotCode(parts),
      missing: missingLotCodeParts(parts),
    });
  } catch (error: any) {
    console.error("GET /grn/lot-preview error:", error);
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
      include: {
        items: true,
        supplier: { select: { id: true, name: true, vendorCode: true } },
      },
    });
    if (!po) return res.status(404).json({ error: "Purchase order not found" });
    if (po.status === "CLOSED") return res.status(400).json({ error: "PO is already closed" });

    const supplierId = po.supplierId ?? null;
    const yearCode = buildYearCode();

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
        const {
          materialId,
          quantity,
          unitOfMeasure,
          batchNumber,
          expiryDate,
          manufacturingDate,
          warehouseId,
          setNumber,
          supplierBatchNumber,
        } = it;
        if (!materialId || !quantity || !unitOfMeasure || !warehouseId) {
          throw new Error("Each item needs materialId, quantity, unitOfMeasure and warehouseId");
        }

        // 0. Lot code (SOP KIB/QCA/010). The set number is the incoming sequence
        // for this supplier + ingredient + year: auto-suggested, but the store
        // officer may override it.
        const material = await tx.material.findUnique({
          where: { id: materialId },
          select: { traceabilityCode: true },
        });

        let resolvedSetNumber: number | null =
          setNumber === undefined || setNumber === null || setNumber === "" ? null : Number(setNumber);
        if (resolvedSetNumber !== null && !isValidSetNumber(resolvedSetNumber)) {
          throw new Error("Material set number must be a positive whole number");
        }
        if (resolvedSetNumber === null) {
          resolvedSetNumber = await nextSetNumber(tx, { supplierId, materialId, yearCode });
        }

        const vendorCode = po.supplier?.vendorCode ?? null;
        const ingredientCode = material?.traceabilityCode ?? null;
        const lotCode = buildLotCode({ vendorCode, ingredientCode, setNumber: resolvedSetNumber, yearCode });

        // Until the vendor and ingredient codes are filled in on master data a
        // lot code can't be built, so a manually typed batch number still works.
        const resolvedBatchNumber = lotCode ?? String(batchNumber ?? "").trim();
        if (!resolvedBatchNumber) {
          throw new Error(
            "Set a vendor code on the supplier and a traceability code on the material, or enter a batch number"
          );
        }

        // 1. Batch lot (unique per material + batch number)
        const batchLot = await tx.batchLot.upsert({
          where: { materialId_batchNumber: { materialId, batchNumber: resolvedBatchNumber } },
          update: {},
          create: {
            materialId,
            batchNumber: resolvedBatchNumber,
            expiryDate: expiryDate ? new Date(expiryDate) : null,
            manufacturingDate: manufacturingDate ? new Date(manufacturingDate) : null,
            origin: "INBOUND",
            lotCode,
            setNumber: resolvedSetNumber,
            vendorCode,
            ingredientCode,
            yearCode,
            supplierBatchNumber: supplierBatchNumber ? String(supplierBatchNumber).trim() : null,
            supplierId,
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
    if (error?.code === "P2002") {
      return res.status(409).json({ error: "That lot code already exists — choose a different material set number" });
    }
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
      include: {
        items: true,
        supplier: { select: { id: true, name: true, vendorCode: true } },
      },
    });

    if (!consignment) {
      return res.status(404).json({ error: "Consignment not found" });
    }

    if (consignment.status !== "RECEIVED") {
      return res.status(400).json({ error: "Consignment must be in RECEIVED status to create GRN" });
    }

    // Generate GRN number (not linked to PO, but to consignment)
    const number = `GRN-CSN-${Date.now().toString().slice(-8)}`;
    const yearCode = buildYearCode();

    const grn = await prisma.$transaction(async (tx) => {
      // Create GRN without PO reference for consignment-based receives
      // Note: poId can be null for consignment-based GRNs, or we keep it for audit trail
      const receipt = await tx.goodsReceipt.create({
        data: {
          number,
          // Consignment-based receipts have no Purchase Order behind them.
          poId: null,
          consignmentId,
          receivedById: req.user!.id,
          status: "PENDING_QA",
          receivedAt: new Date(),
          notes: notes ? `${notes} (via Consignment: ${consignment.consignmentNumber})` : `Received via Consignment: ${consignment.consignmentNumber}`,
        },
      });

      // Process each item from consignment
      for (const it of items) {
        const {
          consignmentItemId,
          quantity,
          unitOfMeasure,
          batchNumber,
          warehouseId,
          expiryDate,
          manufacturingDate,
          setNumber,
          supplierBatchNumber,
        } = it;
        if (!consignmentItemId || !quantity || !unitOfMeasure || !warehouseId) {
          throw new Error("Each item needs consignmentItemId, quantity, unitOfMeasure and warehouseId");
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

        // Lot code (SOP KIB/QCA/010) — same rules as a PO-backed receipt.
        const vendorCode = consignment.supplier?.vendorCode ?? null;
        const ingredientCode = consignmentItem.material.traceabilityCode ?? null;

        let resolvedSetNumber: number | null =
          setNumber === undefined || setNumber === null || setNumber === "" ? null : Number(setNumber);
        if (resolvedSetNumber !== null && !isValidSetNumber(resolvedSetNumber)) {
          throw new Error("Material set number must be a positive whole number");
        }
        if (resolvedSetNumber === null) {
          resolvedSetNumber = await nextSetNumber(tx, {
            supplierId: consignment.supplierId ?? null,
            materialId,
            yearCode,
          });
        }

        const lotCode = buildLotCode({ vendorCode, ingredientCode, setNumber: resolvedSetNumber, yearCode });
        const resolvedBatchNumber = lotCode ?? String(batchNumber ?? "").trim();
        if (!resolvedBatchNumber) {
          throw new Error(
            "Set a vendor code on the supplier and a traceability code on the material, or enter a batch number"
          );
        }

        // 1. Create or get batch lot
        const batchLot = await tx.batchLot.upsert({
          where: { materialId_batchNumber: { materialId, batchNumber: resolvedBatchNumber } },
          update: {},
          create: {
            materialId,
            batchNumber: resolvedBatchNumber,
            expiryDate: expiryDate ? new Date(expiryDate) : null,
            manufacturingDate: manufacturingDate ? new Date(manufacturingDate) : null,
            origin: "INBOUND",
            lotCode,
            setNumber: resolvedSetNumber,
            vendorCode,
            ingredientCode,
            yearCode,
            supplierBatchNumber: supplierBatchNumber ? String(supplierBatchNumber).trim() : null,
            supplierId: consignment.supplierId ?? null,
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
          consignmentItemId: consignmentItem.id,
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

/**
 * DELETE /grn/:grnId
 * Delete a goods receipt (all statuses allowed)
 * Removes ledger entries and related records
 */
router.delete("/:grnId", requirePermission("procurement", "delete"), async (req: Request, res: Response) => {
  try {
    const { grnId } = req.params;

    const grn = await prisma.goodsReceipt.findUnique({
      where: { id: grnId },
      include: { items: true },
    });

    if (!grn) {
      return res.status(404).json({ error: "Goods receipt not found" });
    }

    // Delete in transaction to maintain data integrity
    await prisma.$transaction(async (tx) => {
      // 1. Delete ledger entries for this GRN
      await tx.inventoryTransaction.deleteMany({
        where: {
          referenceType: "GRN",
          referenceId: grnId,
        },
      });

      // 2. Get GRN items to calculate received quantity reversal
      const grnItems = await tx.goodsReceiptItem.findMany({
        where: { grnId },
      });

      // 3. Update PO items to reduce received quantity
      if (grn.poId) {
        for (const item of grnItems) {
          // Find the PO item by material and update receivedQty
          const poItem = await tx.purchaseOrderItem.findFirst({
            where: {
              poId: grn.poId,
              materialId: item.materialId,
            },
          });

          if (poItem) {
            await tx.purchaseOrderItem.update({
              where: { id: poItem.id },
              data: {
                receivedQty: {
                  decrement: Number(item.quantity),
                },
              },
            });
          }
        }
      }

      // 4. Delete GRN items
      await tx.goodsReceiptItem.deleteMany({
        where: { grnId },
      });

      // 5. Delete inspection records for this GRN
      await tx.inspectionRecord.deleteMany({
        where: {
          inspectionType: "GRN",
          referenceId: grnId,
        },
      });

      // 6. If PO exists, check if we need to update its status
      if (grn.poId) {
        const po = await tx.purchaseOrder.findUnique({
          where: { id: grn.poId },
          include: { items: true },
        });

        if (po) {
          // Calculate total received quantity for the PO
          const totalReceived = po.items.reduce((sum, item) => sum + Number(item.receivedQty || 0), 0);
          const totalQuantity = po.items.reduce((sum, item) => sum + Number(item.quantity), 0);

          // Update PO status based on receipt progress
          let newStatus = po.status;
          if (totalReceived === 0) {
            newStatus = "DRAFT"; // No items received, back to DRAFT
          } else if (totalReceived < totalQuantity) {
            newStatus = "PARTIAL"; // Some items received
          }

          if (newStatus !== po.status) {
            await tx.purchaseOrder.update({
              where: { id: grn.poId },
              data: { status: newStatus },
            });
          }
        }
      }

      // 7. Delete the GRN itself
      await tx.goodsReceipt.delete({
        where: { id: grnId },
      });
    });

    res.json({ success: true, message: "Goods receipt deleted successfully" });
  } catch (error: any) {
    console.error("DELETE /grn/:grnId error:", error);
    
    if (error.message.includes("not found")) {
      return res.status(404).json({ error: error.message });
    }
    
    res.status(500).json({ error: error?.message || "Failed to delete goods receipt" });
  }
});

export default router;
