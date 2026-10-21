import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { prisma } from "../lib/db.js";
import { postLedgerEntry } from "../lib/ledger.js";
import { buildLotCode, buildYearCode, isValidSetNumber, missingLotCodeParts, nextSetNumber } from "../lib/lotCode.js";
import { LedgerEventType, GoodsReceiptStatus } from "@prisma/client";
import * as consignmentService from "../services/consignment.js";
import { logActivity } from "../services/userActivityLogger.js";
import { recomputePurchaseOrderStatus } from "../services/purchaseOrderStatus.js";

const router: Router = Router();
router.use(requireAuth);

type SupplierOption = { id: string; name: string; vendorCode: string | null };

/**
 * A material can be sourced from several suppliers. Direct receipts never ask
 * the store officer to pick one, so it follows from the material: prefer a
 * supplier that has a vendor code (lot codes need it), then alphabetical order
 * so the same material always resolves to the same supplier.
 */
const pickMaterialSupplier = (links: Array<{ supplier: SupplierOption }>): SupplierOption | null => {
  const suppliers = links
    .map((link) => link.supplier)
    .sort((a, b) => a.name.localeCompare(b.name));
  return suppliers.find((s) => s.vendorCode) ?? suppliers[0] ?? null;
};

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
        consignment: { select: { id: true, consignmentNumber: true } },
        supplier: { select: { id: true, name: true } },
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

    const materialRow = materialId
      ? await prisma.material.findUnique({
          where: { id: materialId },
          select: {
            id: true,
            name: true,
            sku: true,
            unitOfMeasure: true,
            traceabilityCode: true,
            suppliers: { include: { supplier: { select: { id: true, name: true, vendorCode: true } } } },
          },
        })
      : null;

    const explicitSupplier = supplierId
      ? await prisma.supplier.findUnique({
          where: { id: supplierId },
          select: { id: true, name: true, vendorCode: true },
        })
      : null;

    // The supplier follows from the material when the officer doesn't choose one.
    const supplier = explicitSupplier ?? pickMaterialSupplier(materialRow?.suppliers ?? []);
    const material = materialRow
      ? {
          id: materialRow.id,
          name: materialRow.name,
          sku: materialRow.sku,
          unitOfMeasure: materialRow.unitOfMeasure,
          traceabilityCode: materialRow.traceabilityCode,
        }
      : null;

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
    const { poId, notes, items, source: requestedSource, supplierId: requestedSupplierId, receivedAt } = req.body;
    const isDirect = !poId && requestedSource === "DIRECT";
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items are required" });
    }
    if (!poId && !isDirect) {
      return res.status(400).json({ error: "poId is required, or set source to DIRECT for a contingency receipt" });
    }
    if (isDirect && (!notes || !String(notes).trim())) {
      return res.status(400).json({ error: "A reason/notes is required for a direct goods receipt" });
    }

    // A receipt against a PO *is* a consignment: the lines that arrived form the
    // shipment, the outstanding balance stays on the PO for the next delivery.
    if (poId) {
      const po = await prisma.purchaseOrder.findUnique({
        where: { id: String(poId) },
        include: { items: true },
      });
      if (!po) return res.status(404).json({ error: "Purchase order not found" });

      const warehouseId = items.find((it: any) => it?.warehouseId)?.warehouseId;
      if (!warehouseId) {
        return res.status(400).json({ error: "Each item needs a warehouse" });
      }

      const consignment = await consignmentService.createConsignment({
        supplierId: po.supplierId,
        warehouseId: String(warehouseId),
        createdById: req.user!.id,
        poId: po.id,
        notes,
        receivedAt: receivedAt ? new Date(receivedAt) : undefined,
        items: items.map((it: any) => ({
          poItemId:
            it.poItemId ?? po.items.find((p) => p.materialId === it.materialId)?.id ?? null,
          materialId: it.materialId,
          quantity: Number(it.quantity),
          unitOfMeasure: it.unitOfMeasure,
          expiryDate: it.expiryDate ?? null,
          setNumber: it.setNumber ?? null,
          warehouseId: it.warehouseId ?? null,
          unitCost: it.unitCost ?? null,
        })),
      });

      const grn =
        consignment.goodsReceipts[0] ??
        (await prisma.goodsReceipt.findFirst({
          where: { consignmentId: consignment.id },
          orderBy: { receivedAt: "desc" },
        }));

      return res.status(201).json({ grn, consignment });
    }

    const po = poId
      ? await prisma.purchaseOrder.findUnique({
          where: { id: poId },
          include: {
            items: true,
            supplier: { select: { id: true, name: true, vendorCode: true } },
          },
        })
      : null;
    if (poId && !po) return res.status(404).json({ error: "Purchase order not found" });
    if (po?.status === "CLOSED") return res.status(400).json({ error: "PO is already closed" });

    // Never receive more than the PO still has outstanding — the remainder is
    // what a later receipt is allowed to claim.
    if (po) {
      const requestedByMaterial = new Map<string, number>();
      for (const it of items) {
        if (!it?.materialId) continue;
        requestedByMaterial.set(
          it.materialId,
          (requestedByMaterial.get(it.materialId) ?? 0) + Number(it.quantity ?? 0)
        );
      }
      for (const [materialId, requested] of requestedByMaterial) {
        const lines = po.items.filter((p) => p.materialId === materialId);
        if (lines.length === 0) continue;
        const remaining = lines.reduce(
          (sum, line) => sum + (Number(line.quantity) - Number(line.receivedQty)),
          0
        );
        if (requested > remaining) {
          return res.status(400).json({
            error: `Only ${remaining} remaining on ${po.number} for this material (requested ${requested}). The outstanding balance stays on the PO — receive it later.`,
            materialId,
            remaining,
          });
        }
      }
    }

    let supplierId: string | null = po?.supplierId ?? null;
    let supplier = po?.supplier ?? null;
    if (!po && requestedSupplierId) {
      const directSupplier = await prisma.supplier.findUnique({
        where: { id: String(requestedSupplierId) },
        select: { id: true, name: true, vendorCode: true },
      });
      if (!directSupplier) return res.status(404).json({ error: "Supplier not found" });
      supplierId = directSupplier.id;
      supplier = directSupplier;
    }

    const yearCode = buildYearCode();

    const number = isDirect
      ? `GRN-D-${Date.now().toString().slice(-8)}`
      : `GRN-${Date.now().toString().slice(-8)}`;

    // The date the goods physically arrived (backdatable), one stamp per receipt.
    const receivedDate = receivedAt ? new Date(receivedAt) : new Date();
    if (Number.isNaN(receivedDate.getTime())) {
      return res.status(400).json({ error: "receivedAt is not a valid date" });
    }

    const grn = await prisma.$transaction(async (tx) => {
      const receipt = await tx.goodsReceipt.create({
        data: {
          number,
          poId: po?.id ?? null,
          consignmentId: null,
          supplierId,
          source: isDirect ? "DIRECT" : "PURCHASE_ORDER",
          receivedById: req.user!.id,
          status: "PENDING_QA",
          receivedAt: receivedDate,
          notes,
        },
      });

      // Direct receipts may mix materials from different suppliers; the header
      // supplier is only filled in when every line resolves to the same one.
      const lineSupplierIds = new Set<string>();
      let lineIndex = 0;

      for (const it of items) {
        lineIndex += 1;
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
          unitCost,
        } = it;
        if (!materialId || !quantity || !unitOfMeasure || !warehouseId) {
          throw new Error("Each item needs materialId, quantity, unitOfMeasure and warehouseId");
        }

        // 0. Lot code (SOP KIB/QCA/010). The set number is the incoming sequence
        // for this supplier + ingredient + year: auto-suggested, but the store
        // officer may override it.
        const material = await tx.material.findUnique({
          where: { id: materialId },
          select: {
            traceabilityCode: true,
            type: true,
            suppliers: { include: { supplier: { select: { id: true, name: true, vendorCode: true } } } },
          },
        });
        if (!material) {
          throw new Error(`Material not found: ${materialId}`);
        }
        if (material.type === "FINISHED") {
          throw new Error("Finished goods cannot be received through a GRN");
        }

        // Supplier for this line. PO-backed receipts use the PO supplier; direct
        // receipts take it from the material (no supplier step in the UI).
        let lineSupplier = supplier;
        let lineSupplierId = supplierId;
        if (isDirect) {
          const requestedItemSupplierId = it.supplierId ? String(it.supplierId) : null;
          if (requestedItemSupplierId) {
            lineSupplier = await tx.supplier.findUnique({
              where: { id: requestedItemSupplierId },
              select: { id: true, name: true, vendorCode: true },
            });
            if (!lineSupplier) throw new Error(`Supplier not found: ${requestedItemSupplierId}`);
            lineSupplierId = lineSupplier.id;
          } else if (!lineSupplier) {
            lineSupplier = pickMaterialSupplier(material.suppliers);
            lineSupplierId = lineSupplier?.id ?? null;
          }
        }
        if (lineSupplierId) lineSupplierIds.add(lineSupplierId);

        let resolvedSetNumber: number | null =
          setNumber === undefined || setNumber === null || setNumber === "" ? null : Number(setNumber);
        if (resolvedSetNumber !== null && !isValidSetNumber(resolvedSetNumber)) {
          throw new Error("Material set number must be a positive whole number");
        }
        if (resolvedSetNumber === null) {
          resolvedSetNumber = await nextSetNumber(tx, { supplierId: lineSupplierId, materialId, yearCode });
        }

        const vendorCode = lineSupplier?.vendorCode ?? null;
        const ingredientCode = material?.traceabilityCode ?? null;
        const lotCode = buildLotCode({ vendorCode, ingredientCode, setNumber: resolvedSetNumber, yearCode });

        // The batch number is assigned by QA on inspection. Until then the lot
        // carries the SOP lot code, or a provisional receipt-scoped reference.
        const resolvedBatchNumber =
          lotCode ?? (String(batchNumber ?? "").trim() || `PENDING-${number}-${lineIndex}`);

        // 1. Batch lot (unique per material + batch number)
        const batchLot = await tx.batchLot.upsert({
          where: { materialId_batchNumber: { materialId, batchNumber: resolvedBatchNumber } },
          update: {},
          create: {
            materialId,
            batchNumber: resolvedBatchNumber,
            status: "QUARANTINE",
            expiryDate: expiryDate ? new Date(expiryDate) : null,
            manufacturingDate: manufacturingDate ? new Date(manufacturingDate) : null,
            origin: "INBOUND",
            lotCode,
            setNumber: resolvedSetNumber,
            vendorCode,
            ingredientCode,
            yearCode,
            supplierBatchNumber: supplierBatchNumber ? String(supplierBatchNumber).trim() : null,
            supplierId: lineSupplierId,
          },
        });

        // 2. GRN item
        const poItem = po?.items.find((p) => p.materialId === materialId);
        const resolvedUnitCost = Number(unitCost ?? poItem?.unitCost ?? 0);
        await tx.goodsReceiptItem.create({
          data: {
            grnId: receipt.id,
            materialId,
            batchLotId: batchLot.id,
            quantity,
            unitOfMeasure,
            unitCost: resolvedUnitCost,
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
          notes: isDirect
            ? `GRN ${number} (direct receipt${lineSupplier ? ` from ${lineSupplier.name}` : ""})`
            : `GRN ${number} against PO ${po?.number ?? ""}`,
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
        if (poItem) {
          await tx.purchaseOrderItem.update({
            where: { id: poItem.id },
            data: { receivedQty: { increment: Number(quantity) } },
          });
        }
      }

      // Direct receipts with a single supplier behind every line get it on the
      // receipt header too, so the GRN list can show where the goods came from.
      if (isDirect && !receipt.supplierId && lineSupplierIds.size === 1) {
        const [onlySupplierId] = [...lineSupplierIds];
        await tx.goodsReceipt.update({
          where: { id: receipt.id },
          data: { supplierId: onlySupplierId },
        });
      }

      // 6. Roll PO state from its line balances (fully / partially received).
      if (po) {
        await recomputePurchaseOrderStatus(tx, po.id);
      }

      return receipt;
    });

    if (isDirect) {
      const saved = await prisma.goodsReceipt.findUnique({
        where: { id: grn.id },
        select: { supplier: { select: { id: true, name: true } } },
      });
      const supplierName = saved?.supplier?.name;
      await logActivity({
        userId: req.user!.id,
        activityType: "CREATE",
        module: "procurement",
        description: `Direct goods receipt ${number}${supplierName ? ` from ${supplierName}` : ""}`,
        entityType: "GoodsReceipt",
        entityId: grn.id,
        details: { supplierId: saved?.supplier?.id ?? null, notes, itemCount: items.length },
      }).catch((logError) => console.error("Failed to log direct GRN:", logError));
    }

    res.status(201).json({ grn });
  } catch (error: any) {
    if (error?.code === "P2002") {
      return res.status(409).json({ error: "That lot code already exists — choose a different material set number" });
    }
    // Validation failures from the consignment service are user-facing.
    if (error instanceof Error && !("code" in error)) {
      console.error("POST /grn rejected:", error.message);
      return res.status(400).json({ error: error.message });
    }
    console.error("POST /grn error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});

/**
 * POST /grn/consignment — receive goods against a consignment.
 * Alternative to PO-based GRN. Goods arrive via consignment (a batch of PO lines).
 * Workflow:
 *   1. Consignment is created from selected PO lines
 *   2. Warehouse receives what physically arrived -> GRN posted against the consignment
 *   3. Unreceived quantities stay outstanding on the consignment and the PO
 *   4. A later GRN can claim the remainder; the PO completes once nothing is left
 *
 * Partial receipts are the norm — only the quantities actually delivered are
 * recorded, and both the consignment line and its PO line advance by that much.
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
        po: { select: { id: true, number: true, status: true } },
        items: { include: { material: true, poItem: { select: { id: true, unitCost: true } } } },
        supplier: { select: { id: true, name: true, vendorCode: true } },
      },
    });

    if (!consignment) {
      return res.status(404).json({ error: "Consignment not found" });
    }

    // Once a consignment is in QA or has been distributed, its receipt is closed.
    const closedStatuses = ["QUALITY_PENDING", "QUALITY_APPROVED", "DISTRIBUTED", "COMPLETED"];
    if (closedStatuses.includes(consignment.status)) {
      return res.status(400).json({ error: `Consignment is ${consignment.status} and can no longer receive goods` });
    }

    // Generate GRN number (linked to the consignment and, when known, its PO)
    const number = `GRN-CSN-${Date.now().toString().slice(-8)}`;
    const yearCode = buildYearCode();

    const grn = await prisma.$transaction(async (tx) => {
      const receipt = await tx.goodsReceipt.create({
        data: {
          number,
          // Keeping the PO reference gives full PO -> consignment -> GRN traceability.
          poId: consignment.poId ?? null,
          consignmentId,
          supplierId: consignment.supplierId ?? null,
          source: "CONSIGNMENT",
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
        const consignmentItem = consignment.items.find((ci) => ci.id === consignmentItemId);

        if (!consignmentItem) {
          throw new Error(`Consignment item not found on this consignment: ${consignmentItemId}`);
        }

        // Only what is still outstanding on this consignment line can come in now.
        const outstanding = Number(consignmentItem.quantity) - Number(consignmentItem.receivedQty);
        if (Number(quantity) > outstanding) {
          throw new Error(
            `${consignmentItem.material.name}: only ${outstanding} ${consignmentItem.unitOfMeasure} still outstanding on this consignment`
          );
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
        // Batch number is assigned by QA on inspection; until then the lot code
        // (or a provisional reference) identifies the lot.
        const resolvedBatchNumber =
          lotCode ?? (String(batchNumber ?? "").trim() || `PENDING-${number}-${consignmentItem.id.slice(0, 6)}`);

        // 1. Create or get batch lot
        const batchLot = await tx.batchLot.upsert({
          where: { materialId_batchNumber: { materialId, batchNumber: resolvedBatchNumber } },
          update: {},
          create: {
            materialId,
            batchNumber: resolvedBatchNumber,
            status: "QUARANTINE",
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
            unitCost: Number(consignmentItem.poItem?.unitCost ?? 0),
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

        // 5. Advance the consignment line and the PO line it fulfils.
        await tx.consignmentItem.update({
          where: { id: consignmentItem.id },
          data: { receivedQty: { increment: Number(quantity) } },
        });
        if (consignmentItem.poItemId) {
          await tx.purchaseOrderItem.update({
            where: { id: consignmentItem.poItemId },
            data: { receivedQty: { increment: Number(quantity) } },
          });
        }
      }

      // 6. Consignment + PO state follow the line balances.
      if (consignment.poId) {
        await recomputePurchaseOrderStatus(tx, consignment.poId);
      }

      const lineBalances = await tx.consignmentItem.findMany({
        where: { consignmentId },
        select: { quantity: true, receivedQty: true },
      });
      const fullyReceived = lineBalances.every((l) => Number(l.receivedQty) >= Number(l.quantity));

      await tx.consignment.update({
        where: { id: consignmentId },
        data: {
          status: fullyReceived ? "RECEIVED" : "PARTIALLY_RECEIVED",
          ...(fullyReceived ? { receivedAt: new Date() } : {}),
        },
      });

      return receipt;
    });

    res.status(201).json({ grn });
  } catch (error: any) {
    console.error("POST /grn/consignment error:", error);
    res.status(400).json({ error: error?.message || "Database error" });
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
      // 1. Ledger entries for this GRN, captured before deletion so consignment
      //    lines can be rolled back by exactly what was posted.
      const ledgerEntries = await tx.inventoryTransaction.findMany({
        where: { referenceType: "GRN", referenceId: grnId },
        select: { consignmentItemId: true, quantity: true },
      });

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

      // 4. Reverse the consignment line balances this receipt advanced.
      if (grn.consignmentId) {
        for (const entry of ledgerEntries) {
          if (!entry.consignmentItemId) continue;
          await tx.consignmentItem.update({
            where: { id: entry.consignmentItemId },
            data: { receivedQty: { decrement: Number(entry.quantity) } },
          });
        }

        const balances = await tx.consignmentItem.findMany({
          where: { consignmentId: grn.consignmentId },
          select: { quantity: true, receivedQty: true },
        });
        const fullyReceived = balances.every((l) => Number(l.receivedQty) >= Number(l.quantity));
        await tx.consignment.update({
          where: { id: grn.consignmentId },
          data: {
            status: fullyReceived ? "RECEIVED" : "PARTIALLY_RECEIVED",
            ...(fullyReceived ? {} : { receivedAt: null }),
          },
        });
      }

      // 5. Delete GRN items
      await tx.goodsReceiptItem.deleteMany({
        where: { grnId },
      });

      // 6. Delete inspection records for this GRN
      await tx.inspectionRecord.deleteMany({
        where: {
          inspectionType: "GRN",
          referenceId: grnId,
        },
      });

      // 7. Re-derive the PO state from its (now reduced) line balances.
      if (grn.poId) {
        await recomputePurchaseOrderStatus(tx, grn.poId);
      }

      // 8. Delete the GRN itself
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
