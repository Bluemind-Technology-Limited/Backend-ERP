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
 * supplier. Duplicate material lines for the same supplier are merged.
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
              supplier: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  contactPerson: true,
                  phone: true,
                  address: true,
                  vendorCode: true,
                },
              },
            },
          },
        },
      },
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

/** Preview data for the Generate & Send modal. */
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

export interface SendLpoInput {
  requisitionId: string;
  userId: string;
  selections?: Record<string, string>;
  unitCosts?: Record<string, number>;
  notes?: string | null;
  expectedDelivery?: string | null;
}

export async function sendLpos(input: SendLpoInput) {
  const requisition = await loadRequisition(input.requisitionId);
  if (!requisition) throw new Error("Requisition not found");
  if (requisition.status !== "APPROVED") {
    throw new Error("Only approved requisitions can be converted to LPOs");
  }

  const merged = mergeItems(requisition);
  const selections = input.selections ?? {};
  const rawUnitCosts = input.unitCosts ?? {};
  const unitCosts: Record<string, number> = {};
  for (const [materialId, value] of Object.entries(rawUnitCosts)) {
    unitCosts[materialId] = Number(value);
  }
  const issues: string[] = [];

  for (const item of merged) {
    if (item.suppliers.length === 0) {
      issues.push(`${item.materialName} has no supplier linked in Master Data.`);
      continue;
    }
    const supplier = supplierForItem(item, selections[item.materialId]);
    if (!supplier) {
      const names = item.suppliers.map((s) => s.name).join(", ");
      issues.push(`Choose a supplier for ${item.materialName} (${names}).`);
      continue;
    }
    if (!supplier.email?.trim()) {
      issues.push(`${supplier.name} has no email address. Add it in Master Data → Suppliers.`);
    }
    if (!Number.isFinite(unitCosts[item.materialId]) || Number(unitCosts[item.materialId]) < 0) {
      if (unitCosts[item.materialId] !== undefined) {
        issues.push(`Unit cost for ${item.materialName} must be zero or greater.`);
      }
    }
  }

  if (issues.length) throw new LpoValidationError(issues);

  const groups = groupBySupplier(merged, selections, unitCosts);
  if (groups.length === 0) {
    throw new LpoValidationError(["No supplier groups could be built for this requisition."]);
  }

  const existing = await prisma.purchaseOrder.findFirst({
    where: { requisitionId: requisition.id },
    include: { items: true, goodsReceipts: { select: { id: true } } },
  });

  if (existing?.status === "SENT") {
    throw new Error("LPOs have already been sent for this requisition.");
  }
  if (existing && existing.goodsReceipts.length > 0) {
    throw new Error("This purchase order already has goods receipts and cannot be regenerated.");
  }

  const expectedDelivery = input.expectedDelivery
    ? new Date(input.expectedDelivery)
    : undefined;
  const notes = input.notes !== undefined ? input.notes : requisition.notes;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("Email service is not configured (RESEND_API_KEY missing).");
  }

  // One internal PO. The first supplier is stored as the primary supplier for
  // legacy screens; each item keeps its own supplier for the outbound split.
  const purchaseOrder = await prisma.$transaction(async (tx) => {
    const po = existing
      ? await tx.purchaseOrder.update({
          where: { id: existing.id },
          data: {
            supplierId: groups[0].supplier.id,
            notes: notes ?? null,
            ...(expectedDelivery !== undefined ? { expectedDelivery } : {}),
            lpoEmails: Prisma.DbNull,
          },
        })
      : await tx.purchaseOrder.create({
          data: {
            number: `PO-${Date.now().toString().slice(-8)}`,
            supplierId: groups[0].supplier.id,
            requisitionId: requisition.id,
            createdById: input.userId,
            status: "DRAFT",
            notes: notes ?? null,
            expectedDelivery: expectedDelivery ?? null,
          },
        });

    if (existing) {
      await tx.purchaseOrderItem.deleteMany({ where: { poId: po.id } });
    }

    await tx.purchaseOrderItem.createMany({
      data: groups.flatMap((group) =>
        group.items.map((item) => ({
          poId: po.id,
          materialId: item.materialId,
          supplierId: group.supplier.id,
          quantity: item.quantity,
          unitCost: item.unitCost,
          unitOfMeasure: item.unitOfMeasure,
        }))
      ),
    });

    return po;
  });

  const resend = new Resend(apiKey);
  const from = process.env.RESEND_FROM_EMAIL || "noreply@kibgroup.com";

  const results: Array<{
    supplierId: string;
    supplierName: string;
    email: string;
    lpoNumber: string;
    success: boolean;
    error?: string;
  }> = [];

  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    const lpoNumber = `${purchaseOrder.number}-${String(index + 1).padStart(2, "0")}`;
    const supplier = group.supplier;
    const supplierEmail = supplier.email!.trim();

    try {
      const pdf = await generateLpoPdf({
        lpoNumber,
        poNumber: purchaseOrder.number,
        requisitionNumber: requisition.number,
        date: new Date(),
        expectedDelivery: expectedDelivery ?? null,
        notes: notes ?? null,
        supplier: {
          name: supplier.name,
          contactPerson: supplier.contactPerson,
          email: supplier.email,
          phone: supplier.phone,
          address: supplier.address,
        },
        lines: group.items.map((item) => ({
          materialName: item.materialName,
          sku: item.sku,
          quantity: item.quantity,
          unitOfMeasure: item.unitOfMeasure,
          unitCost: item.unitCost,
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
            covering ${group.items.length} item(s) totalling
            <strong>${new Intl.NumberFormat("en-NG", { style: "currency", currency: process.env.LPO_CURRENCY || "NGN" }).format(group.total)}</strong>.</p>
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
        success: !error,
        error: error?.message,
      });
    } catch (error: any) {
      results.push({
        supplierId: supplier.id,
        supplierName: supplier.name,
        email: supplierEmail,
        lpoNumber,
        success: false,
        error: error?.message || "Failed to generate or send LPO",
      });
    }
  }

  const allSent = results.every((result) => result.success);
  const updated = await prisma.purchaseOrder.update({
    where: { id: purchaseOrder.id },
    data: {
      status: allSent ? "SENT" : "DRAFT",
      sentAt: allSent ? new Date() : null,
      lpoEmails: results as any,
    },
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
    description: `Generated ${results.length} LPO(s) for ${requisition.number}${allSent ? " and emailed suppliers" : " (some emails failed)"}`,
    entityType: "PurchaseOrder",
    entityId: updated.id,
    details: { requisition: requisition.number, results },
  }).catch((logError) => console.error("Failed to log LPO send:", logError));

  return { purchaseOrder: updated, lpoResults: results, allSent };
}
