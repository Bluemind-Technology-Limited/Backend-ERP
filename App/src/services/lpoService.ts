import { Resend } from "resend";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/db.js";
import { generateLpoPdf } from "./lpoPdf.js";
import { logActivity } from "./userActivityLogger.js";

/**
 * Approved-requisition -> supplier LPO flow.
 *
 * One internal PurchaseOrder is created per requisition. Its items remember
 * their supplier, so the same order can be split into one LPO PDF + email per
 * supplier. LPOs are issued per item: a line that has already travelled on an
 * LPO is never offered again, and a line can be put on a temporary hold, so a
 * single order can be sent to suppliers over several rounds.
 */

export class LpoValidationError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(issues.join(" "));
    this.name = "LpoValidationError";
    this.issues = issues;
  }
}

interface SupplierInfo {
  id: string;
  name: string;
  email: string | null;
  contactPerson: string | null;
  phone: string | null;
  address: string | null;
  vendorCode: string | null;
}

interface MergedItem {
  materialId: string;
  materialName: string;
  sku: string;
  unitOfMeasure: string;
  quantity: number;
  standardCost: number;
  suppliers: SupplierInfo[];
}

const SUPPLIER_SELECT = {
  id: true,
  name: true,
  email: true,
  contactPerson: true,
  phone: true,
  address: true,
  vendorCode: true,
} as const;

const REQUISITION_FOR_LPO = {
  requestedBy: { select: { fullName: true, email: true } },
  purchaseOrders: { select: { id: true, number: true, status: true } },
  items: {
    include: {
      material: {
        select: {
          id: true,
          name: true,
          sku: true,
          unitOfMeasure: true,
          standardCost: true,
          suppliers: {
            include: {
              supplier: { select: SUPPLIER_SELECT },
            },
          },
        },
      },
    },
  },
} as const;

const PURCHASE_ORDER_FOR_LPO = {
  supplier: { select: SUPPLIER_SELECT },
  requisition: { select: { id: true, number: true, notes: true } },
  items: {
    include: {
      material: {
        select: {
          id: true,
          name: true,
          sku: true,
          unitOfMeasure: true,
          standardCost: true,
          suppliers: {
            include: {
              supplier: { select: SUPPLIER_SELECT },
            },
          },
        },
      },
      supplier: { select: SUPPLIER_SELECT },
    },
  },
} as const;

async function loadRequisition(requisitionId: string) {
  return prisma.requisition.findUnique({
    where: { id: requisitionId },
    include: REQUISITION_FOR_LPO,
  });
}

function mergeItems(requisition: NonNullable<Awaited<ReturnType<typeof loadRequisition>>>): MergedItem[] {
  const merged = new Map<string, MergedItem>();

  for (const item of requisition.items) {
    const material = item.material;
    const existing = merged.get(material.id);
    if (existing) {
      existing.quantity += Number(item.quantity);
      continue;
    }
    merged.set(material.id, {
      materialId: material.id,
      materialName: material.name,
      sku: material.sku,
      unitOfMeasure: item.unitOfMeasure,
      quantity: Number(item.quantity),
      standardCost: Number(material.standardCost ?? 0),
      suppliers: material.suppliers.map((s) => s.supplier),
    });
  }

  return [...merged.values()];
}

function supplierForItem(item: MergedItem, selectedSupplierId?: string): SupplierInfo | null {
  if (selectedSupplierId) {
    return item.suppliers.find((s) => s.id === selectedSupplierId) ?? null;
  }
  return item.suppliers.length === 1 ? item.suppliers[0] : null;
}

function groupBySupplier(
  items: MergedItem[],
  selections: Record<string, string>,
  unitCosts: Record<string, number>
) {
  const groups = new Map<
    string,
    { supplier: SupplierInfo; items: Array<MergedItem & { unitCost: number }>; total: number }
  >();

  for (const item of items) {
    const supplier = supplierForItem(item, selections[item.materialId]);
    if (!supplier) continue;

    const unitCost = unitCosts[item.materialId] ?? item.standardCost;
    const group = groups.get(supplier.id) ?? { supplier, items: [], total: 0 };
    group.items.push({ ...item, unitCost });
    group.total += item.quantity * unitCost;
    groups.set(supplier.id, group);
  }

  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// Requisition preview (legacy entry point)
// ---------------------------------------------------------------------------

/** Preview data for the Generate & Send modal, keyed by requisition. */
export async function getLpoPreview(requisitionId: string) {
  const requisition = await loadRequisition(requisitionId);
  if (!requisition) throw new Error("Requisition not found");
  if (requisition.status !== "APPROVED") {
    throw new Error("Only approved requisitions can be converted to LPOs");
  }

  const merged = mergeItems(requisition);
  const items = merged.map((item) => ({
    ...item,
    defaultSupplierId:
      item.suppliers.length === 1 ? item.suppliers[0].id : "",
  }));

  const selections: Record<string, string> = {};
  for (const item of items) {
    if (item.defaultSupplierId) selections[item.materialId] = item.defaultSupplierId;
  }

  return {
    requisition: {
      id: requisition.id,
      number: requisition.number,
      notes: requisition.notes,
      requestedBy: requisition.requestedBy?.fullName ?? null,
      existingPOs: requisition.purchaseOrders,
    },
    items,
    groups: groupBySupplier(
      items,
      selections,
      Object.fromEntries(items.map((i) => [i.materialId, i.standardCost]))
    ),
  };
}

// ---------------------------------------------------------------------------
// Purchase order -> LPO rounds
// ---------------------------------------------------------------------------

/**
 * Creates the internal purchase order for an approved requisition if it does
 * not exist yet. Never deletes or rewrites lines, so LPO history survives.
 */
export async function ensurePurchaseOrderForRequisition(requisitionId: string, userId: string) {
  const requisition = await loadRequisition(requisitionId);
  if (!requisition) throw new Error("Requisition not found");
  if (requisition.status !== "APPROVED") {
    throw new Error("Only approved requisitions can be converted to LPOs");
  }

  const existing = await prisma.purchaseOrder.findFirst({
    where: { requisitionId: requisition.id },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing;

  const merged = mergeItems(requisition);
  if (merged.length === 0) throw new LpoValidationError(["This requisition has no items."]);

  const supplierless = merged.filter((item) => item.suppliers.length === 0);
  if (supplierless.length) {
    throw new LpoValidationError(
      supplierless.map((item) => `${item.materialName} has no supplier linked in Master Data.`)
    );
  }

  return prisma.purchaseOrder.create({
    data: {
      number: `PO-${Date.now().toString().slice(-8)}`,
      supplierId: merged[0].suppliers[0].id,
      requisitionId: requisition.id,
      createdById: userId,
      status: "DRAFT",
      notes: requisition.notes,
      items: {
        create: merged.map((item) => ({
          materialId: item.materialId,
          supplierId: item.suppliers.length === 1 ? item.suppliers[0].id : null,
          quantity: item.quantity,
          unitCost: item.standardCost,
          unitOfMeasure: item.unitOfMeasure,
        })),
      },
    },
  });
}

/** Supplier options + LPO/hold state for every line on an order. */
export async function getPurchaseOrderLpoPreview(poId: string) {
  const purchaseOrder = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: PURCHASE_ORDER_FOR_LPO,
  });
  if (!purchaseOrder) throw new Error("Purchase order not found");

  const items = purchaseOrder.items.map((item) => {
    const linked = item.material.suppliers.map((s) => s.supplier);
    const suppliers = [...linked];
    if (item.supplier && !suppliers.some((s) => s.id === item.supplier?.id)) {
      suppliers.push(item.supplier);
    }
    const ordered = Number(item.quantity);
    const received = Number(item.receivedQty);
    const fullyReceived = received >= ordered;
    const lpoSent = Boolean(item.lpoSentAt);
    return {
      id: item.id,
      materialId: item.materialId,
      materialName: item.material.name,
      sku: item.material.sku,
      unitOfMeasure: item.unitOfMeasure,
      quantity: ordered,
      receivedQty: received,
      unitCost: Number(item.unitCost),
      standardCost: Number(item.material.standardCost ?? 0),
      supplierId: item.supplierId ?? (suppliers.length === 1 ? suppliers[0].id : ""),
      supplierName: item.supplier?.name ?? null,
      suppliers,
      onHold: item.onHold,
      holdReason: item.holdReason,
      lpoNumber: item.lpoNumber,
      lpoSentAt: item.lpoSentAt,
      lpoSent,
      fullyReceived,
      eligible: !lpoSent && !item.onHold && !fullyReceived,
    };
  });

  return {
    purchaseOrder: {
      id: purchaseOrder.id,
      number: purchaseOrder.number,
      status: purchaseOrder.status,
      notes: purchaseOrder.notes,
      expectedDelivery: purchaseOrder.expectedDelivery,
      sentAt: purchaseOrder.sentAt,
      supplier: purchaseOrder.supplier,
      requisition: purchaseOrder.requisition,
      lpoSequence: purchaseOrder.lpoSequence,
    },
    items,
    summary: {
      total: items.length,
      sent: items.filter((i) => i.lpoSent).length,
      onHold: items.filter((i) => i.onHold).length,
      received: items.filter((i) => i.fullyReceived).length,
      eligible: items.filter((i) => i.eligible).length,
    },
  };
}

export interface SendPurchaseOrderLposInput {
  poId: string;
  userId: string;
  /** PurchaseOrderItem ids selected for this LPO round. */
  itemIds: string[];
  /** itemId -> supplierId, when a line can be bought from several suppliers. */
  selections?: Record<string, string>;
  /** itemId -> unit cost. */
  unitCosts?: Record<string, number>;
  notes?: string | null;
  expectedDelivery?: string | null;
}

interface PreparedLine {
  itemId: string;
  materialId: string;
  materialName: string;
  sku: string;
  quantity: number;
  unitOfMeasure: string;
  unitCost: number;
}

export async function sendPurchaseOrderLpos(input: SendPurchaseOrderLposInput) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: input.poId },
    include: PURCHASE_ORDER_FOR_LPO,
  });
  if (!po) throw new Error("Purchase order not found");

  const selectedIds = [...new Set(input.itemIds ?? [])];
  if (selectedIds.length === 0) {
    throw new LpoValidationError(["Select at least one item to include in the LPO."]);
  }

  const byId = new Map(po.items.map((item) => [item.id, item]));
  const issues: string[] = [];
  const chosen: Array<{ item: (typeof po.items)[number]; supplier: SupplierInfo; unitCost: number }> = [];

  for (const itemId of selectedIds) {
    const item = byId.get(itemId);
    if (!item) {
      issues.push("One of the selected items is not on this purchase order.");
      continue;
    }

    const name = item.material.name;
    if (item.lpoSentAt) {
      issues.push(`${name} was already sent on ${item.lpoNumber ?? "an earlier LPO"}.`);
      continue;
    }
    if (item.onHold) {
      issues.push(`${name} is on hold — resume it before including it in an LPO.`);
      continue;
    }
    if (Number(item.receivedQty) >= Number(item.quantity)) {
      issues.push(`${name} has already been fully received.`);
      continue;
    }

    const linked = item.material.suppliers.map((s) => s.supplier);
    const pool = [...linked];
    if (item.supplier && !pool.some((s) => s.id === item.supplierId)) pool.push(item.supplier);

    const supplierId = input.selections?.[item.id] ?? item.supplierId ?? (pool.length === 1 ? pool[0].id : "");
    const supplier = pool.find((s) => s.id === supplierId);
    if (!supplier) {
      issues.push(
        pool.length === 0
          ? `${name} has no supplier linked in Master Data.`
          : `Choose a supplier for ${name} (${pool.map((s) => s.name).join(", ")}).`
      );
      continue;
    }
    if (!supplier.email?.trim()) {
      issues.push(`${supplier.name} has no email address. Add it in Master Data → Suppliers.`);
    }

    const rawCost = input.unitCosts?.[item.id];
    const unitCost = rawCost !== undefined ? Number(rawCost) : Number(item.unitCost);
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      issues.push(`Unit cost for ${name} must be zero or greater.`);
      continue;
    }

    chosen.push({ item, supplier, unitCost });
  }

  if (issues.length) throw new LpoValidationError([...new Set(issues)]);
  if (chosen.length === 0) {
    throw new LpoValidationError(["No supplier groups could be built for the selected items."]);
  }

  // One LPO per supplier; duplicate material lines for the same supplier merge.
  const groups = new Map<
    string,
    { supplier: SupplierInfo; lines: PreparedLine[]; itemIds: string[]; total: number }
  >();
  for (const { item, supplier, unitCost } of chosen) {
    const group = groups.get(supplier.id) ?? { supplier, lines: [], itemIds: [], total: 0 };
    const existing = group.lines.find((line) => line.materialId === item.materialId && line.unitCost === unitCost);
    if (existing) {
      existing.quantity += Number(item.quantity);
    } else {
      group.lines.push({
        itemId: item.id,
        materialId: item.materialId,
        materialName: item.material.name,
        sku: item.material.sku,
        quantity: Number(item.quantity),
        unitOfMeasure: item.unitOfMeasure,
        unitCost,
      });
    }
    group.itemIds.push(item.id);
    group.total += Number(item.quantity) * unitCost;
    groups.set(supplier.id, group);
  }
  const groupList = [...groups.values()];

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("Email service is not configured (RESEND_API_KEY missing).");
  }

  // Reserve LPO numbers so concurrent sends never collide.
  const reserved = await prisma.purchaseOrder.update({
    where: { id: po.id },
    data: { lpoSequence: { increment: groupList.length } },
    select: { lpoSequence: true },
  });
  const firstSequence = reserved.lpoSequence - groupList.length;

  const resend = new Resend(apiKey);
  const from = process.env.RESEND_FROM_EMAIL || "noreply@kibgroup.com";
  const currency = process.env.LPO_CURRENCY || "NGN";

  const results: Array<{
    supplierId: string;
    supplierName: string;
    email: string;
    lpoNumber: string;
    itemIds: string[];
    itemCount: number;
    total: number;
    success: boolean;
    error?: string;
  }> = [];

  for (let index = 0; index < groupList.length; index++) {
    const group = groupList[index];
    const lpoNumber = `${po.number}-${String(firstSequence + index + 1).padStart(2, "0")}`;
    const supplier = group.supplier;
    const supplierEmail = supplier.email!.trim();

    try {
      const pdf = await generateLpoPdf({
        lpoNumber,
        poNumber: po.number,
        requisitionNumber: po.requisition?.number ?? null,
        date: new Date(),
        expectedDelivery: po.expectedDelivery,
        notes: input.notes !== undefined ? input.notes : po.notes,
        supplier: {
          name: supplier.name,
          contactPerson: supplier.contactPerson,
          email: supplier.email,
          phone: supplier.phone,
          address: supplier.address,
        },
        lines: group.lines.map((line) => ({
          materialName: line.materialName,
          sku: line.sku,
          quantity: line.quantity,
          unitOfMeasure: line.unitOfMeasure,
          unitCost: line.unitCost,
        })),
      });

      const { error } = await resend.emails.send({
        from,
        to: supplierEmail,
        subject: `Local Purchase Order ${lpoNumber} — ${process.env.COMPANY_NAME || "KIB Group"}`,
        html: `
          <div style="font-family:Arial,sans-serif;color:#171717;line-height:1.5">
            <p>Dear ${supplier.contactPerson || supplier.name},</p>
            <p>Please find attached our Local Purchase Order <strong>${lpoNumber}</strong>
            covering ${group.lines.length} item(s) totalling
            <strong>${new Intl.NumberFormat("en-NG", { style: "currency", currency }).format(group.total)}</strong>.</p>
            <p>Kindly acknowledge receipt and confirm the delivery date.</p>
            <p>Regards,<br/>${process.env.COMPANY_NAME || "KIB Group"} Procurement</p>
          </div>
        `,
        attachments: [
          {
            filename: `${lpoNumber}.pdf`,
            content: pdf.toString("base64"),
          },
        ],
      });

      results.push({
        supplierId: supplier.id,
        supplierName: supplier.name,
        email: supplierEmail,
        lpoNumber,
        itemIds: group.itemIds,
        itemCount: group.lines.length,
        total: group.total,
        success: !error,
        error: error?.message,
      });
    } catch (error: any) {
      results.push({
        supplierId: supplier.id,
        supplierName: supplier.name,
        email: supplierEmail,
        lpoNumber,
        itemIds: group.itemIds,
        itemCount: group.lines.length,
        total: group.total,
        success: false,
        error: error?.message || "Failed to generate or send LPO",
      });
    }
  }

  const sentAt = new Date();
  const successful = results.filter((result) => result.success);
  const expectedDelivery = input.expectedDelivery ? new Date(input.expectedDelivery) : undefined;

  const state = await prisma.$transaction(async (tx) => {
    // Remember the chosen supplier/cost even when the email fails — a retry
    // should not have to re-enter them.
    for (const { item, supplier, unitCost } of chosen) {
      await tx.purchaseOrderItem.update({
        where: { id: item.id },
        data: { supplierId: supplier.id, unitCost },
      });
    }

    for (const result of successful) {
      await tx.purchaseOrderItem.updateMany({
        where: { id: { in: result.itemIds } },
        data: { lpoNumber: result.lpoNumber, lpoSentAt: sentAt },
      });
    }

    const lines = await tx.purchaseOrderItem.findMany({
      where: { poId: po.id },
      select: { onHold: true, lpoSentAt: true },
    });
    const remaining = lines.filter((line) => !line.lpoSentAt && !line.onHold).length;

    const history = Array.isArray(po.lpoEmails) ? (po.lpoEmails as unknown[]) : [];
    const nextStatus =
      po.status === "DRAFT" && remaining === 0 ? "SENT" : po.status;

    await tx.purchaseOrder.update({
      where: { id: po.id },
      data: {
        status: nextStatus,
        sentAt: po.sentAt ?? (successful.length ? sentAt : null),
        lpoEmails: [
          ...history,
          ...results.map((result) => ({
            supplierId: result.supplierId,
            supplierName: result.supplierName,
            email: result.email,
            lpoNumber: result.lpoNumber,
            itemCount: result.itemCount,
            total: result.total,
            success: result.success,
            error: result.error,
            sentAt,
          })),
        ] as Prisma.InputJsonValue,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(expectedDelivery ? { expectedDelivery } : {}),
      },
    });

    return { remaining };
  });

  const updated = await prisma.purchaseOrder.findUnique({
    where: { id: po.id },
    include: {
      supplier: { select: { id: true, name: true } },
      items: {
        include: {
          material: { select: { id: true, name: true, sku: true, unitOfMeasure: true } },
          supplier: { select: { id: true, name: true } },
        },
      },
    },
  });

  await logActivity({
    userId: input.userId,
    activityType: "UPDATE",
    module: "procurement",
    description: `Sent ${results.length} LPO(s) from ${po.number}${state.remaining ? ` — ${state.remaining} line(s) still to send` : ""}`,
    entityType: "PurchaseOrder",
    entityId: po.id,
    details: { results },
  }).catch((logError) => console.error("Failed to log LPO send:", logError));

  return {
    purchaseOrder: updated,
    lpoResults: results,
    allSent: results.every((result) => result.success),
    remaining: state.remaining,
  };
}

/** Temporarily withhold a line from LPO selection. */
export async function setPurchaseOrderItemHold(
  poId: string,
  itemId: string,
  onHold: boolean,
  reason?: string | null
) {
  const item = await prisma.purchaseOrderItem.findFirst({
    where: { id: itemId, poId },
    select: { id: true, lpoNumber: true, lpoSentAt: true, receivedQty: true },
  });
  if (!item) throw new Error("Purchase order item not found");

  if (onHold) {
    if (item.lpoSentAt) {
      throw new Error(`This line has already been sent on ${item.lpoNumber ?? "an LPO"}`);
    }
    if (Number(item.receivedQty) > 0) {
      throw new Error("This line has already been received");
    }
  }

  return prisma.purchaseOrderItem.update({
    where: { id: itemId },
    data: {
      onHold,
      holdReason: onHold ? reason?.trim() || null : null,
    },
  });
}

// ---------------------------------------------------------------------------
// Legacy requisition entry point — sends every eligible line in one round.
// ---------------------------------------------------------------------------

export interface SendLpoInput {
  requisitionId: string;
  userId: string;
  selections?: Record<string, string>;
  unitCosts?: Record<string, number>;
  notes?: string | null;
  expectedDelivery?: string | null;
}

export async function sendLpos(input: SendLpoInput) {
  const po = await ensurePurchaseOrderForRequisition(input.requisitionId, input.userId);

  const items = await prisma.purchaseOrderItem.findMany({
    where: { poId: po.id },
    select: {
      id: true,
      materialId: true,
      supplierId: true,
      quantity: true,
      receivedQty: true,
      onHold: true,
      lpoSentAt: true,
    },
  });

  const eligible = items.filter(
    (item) =>
      !item.onHold &&
      !item.lpoSentAt &&
      Number(item.receivedQty) < Number(item.quantity)
  );
  if (eligible.length === 0) {
    throw new LpoValidationError([
      "Every line on this purchase order has already been sent or is on hold.",
    ]);
  }

  // The legacy payload keys selections by material id.
  const selections: Record<string, string> = {};
  const unitCosts: Record<string, number> = {};
  for (const item of eligible) {
    const supplierId = input.selections?.[item.materialId];
    if (supplierId) selections[item.id] = supplierId;
    else if (item.supplierId) selections[item.id] = item.supplierId;

    const cost = input.unitCosts?.[item.materialId];
    if (cost !== undefined) unitCosts[item.id] = Number(cost);
  }

  return sendPurchaseOrderLpos({
    poId: po.id,
    userId: input.userId,
    itemIds: eligible.map((item) => item.id),
    selections,
    unitCosts,
    notes: input.notes,
    expectedDelivery: input.expectedDelivery,
  });
}
