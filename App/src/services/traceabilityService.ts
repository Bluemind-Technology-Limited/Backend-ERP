/**
 * Traceability Service
 *
 * Full upstream/downstream trace for any batch lot — raw material, ingredient
 * or finished good — across BOTH production paths:
 *
 *   order path : BatchLot <- ProductionOrder.finishedBatchId <- PROD_CONSUMPTION ledger
 *   plan path  : BatchLot <- ProductionStageRecord(FINISHING).finishedBatchLotId
 *                         <- ProductionStageRecord(GRINDING).grindingInputs (exact batches)
 *                         -> fallback: PLAN_ISSUE ledger for the plan
 *
 * Inbound receipt resolves through a Purchase Order *or* a Consignment, since
 * consignment-based GRNs have no PO.
 */
import { prisma } from '../lib/db.js';

const BATCH_SELECT = {
  id: true,
  batchNumber: true,
  status: true,
  manufacturingDate: true,
  expiryDate: true,
  notes: true,
  // Lot code (SOP KIB/QCA/010) — carried on every batch node so the tree can
  // show the code next to the ingredient and the supplier it came from.
  origin: true,
  lotCode: true,
  setNumber: true,
  vendorCode: true,
  ingredientCode: true,
  yearCode: true,
  supplierBatchNumber: true,
  supplier: { select: { id: true, name: true, vendorCode: true } },
};

async function resolveInbound(batchLotId: string) {
  const item = await prisma.goodsReceiptItem.findFirst({
    where: { batchLotId },
    include: {
      grn: {
        include: {
          po: {
            include: {
              supplier: {
                select: { id: true, name: true, contactPerson: true, email: true, phone: true },
              },
            },
          },
          consignment: {
            include: {
              supplier: {
                select: { id: true, name: true, contactPerson: true, email: true, phone: true },
              },
              warehouse: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  });

  if (!item) return null;
  const grn: any = (item as any).grn;

  const supplier = grn.po?.supplier ?? grn.consignment?.supplier ?? null;
  const via = grn.po ? 'PO' : grn.consignment ? 'CONSIGNMENT' : 'UNKNOWN';

  return {
    grnNumber: grn.number,
    grnStatus: grn.status,
    receivedAt: grn.receivedAt,
    quantity: Number(item.quantity),
    unitOfMeasure: item.unitOfMeasure,
    poNumber: grn.po?.number ?? null,
    orderDate: grn.po?.orderDate ?? null,
    consignmentNumber: grn.consignment?.consignmentNumber ?? null,
    warehouse: grn.consignment?.warehouse ?? null,
    supplier,
    via,
  };
}

/** Resolve a set of consumed batch-lot ids into batch + inbound detail. */
async function hydrateRawBatches(batchLotIds: string[]) {
  const distinct = [...new Set(batchLotIds.filter(Boolean))];
  if (distinct.length === 0) return [];
  const batches = await prisma.batchLot.findMany({
    where: { id: { in: distinct } },
    select: BATCH_SELECT,
  });
  return Promise.all(
    batches.map(async (batch) => ({ batch, inbound: await resolveInbound(batch.id) }))
  );
}

/**
 * Build the ingredient branches (upstream) from BOM lines + consumed batches.
 * Any consumed material missing from the BOM is appended so nothing is hidden.
 */
async function buildIngredients(
  bomIngredients: any[],
  consumptions: Array<{ materialId: string; batchLotId: string | null; quantity: number }>,
  source: 'GRINDING_INPUTS' | 'PLAN_ISSUE' | 'PROD_CONSUMPTION'
) {
  const byMaterial = new Map<string, { batchLotIds: string[]; quantity: number }>();
  for (const c of consumptions) {
    const entry = byMaterial.get(c.materialId) ?? { batchLotIds: [], quantity: 0 };
    if (c.batchLotId) entry.batchLotIds.push(c.batchLotId);
    entry.quantity += Math.abs(Number(c.quantity));
    byMaterial.set(c.materialId, entry);
  }

  const rows: any[] = [];
  const covered = new Set<string>();

  for (const ing of bomIngredients) {
    const match = byMaterial.get(ing.materialId);
    covered.add(ing.materialId);
    rows.push({
      materialId: ing.materialId,
      materialName: ing.material?.name ?? null,
      sku: ing.material?.sku ?? null,
      type: ing.material?.type ?? null,
      quantity: Number(ing.quantity),
      unitOfMeasure: ing.unitOfMeasure,
      isPercentage: ing.isPercentage,
      source: match ? source : null,
      rawBatches: match ? await hydrateRawBatches(match.batchLotIds) : [],
    });
  }

  // Consumed materials not present in the BOM (e.g. custom additions).
  for (const [materialId, entry] of byMaterial.entries()) {
    if (covered.has(materialId)) continue;
    const material = await prisma.material.findUnique({
      where: { id: materialId },
      select: { name: true, sku: true, type: true },
    });
    rows.push({
      materialId,
      materialName: material?.name ?? null,
      sku: material?.sku ?? null,
      type: material?.type ?? null,
      quantity: entry.quantity,
      unitOfMeasure: '',
      isPercentage: false,
      source,
      rawBatches: await hydrateRawBatches(entry.batchLotIds),
    });
  }

  return rows;
}

/** Forward trace: where did this batch go? */
async function buildDownstream(batchId: string) {
  const [grindingUses, orderIngredients, movements] = await Promise.all([
    prisma.productionGrindingInput.findMany({
      where: { batchLotId: batchId },
      include: {
        material: { select: { name: true, sku: true } },
        stageRecord: {
          include: {
            planItem: {
              include: {
                bom: { select: { productName: true } },
                productionPlan: { select: { id: true, planNumber: true } },
              },
            },
          },
        },
      },
    }),
    prisma.productionIngredient.findMany({
      where: { batchLotId: batchId },
      include: {
        productionOrder: {
          select: {
            id: true,
            orderNumber: true,
            finishedBatch: {
              select: { id: true, batchNumber: true, material: { select: { name: true, sku: true } } },
            },
          },
        },
      },
    }),
    prisma.inventoryTransaction.findMany({
      where: { batchLotId: batchId },
      include: {
        warehouse: { select: { name: true } },
        createdBy: { select: { fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);

  // Resolve plan-item finished batches for grinding uses.
  const planItemIds = [...new Set(grindingUses.map((g) => g.stageRecord.planItemId))];
  const finishingRecords = planItemIds.length
    ? await prisma.productionStageRecord.findMany({
        where: { planItemId: { in: planItemIds }, stage: 'FINISHING' },
        include: { planItem: { select: { productionPlan: { select: { planNumber: true } } } } },
      })
    : [];
  const finishedBatchIds = finishingRecords
    .map((r) => r.finishedBatchLotId)
    .filter(Boolean) as string[];
  const finishedBatches = finishedBatchIds.length
    ? await prisma.batchLot.findMany({
        where: { id: { in: finishedBatchIds } },
        select: { id: true, batchNumber: true, material: { select: { name: true, sku: true } } },
      })
    : [];
  const finishedMap = new Map(finishedBatches.map((b) => [b.id, b]));

  const viaGrinding = grindingUses
    .map((g) => {
      const planItemId = g.stageRecord.planItemId;
      const fin = finishingRecords.find((r) => r.planItemId === planItemId);
      const batch = fin?.finishedBatchLotId ? finishedMap.get(fin.finishedBatchLotId) : null;
      return {
        via: 'GRINDING' as const,
        planNumber: g.stageRecord.planItem.productionPlan?.planNumber ?? null,
        productName: g.stageRecord.planItem.bom?.productName ?? null,
        materialName: batch?.material?.name ?? null,
        sku: batch?.material?.sku ?? null,
        batchLotId: batch?.id ?? null,
        batchNumber: batch?.batchNumber ?? null,
        quantity: Number(g.quantity),
      };
    })
    .filter((row) => row.batchLotId);

  const viaOrder = orderIngredients
    .filter((pi) => pi.productionOrder?.finishedBatch)
    .map((pi) => ({
      via: 'ORDER_RELEASE' as const,
      planNumber: null,
      productName: null,
      orderNumber: pi.productionOrder.orderNumber,
      materialName: pi.productionOrder.finishedBatch?.material?.name ?? null,
      sku: pi.productionOrder.finishedBatch?.material?.sku ?? null,
      batchLotId: pi.productionOrder.finishedBatch?.id ?? null,
      batchNumber: pi.productionOrder.finishedBatch?.batchNumber ?? null,
      quantity: Number(pi.releasedQuantity ?? pi.projectedQuantity),
    }));

  return {
    usedInFinishedBatches: [...viaGrinding, ...viaOrder],
    movements: movements.map((m) => ({
      id: m.id,
      eventType: m.eventType,
      quantity: Number(m.quantity),
      unitOfMeasure: m.unitOfMeasure,
      warehouseName: m.warehouse?.name ?? null,
      referenceType: m.referenceType,
      referenceId: m.referenceId,
      createdBy: m.createdBy?.fullName ?? null,
      createdAt: m.createdAt,
      notes: m.notes,
    })),
  };
}

export interface BatchMatch {
  id: string;
  batchNumber: string;
  status: string;
  manufacturingDate: Date | null;
  expiryDate: Date | null;
  material: { id: string; name: string; sku: string; type: string; unitOfMeasure: string };
  /** Where the batch came from — inferred from production/GRN links. */
  origin: 'PRODUCTION_ORDER' | 'PRODUCTION_PLAN' | 'INBOUND' | 'UNKNOWN';
  /** The stored lot-code origin (SOP KIB/QCA/010). */
  batchOrigin: string;
  // --- Lot code (SOP KIB/QCA/010) ------------------------------------------
  // The parts travel with the result so a code is never shown on its own — the
  // UI always has the ingredient and supplier names to display beside it.
  lotCode: string | null;
  setNumber: number | null;
  vendorCode: string | null;
  ingredientCode: string | null;
  yearCode: string | null;
  supplierBatchNumber: string | null;
  supplier: { id: string; name: string; vendorCode: string | null } | null;
}

/**
 * Universal search: batch number, material name/SKU, or any lot-code component.
 *
 * Searching "A" matches the vendor code, "1" matches the ingredient code (and
 * the set number), and "A-1-1-26" matches the rendered code — all as structured
 * filters, so nothing is ever parsed out of the string.
 */
export async function searchBatchLots(q: string, limit = 25): Promise<BatchMatch[]> {
  const term = q?.trim();
  if (!term) return [];

  const numeric = /^\d+$/.test(term) ? Number(term) : null;

  const batches = await prisma.batchLot.findMany({
    where: {
      OR: [
        { batchNumber: { contains: term, mode: 'insensitive' } },
        { lotCode: { contains: term, mode: 'insensitive' } },
        { vendorCode: { equals: term, mode: 'insensitive' } },
        { ingredientCode: { equals: term, mode: 'insensitive' } },
        { yearCode: { equals: term, mode: 'insensitive' } },
        ...(numeric !== null ? [{ setNumber: numeric }] : []),
        { supplierBatchNumber: { contains: term, mode: 'insensitive' } },
        { material: { name: { contains: term, mode: 'insensitive' } } },
        { material: { sku: { contains: term, mode: 'insensitive' } } },
        { material: { traceabilityCode: { equals: term, mode: 'insensitive' } } },
        { supplier: { name: { contains: term, mode: 'insensitive' } } },
        { supplier: { vendorCode: { equals: term, mode: 'insensitive' } } },
      ],
    },
    include: {
      material: { select: { id: true, name: true, sku: true, type: true, unitOfMeasure: true } },
      supplier: { select: { id: true, name: true, vendorCode: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  const ids = batches.map((b) => b.id);
  const [orders, plans, receipts] = await Promise.all([
    ids.length
      ? prisma.productionOrder.findMany({
          where: { finishedBatchId: { in: ids } },
          select: { finishedBatchId: true },
        })
      : Promise.resolve([]),
    ids.length
      ? prisma.productionStageRecord.findMany({
          where: { finishedBatchLotId: { in: ids } },
          select: { finishedBatchLotId: true },
        })
      : Promise.resolve([]),
    ids.length
      ? prisma.goodsReceiptItem.findMany({
          where: { batchLotId: { in: ids } },
          select: { batchLotId: true },
        })
      : Promise.resolve([]),
  ]);

  const orderSet = new Set(orders.map((o) => o.finishedBatchId));
  const planSet = new Set(plans.map((p) => p.finishedBatchLotId));
  const inboundSet = new Set(receipts.map((r) => r.batchLotId));

  return batches.map((b) => ({
    id: b.id,
    batchNumber: b.batchNumber,
    status: b.status,
    manufacturingDate: b.manufacturingDate,
    expiryDate: b.expiryDate,
    material: b.material,
    origin: orderSet.has(b.id)
      ? 'PRODUCTION_ORDER'
      : planSet.has(b.id)
        ? 'PRODUCTION_PLAN'
        : inboundSet.has(b.id)
          ? 'INBOUND'
          : 'UNKNOWN',
    batchOrigin: b.origin,
    lotCode: b.lotCode,
    setNumber: b.setNumber,
    vendorCode: b.vendorCode,
    ingredientCode: b.ingredientCode,
    yearCode: b.yearCode,
    supplierBatchNumber: b.supplierBatchNumber,
    supplier: b.supplier,
  }));
}

/** Full bidirectional trace tree for a batch lot id. */
export async function buildTraceTree(batchId: string) {
  const batch = await prisma.batchLot.findUnique({
    where: { id: batchId },
    include: {
      material: { select: { id: true, name: true, sku: true, type: true, unitOfMeasure: true } },
    },
  });
  if (!batch) return null;

  const inbound = await resolveInbound(batch.id);

  // --- order path ---------------------------------------------------------
  const order = await prisma.productionOrder.findFirst({
    where: { finishedBatchId: batch.id },
    include: {
      bom: {
        include: {
          ingredients: {
            include: { material: { select: { id: true, name: true, sku: true, type: true } } },
          },
        },
      },
    },
  });

  // --- plan path ----------------------------------------------------------
  const finishing: any = await prisma.productionStageRecord.findFirst({
    where: { finishedBatchLotId: batch.id, stage: 'FINISHING' },
    include: {
      remainders: true,
      planItem: {
        include: {
          bom: {
            include: {
              finishedSku: { select: { id: true, name: true, sku: true } },
              ingredients: {
                include: { material: { select: { id: true, name: true, sku: true, type: true } } },
              },
            },
          },
          productionPlan: { select: { id: true, planNumber: true, status: true, scheduledFor: true } },
        },
      },
    },
  });

  let producedBy: any = null;
  let ingredients: any[] = [];
  let stages: any = { grinding: null, finishing: null };

  if (order) {
    producedBy = {
      source: 'PRODUCTION_ORDER',
      orderNumber: order.orderNumber,
      planNumber: null,
      productName: order.bom.productName,
      targetQuantity: Number(order.targetQuantity),
      actualYield: order.actualYield ? Number(order.actualYield) : null,
      completedAt: order.actualEnd,
      bomId: order.bom.id,
    };

    const consumption = await prisma.inventoryTransaction.findMany({
      where: {
        referenceType: 'PROD_ORDER',
        referenceId: order.id,
        eventType: 'PROD_CONSUMPTION',
        batchLotId: { not: null },
      },
      select: { materialId: true, batchLotId: true, quantity: true },
    });

    ingredients = await buildIngredients(
      order.bom.ingredients,
      consumption.map((c) => ({
        materialId: c.materialId,
        batchLotId: c.batchLotId,
        quantity: Number(c.quantity),
      })),
      'PROD_CONSUMPTION'
    );
  } else if (finishing) {
    const planItem = finishing.planItem;
    const plan = planItem.productionPlan;

    producedBy = {
      source: 'PRODUCTION_PLAN',
      orderNumber: null,
      planNumber: plan?.planNumber ?? null,
      planStatus: plan?.status ?? null,
      productName: planItem.bom?.productName ?? null,
      targetQuantity: Number(planItem.targetQuantity),
      actualYield: planItem.actualYield ? Number(planItem.actualYield) : null,
      completedAt: plan?.completedAt ?? null,
      bomId: planItem.bom?.id ?? null,
    };

    const grinding: any = await prisma.productionStageRecord.findFirst({
      where: { planItemId: planItem.id, stage: 'GRINDING' },
      include: {
        remainders: true,
        grindingInputs: true,
      },
    });

    stages = {
      grinding: grinding
        ? {
            inputQuantity: Number(grinding.inputQuantity),
            achievedQuantity: Number(grinding.achievedQuantity),
            remainderQuantity: Number(grinding.remainderQuantity),
            unitOfMeasure: grinding.unitOfMeasure,
            machineId: grinding.machineId,
            batchNumber: grinding.batchNumber,
            productionDate: grinding.productionDate,
            status: grinding.status,
            remainders: grinding.remainders.map((r: any) => ({
              materialId: r.materialId,
              quantity: Number(r.quantity),
              unitOfMeasure: r.unitOfMeasure,
            })),
          }
        : null,
      finishing: {
        inputQuantity: Number(finishing.inputQuantity),
        achievedQuantity: Number(finishing.achievedQuantity),
        remainderQuantity: Number(finishing.remainderQuantity),
        unitOfMeasure: finishing.unitOfMeasure,
        batchNumber: finishing.batchNumber,
        productionDate: finishing.productionDate,
        status: finishing.status,
        remainders: finishing.remainders.map((r: any) => ({
          materialId: r.materialId,
          quantity: Number(r.quantity),
          unitOfMeasure: r.unitOfMeasure,
        })),
      },
    };

    const bomIngredients = planItem.bom?.ingredients ?? [];

    if (grinding?.grindingInputs?.length) {
      // Exact lineage: the specific batch lots ground for this batch.
      ingredients = await buildIngredients(
        bomIngredients,
        grinding.grindingInputs.map((g: any) => ({
          materialId: g.materialId,
          batchLotId: g.batchLotId,
          quantity: Number(g.quantity),
        })),
        'GRINDING_INPUTS'
      );
    } else {
      // Fallback: what was issued to the whole plan (plan-level precision).
      const issueEntries = await prisma.inventoryTransaction.findMany({
        where: {
          referenceType: 'PLAN_ISSUE',
          referenceId: plan.id,
          eventType: 'PROD_CONSUMPTION',
        },
        select: { materialId: true, batchLotId: true, quantity: true },
      });
      ingredients = await buildIngredients(
        bomIngredients,
        issueEntries.map((e) => ({
          materialId: e.materialId,
          batchLotId: e.batchLotId,
          quantity: Number(e.quantity),
        })),
        'PLAN_ISSUE'
      );
    }
  }

  const downstream = await buildDownstream(batch.id);

  return {
    batch: {
      id: batch.id,
      batchNumber: batch.batchNumber,
      status: batch.status,
      manufacturingDate: batch.manufacturingDate,
      expiryDate: batch.expiryDate,
      material: batch.material,
    },
    origin: order
      ? 'PRODUCTION_ORDER'
      : finishing
        ? 'PRODUCTION_PLAN'
        : inbound
          ? 'INBOUND'
          : 'UNKNOWN',
    inbound,
    producedBy,
    stages,
    ingredients,
    downstream,
  };
}
