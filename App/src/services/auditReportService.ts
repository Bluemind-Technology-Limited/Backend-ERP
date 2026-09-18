/**
 * Audit & Report Service
 *
 * Two date-filtered views assembled from the domain tables (not `UserActivity`,
 * whose global middleware no-ops because it runs before `requireAuth`):
 *
 *   1. Production flow — plan -> issue -> grinding -> finishing -> QA, with
 *      ledger movements, remainders and target-vs-achieved variance.
 *   2. ERP activity — a unified feed of stock movements, production stages, QA
 *      checks/inspections, quantity adjustments, GRNs and consignments.
 */
import { prisma } from '../lib/db.js';

const round = (n: number) => Math.round(n * 10000) / 10000;
const avgPct = (values: Array<number | null>) => {
  const nums = values.filter((v): v is number => v !== null);
  return nums.length ? Math.round((nums.reduce((s, v) => s + v, 0) / nums.length) * 100) / 100 : null;
};

function dateRange(dateFrom?: string, dateTo?: string) {
  if (!dateFrom && !dateTo) return undefined;
  const range: any = {};
  if (dateFrom) range.gte = new Date(dateFrom);
  if (dateTo) {
    const end = new Date(dateTo);
    end.setHours(23, 59, 59, 999);
    range.lte = end;
  }
  return range;
}

// ---------------------------------------------------------------------------
// Production flow report
// ---------------------------------------------------------------------------

export async function getProductionFlowReport(filters: {
  dateFrom?: string;
  dateTo?: string;
  planId?: string;
  status?: string;
  limit?: number;
}) {
  const range = dateRange(filters.dateFrom, filters.dateTo);
  const where: any = {};
  if (filters.planId) where.id = filters.planId;
  if (filters.status) where.status = filters.status;
  if (range) {
    where.OR = [
      { scheduledFor: range },
      { startedAt: range },
      { completedAt: range },
      { createdAt: range },
    ];
  }

  const plans = await prisma.productionPlan.findMany({
    where,
    include: {
      createdBy: { select: { fullName: true } },
      items: {
        include: {
          bom: {
            include: {
              finishedSku: { select: { name: true, sku: true, unitOfMeasure: true } },
            },
          },
          stageRecords: {
            include: { remainders: true, grindingInputs: true },
            orderBy: { recordedAt: 'asc' },
          },
        },
        orderBy: { sequence: 'asc' },
      },
      aggregatedIngredients: {
        include: { material: { select: { name: true, sku: true, unitOfMeasure: true } } },
      },
    },
    orderBy: { scheduledFor: 'desc' },
    take: Math.min(500, filters.limit ?? 100),
  });

  const planIds = plans.map((p) => p.id);

  const movements = planIds.length
    ? await prisma.inventoryTransaction.findMany({
        where: {
          referenceId: { in: planIds },
          referenceType: { in: ['PLAN_ISSUE', 'PLAN_RETURN', 'PLAN_FINISHING'] },
        },
        include: {
          material: { select: { name: true, sku: true, unitOfMeasure: true } },
          warehouse: { select: { name: true } },
          createdBy: { select: { fullName: true } },
        },
        orderBy: { createdAt: 'asc' },
      })
    : [];

  const movementsByPlan = new Map<string, any[]>();
  for (const m of movements) {
    if (!m.referenceId) continue;
    const list = movementsByPlan.get(m.referenceId) ?? [];
    list.push({
      id: m.id,
      eventType: m.eventType,
      referenceType: m.referenceType,
      quantity: Number(m.quantity),
      unitOfMeasure: m.unitOfMeasure,
      material: m.material?.name ?? null,
      sku: m.material?.sku ?? null,
      warehouse: m.warehouse?.name ?? null,
      batchLotId: m.batchLotId,
      by: m.createdBy?.fullName ?? null,
      createdAt: m.createdAt,
    });
    movementsByPlan.set(m.referenceId, list);
  }

  const itemIds = plans.flatMap((p) => p.items.map((i) => i.id));
  const inspections = itemIds.length
    ? await prisma.inspectionRecord.findMany({
        where: { inspectionType: 'FINISHED_BATCH', referenceId: { in: itemIds } },
        include: {
          batchLot: { select: { batchNumber: true, status: true } },
          material: { select: { name: true, sku: true } },
        },
      })
    : [];
  const inspectionsByItem = new Map<string, any[]>();
  for (const i of inspections) {
    if (!i.referenceId) continue;
    const list = inspectionsByItem.get(i.referenceId) ?? [];
    list.push({
      id: i.id,
      result: i.result,
      batchNumber: i.batchLot?.batchNumber ?? null,
      batchStatus: i.batchLot?.status ?? null,
      inspectedAt: i.inspectedAt,
    });
    inspectionsByItem.set(i.referenceId, list);
  }

  const rows = plans.map((plan) => {
    const items = plan.items.map((item) => {
      const grinding = item.stageRecords.find((r) => r.stage === 'GRINDING') ?? null;
      const finishing = item.stageRecords.find((r) => r.stage === 'FINISHING') ?? null;
      const target = Number(item.targetQuantity);
      const achieved = finishing ? Number(finishing.achievedQuantity) : null;

      return {
        planItemId: item.id,
        productName: item.bom?.finishedSku?.name ?? item.bom?.productName ?? null,
        sku: item.bom?.finishedSku?.sku ?? null,
        unitOfMeasure: item.bom?.finishedSku?.unitOfMeasure ?? null,
        targetQuantity: target,
        grinding: grinding
          ? {
              id: grinding.id,
              input: Number(grinding.inputQuantity),
              achieved: Number(grinding.achievedQuantity),
              remainder: Number(grinding.remainderQuantity),
              batchNumber: grinding.batchNumber,
              status: grinding.status,
              date: grinding.productionDate,
              inputs: grinding.grindingInputs.map((g) => ({
                materialId: g.materialId,
                batchLotId: g.batchLotId,
                quantity: Number(g.quantity),
              })),
              remainders: grinding.remainders.map((r) => ({
                materialId: r.materialId,
                quantity: Number(r.quantity),
                unitOfMeasure: r.unitOfMeasure,
              })),
            }
          : null,
        finishing: finishing
          ? {
              id: finishing.id,
              input: Number(finishing.inputQuantity),
              achieved: Number(finishing.achievedQuantity),
              remainder: Number(finishing.remainderQuantity),
              carryoverUsedQuantity: Number(finishing.carryoverUsedQuantity),
              batchNumber: finishing.batchNumber,
              finishedBatchLotId: finishing.finishedBatchLotId,
              status: finishing.status,
              date: finishing.productionDate,
            }
          : null,
        achievedQuantity: achieved,
        variance: achieved !== null ? round(achieved - target) : null,
        variancePct:
          achieved !== null && target > 0 ? Math.round(((achieved - target) / target) * 10000) / 100 : null,
        grindingYieldPct:
          grinding && Number(grinding.inputQuantity) > 0
            ? Math.round((Number(grinding.achievedQuantity) / Number(grinding.inputQuantity)) * 10000) / 100
            : null,
        finishingYieldPct:
          finishing && target > 0
            ? Math.round((Number(finishing.achievedQuantity) / target) * 10000) / 100
            : null,
        grindingRemainderPct:
          grinding && Number(grinding.inputQuantity) > 0
            ? Math.round((Number(grinding.remainderQuantity) / Number(grinding.inputQuantity)) * 10000) / 100
            : null,
        finishingRemainderPct:
          finishing && target > 0
            ? Math.round((Number(finishing.remainderQuantity) / target) * 10000) / 100
            : null,
        inspections: inspectionsByItem.get(item.id) ?? [],
      };
    });

    return {
      planId: plan.id,
      planNumber: plan.planNumber,
      description: plan.description,
      status: plan.status,
      scheduledFor: plan.scheduledFor,
      startedAt: plan.startedAt,
      completedAt: plan.completedAt,
      createdBy: plan.createdBy?.fullName ?? null,
      items,
      issue: {
        totalIngredients: plan.aggregatedIngredients.length,
        issuedIngredients: plan.aggregatedIngredients.filter((a) => a.status === 'RELEASED').length,
        ingredients: plan.aggregatedIngredients.map((a) => ({
          material: a.material?.name ?? null,
          sku: a.material?.sku ?? null,
          required: Number(a.totalQuantity),
          issued: Number(a.issuedQuantity ?? 0),
          returned: Number(a.returnedQuantity ?? 0),
          unitOfMeasure: a.unitOfMeasure,
          status: a.status,
          warehouseId: a.issuedWarehouseId,
          batchLotId: a.issuedBatchLotId,
        })),
      },
      movements: movementsByPlan.get(plan.id) ?? [],
    };
  });

  const allItems = rows.flatMap((r) => r.items);
  const summary = {
    plans: rows.length,
    scheduled: rows.filter((r) => r.status === 'SCHEDULED').length,
    inProgress: rows.filter((r) => r.status === 'IN_PROGRESS').length,
    completed: rows.filter((r) => r.status === 'COMPLETED').length,
    batches: allItems.length,
    totalTarget: round(allItems.reduce((s, i) => s + i.targetQuantity, 0)),
    totalAchieved: round(allItems.reduce((s, i) => s + (i.achievedQuantity ?? 0), 0)),
    totalIssued: round(
      rows.reduce((s, r) => s + r.issue.ingredients.reduce((a, i) => a + i.issued, 0), 0)
    ),
    totalReturned: round(
      rows.reduce((s, r) => s + r.issue.ingredients.reduce((a, i) => a + i.returned, 0), 0)
    ),
    grindingRemainder: round(
      allItems.reduce((s, i) => s + (i.grinding?.remainder ?? 0), 0)
    ),
    avgGrindingYieldPct: avgPct(allItems.map((i) => i.grindingYieldPct)),
    avgFinishingYieldPct: avgPct(allItems.map((i) => i.finishingYieldPct)),
  };

  return { rows, summary };
}

// ---------------------------------------------------------------------------
// ERP activity report
// ---------------------------------------------------------------------------

type FeedRow = {
  id: string;
  type: string;
  module: string;
  description: string;
  detail: string;
  actor: string | null;
  amount: number | null;
  timestamp: Date;
  referenceType: string | null;
  referenceId: string | null;
};

export async function getErpActivityReport(filters: {
  dateFrom?: string;
  dateTo?: string;
  entity?: string;
  userId?: string;
  limit?: number;
}) {
  const range = dateRange(filters.dateFrom, filters.dateTo);
  const take = Math.min(1000, filters.limit ?? 300);
  const userId = filters.userId;

  const [txns, stages, checks, inspections, adjustments, grns, consignments] = await Promise.all([
    prisma.inventoryTransaction.findMany({
      where: { ...(range ? { createdAt: range } : {}), ...(userId ? { createdById: userId } : {}) },
      include: {
        material: { select: { name: true, sku: true } },
        warehouse: { select: { name: true } },
        createdBy: { select: { fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take,
    }),
    prisma.productionStageRecord.findMany({
      where: { ...(range ? { recordedAt: range } : {}), ...(userId ? { recordedById: userId } : {}) },
      include: { planItem: { select: { productionPlan: { select: { planNumber: true } } } } },
      orderBy: { recordedAt: 'desc' },
      take,
    }),
    prisma.qualityCheckItem.findMany({
      where: { ...(range ? { checkedAt: range } : {}), ...(userId ? { checkedById: userId } : {}) },
      include: {
        consignmentItem: {
          include: {
            material: { select: { name: true, sku: true } },
            consignment: { select: { consignmentNumber: true } },
          },
        },
        checkedBy: { select: { fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take,
    }),
    prisma.inspectionRecord.findMany({
      where: { ...(range ? { createdAt: range } : {}), ...(userId ? { inspectedById: userId } : {}) },
      include: {
        material: { select: { name: true, sku: true } },
        batchLot: { select: { batchNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
      take,
    }),
    prisma.quantityAdjustment.findMany({
      where: { ...(range ? { requestedAt: range } : {}), ...(userId ? { requestedById: userId } : {}) },
      include: {
        material: { select: { name: true, sku: true } },
        requestedBy: { select: { fullName: true } },
        consignment: { select: { consignmentNumber: true } },
      },
      orderBy: { requestedAt: 'desc' },
      take,
    }),
    prisma.goodsReceipt.findMany({
      where: { ...(range ? { receivedAt: range } : {}), ...(userId ? { receivedById: userId } : {}) },
      include: {
        receivedBy: { select: { fullName: true } },
        po: { select: { number: true } },
        consignment: { select: { consignmentNumber: true } },
      },
      orderBy: { receivedAt: 'desc' },
      take,
    }),
    prisma.consignment.findMany({
      where: { ...(range ? { createdAt: range } : {}) },
      include: { supplier: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take,
    }),
  ]);

  const feed: FeedRow[] = [
    ...txns.map((t) => ({
      id: t.id,
      type: 'STOCK_MOVEMENT',
      module: 'inventory',
      description: `${t.eventType} · ${Number(t.quantity)} ${t.unitOfMeasure} ${t.material?.name ?? ''}`.trim(),
      detail: [t.warehouse?.name, t.referenceType].filter(Boolean).join(' · '),
      actor: t.createdBy?.fullName ?? null,
      amount: Number(t.quantity),
      timestamp: t.createdAt,
      referenceType: t.referenceType,
      referenceId: t.referenceId,
    })),
    ...stages.map((s) => ({
      id: s.id,
      type: `STAGE_${s.stage}`,
      module: 'production',
      description: `${s.stage} · plan ${s.planItem?.productionPlan?.planNumber ?? ''}`.trim(),
      detail: `in ${Number(s.inputQuantity)} · out ${Number(s.achievedQuantity)} · remainder ${Number(s.remainderQuantity)}`,
      actor: null,
      amount: Number(s.achievedQuantity),
      timestamp: s.recordedAt,
      referenceType: 'PRODUCTION_PLAN',
      referenceId: s.productionPlanId,
    })),
    ...checks.map((c) => ({
      id: c.id,
      type: 'QA_CHECK',
      module: 'qa',
      description: `${c.checkType} · ${c.result ?? 'PENDING'} · ${c.consignmentItem?.material?.name ?? ''}`.trim(),
      detail: `consignment ${c.consignmentItem?.consignment?.consignmentNumber ?? ''}`.trim(),
      actor: c.checkedBy?.fullName ?? null,
      amount: null,
      timestamp: c.checkedAt ?? c.createdAt,
      referenceType: 'CONSIGNMENT',
      referenceId: c.consignmentItem?.consignmentId ?? null,
    })),
    ...inspections.map((i) => ({
      id: i.id,
      type: 'QA_INSPECTION',
      module: 'qa',
      description: `${i.inspectionType} · ${i.result} · ${i.material?.name ?? ''}`.trim(),
      detail: `batch ${i.batchLot?.batchNumber ?? ''}`.trim(),
      actor: null,
      amount: null,
      timestamp: i.inspectedAt ?? i.createdAt,
      referenceType: i.inspectionType,
      referenceId: i.referenceId,
    })),
    ...adjustments.map((a) => ({
      id: a.id,
      type: 'QUANTITY_ADJUSTMENT',
      module: 'qa',
      description: `${a.status} qty ${Number(a.oldQuantity)} → ${Number(a.newQuantity)} · ${a.material?.name ?? ''}`.trim(),
      detail: a.consignment?.consignmentNumber ? `consignment ${a.consignment.consignmentNumber}` : '',
      actor: a.requestedBy?.fullName ?? null,
      amount: Number(a.difference),
      timestamp: a.requestedAt,
      referenceType: 'QUANTITY_ADJUSTMENT',
      referenceId: a.id,
    })),
    ...grns.map((g) => ({
      id: g.id,
      type: 'GOODS_RECEIPT',
      module: 'inventory',
      description: `GRN ${g.number} · ${g.status}`,
      detail: g.po?.number
        ? `PO ${g.po.number}`
        : g.consignment?.consignmentNumber
          ? `Consignment ${g.consignment.consignmentNumber}`
          : '',
      actor: g.receivedBy?.fullName ?? null,
      amount: null,
      timestamp: g.receivedAt,
      referenceType: 'GRN',
      referenceId: g.id,
    })),
    ...consignments.map((c) => ({
      id: c.id,
      type: 'CONSIGNMENT',
      module: 'procurement',
      description: `Consignment ${c.consignmentNumber} · ${c.status}`,
      detail: c.supplier?.name ?? '',
      actor: null,
      amount: null,
      timestamp: c.createdAt,
      referenceType: 'CONSIGNMENT',
      referenceId: c.id,
    })),
  ];

  const filtered = filters.entity
    ? feed.filter((f) => f.module === filters.entity || f.type === filters.entity)
    : feed;
  filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const byModule: Record<string, number> = {};
  for (const f of filtered) byModule[f.module] = (byModule[f.module] ?? 0) + 1;

  return {
    rows: filtered,
    summary: { total: filtered.length, byModule },
  };
}
