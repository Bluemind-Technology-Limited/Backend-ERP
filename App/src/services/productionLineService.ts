/**
 * Production Line Service
 *
 * The three hand-off stations behind a production plan:
 *
 *   1. STOCK MANAGER (STORE_OFFICER) — sees the plan's aggregated ingredient
 *      list, picks a warehouse and deducts the required quantities.
 *   2. GRINDING SUPERVISOR — receives the plan's batches, records the actual
 *      ground output for the day and returns any unused input ingredients.
 *   3. PRODUCTION SUPERVISOR — receives the required finished-goods output,
 *      records what was achieved and reports unused batches.
 *
 * Remainders are captured per material and posted back to stock as a positive
 * ledger entry, so the store balance always matches reality.
 */
import { prisma } from '../lib/db.js';
import { LedgerEventType } from '@prisma/client';
import { postLedgerEntry } from '../lib/ledger.js';
import { logActivity } from './userActivityLogger.js';

const ISSUABLE_PLAN_STATUSES = ['SCHEDULED', 'IN_PROGRESS'];
const ACTIVE_PLAN_STATUSES = ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED'];

/**
 * WIP carryover pool per BOM: unused ground output from prior finishing records,
 * minus whatever later batches already drew on. Purely computed — no ledger.
 */
async function computeCarryoverByBom(bomIds: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(bomIds.filter(Boolean))];
  const map = new Map<string, number>();
  if (unique.length === 0) return map;

  const records = await prisma.productionStageRecord.findMany({
    where: { stage: 'FINISHING', planItem: { bomId: { in: unique } } },
    select: {
      remainderQuantity: true,
      carryoverUsedQuantity: true,
      planItem: { select: { bomId: true } },
    },
  });

  for (const r of records) {
    const bomId = r.planItem?.bomId;
    if (!bomId) continue;
    map.set(
      bomId,
      (map.get(bomId) ?? 0) + Number(r.remainderQuantity) - Number(r.carryoverUsedQuantity)
    );
  }
  for (const [k, v] of [...map.entries()]) map.set(k, Math.max(0, v));
  return map;
}

// ---------------------------------------------------------------------------
// Serialization / progress
// ---------------------------------------------------------------------------

function summarize(plan: any) {
  const items: any[] = plan.items ?? [];
  const aggs: any[] = plan.aggregatedIngredients ?? [];

  const grindingDone = items.filter((i) => i.stageRecords?.some((r: any) => r.stage === 'GRINDING')).length;
  const finishingDone = items.filter((i) => i.stageRecords?.some((r: any) => r.stage === 'FINISHING')).length;
  const issuedIngredients = aggs.filter((a) => a.status === 'RELEASED').length;

  return {
    issue: {
      totalIngredients: aggs.length,
      issuedIngredients,
      complete: aggs.length > 0 && issuedIngredients === aggs.length,
    },
    grinding: {
      totalItems: items.length,
      done: grindingDone,
      complete: items.length > 0 && grindingDone === items.length,
    },
    finishing: {
      totalItems: items.length,
      done: finishingDone,
      complete: items.length > 0 && finishingDone === items.length,
    },
  };
}

/** Per-item view: how much was ground (available to finish) and what was output. */
function enrichItems(plan: any, carryover?: Map<string, number>) {
  const items: any[] = plan.items ?? [];
  return items.map((item) => {
    const stageRecords: any[] = item.stageRecords ?? [];
    const grinding = stageRecords.filter((r) => r.stage === 'GRINDING');
    const finishing = stageRecords.filter((r) => r.stage === 'FINISHING');
    return {
      ...item,
      grindingRecord: grinding[0] ?? null,
      finishingRecord: finishing[0] ?? null,
      groundQuantity: grinding.reduce((sum, r) => sum + Number(r.achievedQuantity), 0),
      achievedQuantity: finishing.reduce((sum, r) => sum + Number(r.achievedQuantity), 0),
      // Unfinished output from earlier batches of this product.
      carryoverAvailable: carryover?.get(item.bomId) ?? 0,
    };
  });
}

function serializePlan(plan: any, carryover?: Map<string, number>) {
  return {
    id: plan.id,
    planNumber: plan.planNumber,
    description: plan.description,
    status: plan.status,
    scheduledFor: plan.scheduledFor,
    startedAt: plan.startedAt,
    completedAt: plan.completedAt,
    createdBy: plan.createdBy ?? null,
    items: enrichItems(plan, carryover),
    aggregatedIngredients: plan.aggregatedIngredients ?? [],
    progress: summarize(plan),
  };
}

const PLAN_INCLUDE = {
  createdBy: { select: { id: true, fullName: true } },
  items: {
    include: {
      bom: {
        include: {
          finishedSku: { select: { id: true, name: true, sku: true, unitOfMeasure: true } },
        },
      },
      stageRecords: { include: { remainders: true }, orderBy: { recordedAt: 'desc' as const } },
    },
    orderBy: { sequence: 'asc' as const },
  },
  aggregatedIngredients: {
    include: { material: { select: { id: true, name: true, sku: true, unitOfMeasure: true } } },
    orderBy: { materialId: 'asc' as const },
  },
} as const;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export async function getProductionLinePlans(filters?: { status?: string }) {
  const plans = await prisma.productionPlan.findMany({
    where: filters?.status
      ? { status: filters.status as never }
      : { status: { in: ACTIVE_PLAN_STATUSES as never } },
    include: PLAN_INCLUDE,
    orderBy: { scheduledFor: 'desc' },
  });
  const carryover = await computeCarryoverByBom(plans.flatMap((p) => p.items.map((i) => i.bomId)));
  return plans.map((plan) => serializePlan(plan, carryover));
}

export async function getPlanStationView(planId: string) {
  const plan = await prisma.productionPlan.findUnique({
    where: { id: planId },
    include: PLAN_INCLUDE,
  });
  if (!plan) throw new Error('Production plan not found');
  const carryover = await computeCarryoverByBom(plan.items.map((i) => i.bomId));
  return serializePlan(plan, carryover);
}

/**
 * Work queues per station:
 *  ISSUE     — active plans with ingredients not yet issued
 *  GRINDING  — in-progress plans with items not yet ground
 *  FINISHING — items ground but not yet finished
 */
export async function getStationQueue(station: 'ISSUE' | 'GRINDING' | 'FINISHING') {
  const plans = await getProductionLinePlans();
  return plans.filter((plan) => {
    if (station === 'ISSUE') {
      return (
        ISSUABLE_PLAN_STATUSES.includes(plan.status) &&
        plan.aggregatedIngredients.some((a: any) => a.status !== 'RELEASED')
      );
    }
    if (station === 'GRINDING') {
      return plan.status === 'IN_PROGRESS' && plan.items.some((i: any) => !i.grindingRecord);
    }
    return plan.items.some((i: any) => i.grindingRecord && !i.finishingRecord);
  });
}

// ---------------------------------------------------------------------------
// Notifications — one per station when work is planned or issued
// ---------------------------------------------------------------------------

const STATION_ROLES = [
  'STORE_OFFICER',
  'GRINDING_SUPERVISOR',
  'PRODUCTION_MANAGER',
  'PRODUCTION_SUPERVISOR',
] as const;

/**
 * Notify the ingredient, grinding and production stations that work exists.
 * One notification row per active user in those roles; it also renders on each
 * station page because the page lists the same plan queue.
 */
export async function notifyStations(input: {
  planId: string;
  planNumber: string;
  title: string;
  body: string;
}) {
  const users = await prisma.user.findMany({
    where: { role: { in: STATION_ROLES as unknown as any[] }, isActive: true },
    select: { id: true },
  });
  if (users.length === 0) return;

  await prisma.notification.createMany({
    data: users.map((u) => ({
      userId: u.id,
      title: input.title,
      body: input.body,
      type: 'SYSTEM',
      notificationType: 'SYSTEM',
      referenceId: input.planId,
      isActionable: true,
    })),
    skipDuplicates: false,
  });
}

// ---------------------------------------------------------------------------
// Daily records — expected vs achieved per day, with WIP carry-over
// ---------------------------------------------------------------------------

export interface DailyRecordDay {
  date: string;
  complete: boolean;
  achieved: {
    outputQty: number;
    outputValue: number;
    grindingQty: number;
    lines: Array<{
      id: string;
      stage: 'GRINDING' | 'FINISHING';
      planNumber: string;
      product: string;
      expected: number;
      achieved: number;
      unit: string;
      value: number;
    }>;
    materials: Array<{
      materialId: string;
      name: string;
      sku: string;
      unit: string;
      quantity: number;
      lots: Array<{ batchNumber: string; quantity: number }>;
    }>;
    ingredients: Array<{
      materialId: string;
      name: string;
      sku: string;
      unit: string;
      quantity: number;
      value: number;
      lots: Array<{ batchNumber: string; quantity: number }>;
    }>;
  };
  wip: {
    quantity: number;
    value: number;
    lines: Array<{
      arm: 'INGREDIENTS' | 'GRINDING' | 'PRODUCTION';
      materialId: string | null;
      name: string;
      unit: string;
      quantity: number;
      value: number;
      lots: Array<{ batchNumber: string; quantity: number }>;
    }>;
  };
}

const dayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/**
 * Daily production records.
 *
 * Groups stage records by production date and returns, for each day:
 *  - achieved: what each arm actually did (with the per-receipt breakdown),
 *  - wip: what is left over and rolls to the next day,
 *  - complete: nothing left over for the day.
 */
export async function getDailyRecords(filters?: { from?: string; to?: string }) {
  const to = filters?.to ? new Date(filters.to) : new Date();
  to.setHours(23, 59, 59, 999);
  const from = filters?.from ? new Date(filters.from) : new Date(to.getTime() - 29 * 24 * 60 * 60 * 1000);
  from.setHours(0, 0, 0, 0);

  const [stageRecords, issueLines] = await Promise.all([
    prisma.productionStageRecord.findMany({
      where: { productionDate: { gte: from, lte: to } },
      include: {
        productionPlan: { select: { id: true, planNumber: true } },
        planItem: {
          select: {
            targetQuantity: true,
            bom: {
              select: {
                productName: true,
                finishedSku: { select: { name: true, unitOfMeasure: true } },
              },
            },
          },
        },
        remainders: true,
        grindingInputs: {
          include: {
            material: { select: { id: true, name: true, sku: true, unitOfMeasure: true, standardCost: true } },
            batchLot: { select: { batchNumber: true } },
          },
        },
      },
      orderBy: { productionDate: 'asc' },
    }),
    prisma.planIngredientIssue.findMany({
      where: { issuedAt: { gte: from, lte: to } },
      include: {
        material: { select: { id: true, name: true, sku: true, unitOfMeasure: true } },
      },
      orderBy: { issuedAt: 'asc' },
    }),
  ]);

  // Materials / lots referenced by remainder rows (they are scalar ids).
  const remainderMaterialIds = [...new Set(stageRecords.flatMap((r) => r.remainders.map((x) => x.materialId)))];
  const remainderLotIds = [
    ...new Set(stageRecords.flatMap((r) => r.remainders.map((x) => x.batchLotId).filter(Boolean))),
  ] as string[];

  const [remainderMaterials, remainderLots] = await Promise.all([
    remainderMaterialIds.length
      ? prisma.material.findMany({
          where: { id: { in: remainderMaterialIds } },
          select: { id: true, name: true, sku: true, unitOfMeasure: true, standardCost: true },
        })
      : Promise.resolve([]),
    remainderLotIds.length
      ? prisma.batchLot.findMany({ where: { id: { in: remainderLotIds } }, select: { id: true, batchNumber: true } })
      : Promise.resolve([]),
  ]);
  const materialMap = new Map(remainderMaterials.map((m) => [m.id, m]));
  const lotMap = new Map(remainderLots.map((l) => [l.id, l.batchNumber]));

  const days = new Map<string, DailyRecordDay>();
  const day = (date: Date) => {
    const key = dayKey(date);
    let entry = days.get(key);
    if (!entry) {
      entry = {
        date: key,
        complete: true,
        achieved: { outputQty: 0, outputValue: 0, grindingQty: 0, lines: [], materials: [], ingredients: [] },
        wip: { quantity: 0, value: 0, lines: [] },
      };
      days.set(key, entry);
    }
    return entry;
  };

  for (const record of stageRecords) {
    const entry = day(new Date(record.productionDate));
    const product = record.planItem?.bom?.finishedSku?.name ?? record.planItem?.bom?.productName ?? '—';
    const expected = Number(record.inputQuantity);
    const achieved = Number(record.achievedQuantity);
    const value = achieved * Number(record.unitCost ?? 0);

    entry.achieved.lines.push({
      id: record.id,
      stage: record.stage as 'GRINDING' | 'FINISHING',
      planNumber: record.productionPlan?.planNumber ?? '—',
      product,
      expected,
      achieved,
      unit: record.unitOfMeasure,
      value,
    });

    if (record.stage === 'FINISHING') {
      entry.achieved.outputQty += achieved;
      entry.achieved.outputValue += value;
    } else {
      entry.achieved.grindingQty += achieved;
    }

    // Grinding inputs: the "Turmeric 200 kg (20 kg × 10 receipts)" breakdown.
    for (const input of record.grindingInputs) {
      const existing = entry.achieved.materials.find((m) => m.materialId === input.materialId);
      const lot = {
        batchNumber: input.batchLot?.batchNumber ?? '—',
        quantity: Number(input.quantity),
      };
      if (existing) {
        existing.quantity += lot.quantity;
        existing.lots.push(lot);
      } else {
        entry.achieved.materials.push({
          materialId: input.materialId,
          name: input.material.name,
          sku: input.material.sku,
          unit: input.unitOfMeasure,
          quantity: lot.quantity,
          lots: [lot],
        });
      }
    }

    // Remainders become WIP for the next day.
    for (const remainder of record.remainders) {
      const material = materialMap.get(remainder.materialId);
      const unitCost = Number(material?.standardCost ?? 0);
      const quantity = Number(remainder.quantity);
      entry.wip.lines.push({
        arm: record.stage === 'FINISHING' ? 'PRODUCTION' : 'GRINDING',
        materialId: remainder.materialId,
        name: material?.name ?? 'Material',
        unit: remainder.unitOfMeasure,
        quantity,
        value: quantity * unitCost,
        lots: [
          {
            batchNumber: remainder.batchLotId ? lotMap.get(remainder.batchLotId) ?? '—' : '—',
            quantity,
          },
        ],
      });
    }

    // A finishing record with a remainder keeps the product itself in WIP.
    if (record.stage === 'FINISHING' && Number(record.remainderQuantity) > 0 && record.remainders.length === 0) {
      const quantity = Number(record.remainderQuantity);
      entry.wip.lines.push({
        arm: 'PRODUCTION',
        materialId: null,
        name: product,
        unit: record.unitOfMeasure,
        quantity,
        value: quantity * Number(record.unitCost ?? 0),
        lots: [{ batchNumber: record.batchNumber ?? '—', quantity }],
      });
    }

    if (record.remainders.length > 0 || Number(record.remainderQuantity) > 0) {
      entry.complete = false;
    }
  }

  for (const issue of issueLines) {
    const entry = day(new Date(issue.issuedAt));
    const quantity = Number(issue.quantity);
    const value = quantity * Number(issue.unitCost ?? 0);
    const existing = entry.achieved.ingredients.find((i) => i.materialId === issue.materialId);
    const lot = { batchNumber: '—', quantity };

    if (existing) {
      existing.quantity += quantity;
      existing.value += value;
      existing.lots.push(lot);
    } else {
      entry.achieved.ingredients.push({
        materialId: issue.materialId,
        name: issue.material.name,
        sku: issue.material.sku,
        unit: issue.unitOfMeasure,
        quantity,
        value,
        lots: [lot],
      });
    }
  }

  const result = [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
  for (const entry of result) {
    entry.wip.quantity = entry.wip.lines.reduce((sum, l) => sum + l.quantity, 0);
    entry.wip.value = entry.wip.lines.reduce((sum, l) => sum + l.value, 0);
    if (entry.wip.quantity > 0) entry.complete = false;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Station 1 — Stock Manager issues ingredients
// ---------------------------------------------------------------------------

export async function issuePlanIngredients(data: {
  planId: string;
  warehouseId: string;
  lines: Array<{ aggregatedIngredientId: string; quantity: number; batchLotId?: string | null }>;
  issuedById: string;
}) {
  if (!data.warehouseId) throw new Error('A warehouse must be selected');
  if (!data.lines?.length) throw new Error('At least one ingredient line is required');

  const plan = await prisma.productionPlan.findUnique({
    where: { id: data.planId },
    include: { aggregatedIngredients: true, items: { select: { id: true } } },
  });
  if (!plan) throw new Error('Production plan not found');

  if (!ISSUABLE_PLAN_STATUSES.includes(plan.status)) {
    throw new Error(
      `Ingredients can only be issued for SCHEDULED or IN_PROGRESS plans (current: ${plan.status})`
    );
  }

  // Guard: if a production order allocated to this plan already released its
  // ingredients, issuing here would deduct the same stock twice.
  const allocations = await prisma.batchMachineAllocation.findMany({
    where: { productionPlanItemId: { in: plan.items.map((i) => i.id) } },
    select: { productionOrderId: true },
  });
  const orderIds = [...new Set(allocations.map((a) => a.productionOrderId))];
  if (orderIds.length > 0) {
    const consumed = await prisma.inventoryTransaction.count({
      where: {
        referenceType: 'PROD_ORDER',
        referenceId: { in: orderIds },
        eventType: 'PROD_CONSUMPTION',
      },
    });
    if (consumed > 0) {
      throw new Error(
        'Ingredients were already released for a production order in this plan. Use either the production line or the order release — not both.'
      );
    }
  }

  // Unit costs are captured at issue time so ingredient value stays historical.
  const costRows = await prisma.material.findMany({
    where: { id: { in: [...new Set(plan.aggregatedIngredients.map((a) => a.materialId))] } },
    select: { id: true, standardCost: true },
  });
  const costByMaterial = new Map(costRows.map((m) => [m.id, Number(m.standardCost ?? 0)]));

  await prisma.$transaction(async (tx) => {
    for (const line of data.lines) {
      const agg = plan.aggregatedIngredients.find((a) => a.id === line.aggregatedIngredientId);
      if (!agg) throw new Error('Aggregated ingredient does not belong to this plan');

      const quantity = Number(line.quantity);
      if (!(quantity > 0)) throw new Error('Issued quantity must be greater than zero');

      await postLedgerEntry(tx, {
        eventType: LedgerEventType.PROD_CONSUMPTION,
        materialId: agg.materialId,
        batchLotId: line.batchLotId ?? null,
        warehouseId: data.warehouseId,
        quantity: -quantity,
        unitOfMeasure: agg.unitOfMeasure,
        referenceType: 'PLAN_ISSUE',
        referenceId: plan.id,
        createdById: data.issuedById,
        notes: `Issued to production plan ${plan.planNumber}`,
      });

      // One line per issue: material + receipt lot + qty + snapshot cost.
      await tx.planIngredientIssue.create({
        data: {
          productionPlanId: plan.id,
          aggregatedIngredientId: agg.id,
          materialId: agg.materialId,
          batchLotId: line.batchLotId ?? null,
          quantity,
          unitOfMeasure: agg.unitOfMeasure,
          unitCost: costByMaterial.get(agg.materialId) ?? 0,
          warehouseId: data.warehouseId,
          issuedById: data.issuedById,
        },
      });

      await tx.planAggregatedIngredient.update({
        where: { id: agg.id },
        data: {
          issuedQuantity: Number(agg.issuedQuantity ?? 0) + quantity,
          issuedWarehouseId: data.warehouseId,
          issuedBatchLotId: line.batchLotId ?? null,
          issuedAt: new Date(),
          issuedById: data.issuedById,
          status: 'RELEASED',
        },
      });
    }

    if (plan.status === 'SCHEDULED') {
      await tx.productionPlan.update({
        where: { id: plan.id },
        data: { status: 'IN_PROGRESS', startedAt: new Date() },
      });
    }
  });

  await logActivity({
    userId: data.issuedById,
    activityType: 'TRANSFER',
    module: 'production',
    description: `Issued ${data.lines.length} ingredient line(s) for plan ${plan.planNumber}`,
    entityType: 'ProductionPlan',
    entityId: plan.id,
  });

  // Grinding and production stations now have work waiting.
  await notifyStations({
    planId: plan.id,
    planNumber: plan.planNumber,
    title: `Ingredients issued — ${plan.planNumber}`,
    body: `Ingredients for ${plan.planNumber} have been issued. Grinding can start.`,
  }).catch((error) => console.error('notifyStations (issue) failed:', error));

  return getPlanStationView(plan.id);
}

// ---------------------------------------------------------------------------
// Station 2 — Grinding supervisor records throughput + input remainders
// ---------------------------------------------------------------------------

export async function submitGrindingRecord(data: {
  planId: string;
  planItemId: string;
  inputQuantity: number;
  achievedQuantity: number;
  remainderQuantity?: number;
  remainders?: Array<{ materialId: string; quantity: number; batchLotId?: string | null; warehouseId?: string | null }>;
  inputs?: Array<{ materialId: string; quantity: number; batchLotId?: string | null }>;
  machineId?: string | null;
  batchNumber?: string | null;
  productionDate?: string;
  unitOfMeasure?: string;
  remarks?: string;
  recordedById: string;
}) {
  const item = await prisma.productionPlanItem.findUnique({
    where: { id: data.planItemId },
    include: { bom: { select: { productName: true } }, productionPlan: { select: { id: true, planNumber: true } } },
  });
  if (!item) throw new Error('Plan item not found');
  if (item.productionPlanId !== data.planId) throw new Error('Plan item does not belong to this plan');

  const input = Number(data.inputQuantity);
  const achieved = Number(data.achievedQuantity);
  const remainders = (data.remainders ?? []).filter((r) => Number(r.quantity) > 0);

  if (!(input >= 0) || !(achieved >= 0)) throw new Error('Quantities must be zero or greater');
  if (achieved > input) throw new Error('Achieved quantity cannot exceed the input quantity');

  const plan = await prisma.productionPlan.findUnique({
    where: { id: data.planId },
    include: { aggregatedIngredients: true },
  });
  if (!plan) throw new Error('Production plan not found');

  const aggregatedByMaterial = new Map(plan.aggregatedIngredients.map((a) => [a.materialId, a]));
  for (const r of remainders) {
    if (!aggregatedByMaterial.has(r.materialId)) {
      throw new Error('Remainder material is not part of this plan');
    }
  }

  const remainderTotal = remainders.length
    ? remainders.reduce((sum, r) => sum + Number(r.quantity), 0)
    : Number(data.remainderQuantity ?? 0);

  const record = await prisma.$transaction(async (tx) => {
    const created = await tx.productionStageRecord.create({
      data: {
        productionPlanId: data.planId,
        planItemId: data.planItemId,
        stage: 'GRINDING',
        inputQuantity: input,
        achievedQuantity: achieved,
        remainderQuantity: remainderTotal,
        unitOfMeasure: data.unitOfMeasure ?? 'kg',
        machineId: data.machineId ?? null,
        batchNumber: data.batchNumber ?? null,
        productionDate: data.productionDate ? new Date(data.productionDate) : new Date(),
        remarks: data.remarks,
        recordedById: data.recordedById,
      },
    });

    let firstTransactionId: string | null = null;

    // Record the exact batch lots ground for this batch (traceability lineage).
    const inputLines = (data.inputs ?? []).filter((line) => Number(line.quantity) > 0);
    for (const line of inputLines) {
      const agg = aggregatedByMaterial.get(line.materialId);
      if (!agg) throw new Error('Grinding input material is not part of this plan');
      await tx.productionGrindingInput.create({
        data: {
          stageRecordId: created.id,
          materialId: line.materialId,
          batchLotId: line.batchLotId ?? null,
          quantity: Number(line.quantity),
          unitOfMeasure: agg.unitOfMeasure,
        },
      });
    }

    // Return unused input ingredients to the store (per material).
    for (const r of remainders) {
      const agg = aggregatedByMaterial.get(r.materialId)!;
      const warehouseId = r.warehouseId ?? agg.issuedWarehouseId ?? plan.aggregatedIngredients[0]?.issuedWarehouseId;
      if (!warehouseId) {
        throw new Error('A warehouse is required to return unused material to stock');
      }

      const entry = await postLedgerEntry(tx, {
        eventType: LedgerEventType.ADJUSTMENT,
        materialId: r.materialId,
        batchLotId: r.batchLotId ?? agg.issuedBatchLotId ?? null,
        warehouseId,
        quantity: Number(r.quantity),
        unitOfMeasure: agg.unitOfMeasure,
        referenceType: 'PLAN_RETURN',
        referenceId: plan.id,
        createdById: data.recordedById,
        notes: `Grinding remainder returned from plan ${plan.planNumber}`,
      });
      if (!firstTransactionId) firstTransactionId = entry.id;

      await tx.productionStageRemainder.create({
        data: {
          stageRecordId: created.id,
          materialId: r.materialId,
          quantity: Number(r.quantity),
          unitOfMeasure: agg.unitOfMeasure,
          warehouseId,
          batchLotId: r.batchLotId ?? agg.issuedBatchLotId ?? null,
          inventoryTransactionId: entry.id,
        },
      });

      await tx.planAggregatedIngredient.update({
        where: { id: agg.id },
        data: { returnedQuantity: Number(agg.returnedQuantity ?? 0) + Number(r.quantity) },
      });
    }

    if (firstTransactionId) {
      await tx.productionStageRecord.update({
        where: { id: created.id },
        data: { returnedTransactionId: firstTransactionId },
      });
    }

    return created;
  });

  await logActivity({
    userId: data.recordedById,
    activityType: 'CREATE',
    module: 'production',
    description: `Grinding recorded for plan ${plan.planNumber}: input ${input}, output ${achieved}, remainder ${remainderTotal}`,
    entityType: 'ProductionStageRecord',
    entityId: record.id,
  });

  return getPlanStationView(plan.id);
}

// ---------------------------------------------------------------------------
// Station 3 — Production supervisor records finished output
// ---------------------------------------------------------------------------

export async function submitFinishingRecord(data: {
  planId: string;
  planItemId: string;
  achievedQuantity: number;
  remainderQuantity?: number;
  carryoverUsedQuantity?: number;
  warehouseId: string;
  batchNumber: string;
  expiryDate?: string;
  productionDate?: string;
  unitOfMeasure?: string;
  remarks?: string;
  recordedById: string;
}) {
  if (!data.warehouseId) throw new Error('A receiving warehouse is required');
  if (!data.batchNumber) throw new Error('A finished batch number is required');

  const item = await prisma.productionPlanItem.findUnique({
    where: { id: data.planItemId },
    include: {
      bom: {
        include: { finishedSku: { select: { id: true, name: true, unitOfMeasure: true, standardCost: true } } },
      },
      productionPlan: { select: { id: true, planNumber: true } },
    },
  });
  if (!item) throw new Error('Plan item not found');
  if (item.productionPlanId !== data.planId) throw new Error('Plan item does not belong to this plan');

  const finishedSku = item.bom?.finishedSku;
  if (!finishedSku) throw new Error('This plan item\'s BOM has no finished SKU configured');

  const achieved = Number(data.achievedQuantity);
  if (!(achieved >= 0)) throw new Error('Achieved quantity must be zero or greater');

  const required = Number(item.targetQuantity);
  const planId = item.productionPlanId;

  // WIP carryover: how much unused ground output from earlier batches this one draws on.
  const carryoverUsed = Number(data.carryoverUsedQuantity ?? 0);
  if (carryoverUsed < 0) throw new Error('Carryover used cannot be negative');
  const carryoverAvailable = (await computeCarryoverByBom([item.bomId])).get(item.bomId) ?? 0;
  if (carryoverUsed > carryoverAvailable + 0.0001) {
    throw new Error(
      `Only ${carryoverAvailable} unfinished quantity is available from previous batches`
    );
  }

  const record = await prisma.$transaction(async (tx) => {
    let finishedBatchLotId: string | null = null;

    if (achieved > 0) {
      const batchLot = await tx.batchLot.upsert({
        where: { materialId_batchNumber: { materialId: finishedSku.id, batchNumber: data.batchNumber } },
        update: {},
        create: {
          materialId: finishedSku.id,
          batchNumber: data.batchNumber,
          status: 'QUARANTINE',
          // The date the supervisor recorded the batch, so the finished lot
          // carries its own production date in every list and trace.
          manufacturingDate: data.productionDate ? new Date(data.productionDate) : new Date(),
          expiryDate: data.expiryDate ? new Date(data.expiryDate) : null,
          // Finished production batch — batch number comes from the station.
          origin: 'FINISHED',
        },
      });
      finishedBatchLotId = batchLot.id;

      await postLedgerEntry(tx, {
        eventType: LedgerEventType.PROD_OUTPUT,
        materialId: finishedSku.id,
        batchLotId: batchLot.id,
        warehouseId: data.warehouseId,
        quantity: achieved,
        unitOfMeasure: finishedSku.unitOfMeasure ?? 'kg',
        referenceType: 'PLAN_FINISHING',
        referenceId: planId,
        createdById: data.recordedById,
        notes: `Finished output for plan ${item.productionPlan.planNumber}`,
      });

      // Finished goods wait for QA, same as the production-order completion flow.
      await tx.inspectionRecord.create({
        data: {
          inspectionType: 'FINISHED_BATCH',
          materialId: finishedSku.id,
          batchLotId: batchLot.id,
          referenceId: item.id,
          result: 'PENDING',
        },
      });
    }

    const created = await tx.productionStageRecord.create({
      data: {
        productionPlanId: planId,
        planItemId: item.id,
        stage: 'FINISHING',
        inputQuantity: required,
        achievedQuantity: achieved,
        remainderQuantity: Number(data.remainderQuantity ?? 0),
        carryoverUsedQuantity: carryoverUsed,
        unitOfMeasure: data.unitOfMeasure ?? finishedSku.unitOfMeasure ?? 'kg',
        // Snapshot the output cost so the day's value never drifts.
        unitCost: Number(finishedSku.standardCost ?? 0),
        batchNumber: data.batchNumber,
        warehouseId: data.warehouseId,
        finishedBatchLotId,
        productionDate: data.productionDate ? new Date(data.productionDate) : new Date(),
        remarks: data.remarks,
        recordedById: data.recordedById,
      },
    });

    await tx.productionPlanItem.update({
      where: { id: item.id },
      data: { actualYield: achieved },
    });

    // Complete the plan once every item has a finishing record.
    const allItems = await tx.productionPlanItem.findMany({
      where: { productionPlanId: planId },
      include: { stageRecords: true },
    });
    const allFinished = allItems.every((i) =>
      i.stageRecords.some((r) => r.stage === 'FINISHING')
    );
    if (allFinished) {
      await tx.productionPlan.update({
        where: { id: planId },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
    }

    return created;
  });

  await logActivity({
    userId: data.recordedById,
    activityType: 'CREATE',
    module: 'production',
    description: `Finishing recorded for plan ${item.productionPlan.planNumber}: required ${required}, achieved ${achieved}`,
    entityType: 'ProductionStageRecord',
    entityId: record.id,
  });

  return getPlanStationView(planId);
}

// ---------------------------------------------------------------------------
// Station sign-off (manager)
// ---------------------------------------------------------------------------

const STAGE_REVIEW_STATUSES = ['SUBMITTED', 'VERIFIED', 'FLAGGED'];

/** Verify or flag a submitted grinding/finishing record. */
export async function setStageRecordStatus(
  recordId: string,
  status: string,
  userId: string,
  notes?: string
) {
  if (!STAGE_REVIEW_STATUSES.includes(status)) {
    throw new Error(`status must be one of: ${STAGE_REVIEW_STATUSES.join(', ')}`);
  }

  const record = await prisma.productionStageRecord.findUnique({ where: { id: recordId } });
  if (!record) throw new Error('Stage record not found');

  const updated = await prisma.productionStageRecord.update({
    where: { id: recordId },
    data: { status: status as never, ...(notes !== undefined ? { remarks: notes } : {}) },
  });

  await logActivity({
    userId,
    activityType: status === 'FLAGGED' ? 'REJECT' : 'APPROVE',
    module: 'production',
    description: `${record.stage} record ${status.toLowerCase()}`,
    entityType: 'ProductionStageRecord',
    entityId: recordId,
  });

  return updated;
}
