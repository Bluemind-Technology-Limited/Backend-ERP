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
import { notifyStationWorkOrders, refreshStationWorkOrders, syncWorkInProgress, STATION_LABELS, STATION_ORDER } from './productionStationService.js';

const ISSUABLE_PLAN_STATUSES = ['SCHEDULED', 'IN_PROGRESS'];
const ACTIVE_PLAN_STATUSES = ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED'];

/** Sequence key for the continuous grinding batch number. */
export const GRINDING_BATCH_SEQUENCE_KEY = 'grinding_batch_number';

/**
 * Current grinding batch serial. `lastNumber` is the highest number used so far
 * (null until the operator seeds it). `nextNumber` is what the next batch gets.
 */
export async function getGrindingBatchSequence() {
  const [counter, highest] = await Promise.all([
    prisma.sequenceCounter.findUnique({ where: { key: GRINDING_BATCH_SEQUENCE_KEY } }),
    prisma.productionStageRecord.aggregate({
      where: { grindingBatchNumber: { not: null } },
      _max: { grindingBatchNumber: true },
    }),
  ]);

  const counterValue = counter?.value ?? 0;
  const usedValue = Number(highest._max.grindingBatchNumber ?? 0);
  const lastNumber = Math.max(counterValue, usedValue) || null;

  return { lastNumber, nextNumber: lastNumber === null ? null : lastNumber + 1 };
}

/** Seed/correct the serial. It can never be set below a number already used. */
export async function setGrindingBatchSequence(lastNumber: number) {
  if (!Number.isInteger(lastNumber) || lastNumber < 0) {
    throw new Error('Last grinding batch number must be a whole number, zero or greater');
  }

  const highest = await prisma.productionStageRecord.aggregate({
    where: { grindingBatchNumber: { not: null } },
    _max: { grindingBatchNumber: true },
  });
  const used = Number(highest._max.grindingBatchNumber ?? 0);
  if (lastNumber < used) {
    throw new Error(`Cannot be lower than the last assigned grinding batch number (${used})`);
  }

  await prisma.sequenceCounter.upsert({
    where: { key: GRINDING_BATCH_SEQUENCE_KEY },
    update: { value: lastNumber },
    create: { key: GRINDING_BATCH_SEQUENCE_KEY, value: lastNumber },
  });

  return { lastNumber, nextNumber: lastNumber + 1 };
}

/**
 * Resolve the batch number for a grinding record.
 *
 * A provided number is accepted when it is not already used (an operator
 * override/seed); otherwise the serial advances atomically by one. The counter
 * always ends up at the highest number issued.
 */
async function claimGrindingBatchNumber(
  tx: any,
  rawNumber: unknown
): Promise<number> {
  const provided =
    rawNumber === undefined || rawNumber === null || String(rawNumber).trim() === ''
      ? null
      : Number(rawNumber);

  if (provided === null) {
    // Atomic increment. The row must have been seeded by the operator first.
    const updated = await tx.sequenceCounter
      .update({
        where: { key: GRINDING_BATCH_SEQUENCE_KEY },
        data: { value: { increment: 1 } },
        select: { value: true },
      })
      .catch((error: any) => {
        if (error?.code === 'P2025') {
          throw new Error('A grinding batch number is required — set the last grinding batch number first');
        }
        throw error;
      });
    return Number(updated.value);
  }

  if (!Number.isInteger(provided) || provided <= 0) {
    throw new Error('Grinding batch number must be a positive whole number');
  }

  const clash = await tx.productionStageRecord.findFirst({
    where: { grindingBatchNumber: provided },
    select: { id: true },
  });
  if (clash) throw new Error(`Grinding batch number ${provided} is already used`);

  const counter = await tx.sequenceCounter.findUnique({
    where: { key: GRINDING_BATCH_SEQUENCE_KEY },
  });
  if (!counter) {
    await tx.sequenceCounter.create({
      data: { key: GRINDING_BATCH_SEQUENCE_KEY, value: provided },
    });
  } else if (provided > counter.value) {
    await tx.sequenceCounter.update({
      where: { key: GRINDING_BATCH_SEQUENCE_KEY },
      data: { value: provided },
    });
  }

  return provided;
}

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

  const totalOf = (item: any, stage: string, field: string) =>
    (item.stageRecords ?? [])
      .filter((record: any) => record.stage === stage)
      .reduce((sum: number, record: any) => sum + Number(record[field] ?? 0), 0);

  const grindingDone = items.filter((item) => {
    const target = Number(item.targetQuantity ?? 0);
    return target > 0 && totalOf(item, 'GRINDING', 'achievedQuantity') >= target - 0.0001;
  }).length;
  const finishingDone = items.filter((item) => {
    const target = Number(item.targetQuantity ?? 0);
    return target > 0 && totalOf(item, 'FINISHING', 'achievedQuantity') >= target - 0.0001;
  }).length;
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

/** Per-item view: expected vs received vs processed vs finished, with WIP. */
function enrichItems(plan: any, carryover?: Map<string, number>) {
  const items: any[] = plan.items ?? [];
  return items.map((item) => {
    const stageRecords: any[] = item.stageRecords ?? [];
    const grinding = stageRecords.filter((r) => r.stage === 'GRINDING');
    const finishing = stageRecords.filter((r) => r.stage === 'FINISHING');

    const target = Number(item.targetQuantity ?? 0);
    const expectedYield = Number(item.bom?.expectedYield ?? 0);
    const expectedBatches = expectedYield > 0 ? target / expectedYield : 0;

    const groundQuantity = grinding.reduce((sum, r) => sum + Number(r.achievedQuantity), 0);
    const receivedQuantity = grinding.reduce(
      (sum, r) => sum + Number(r.receivedQuantity ?? r.inputQuantity),
      0
    );
    const batchesGround = grinding.reduce((sum, r) => sum + Number(r.batchesProcessed ?? 0), 0);
    const achievedQuantity = finishing.reduce((sum, r) => sum + Number(r.achievedQuantity), 0);
    const rejectedQuantity = finishing.reduce((sum, r) => sum + Number(r.rejectedQuantity ?? 0), 0);

    const grindingOutstanding = Math.max(0, Number((target - groundQuantity).toFixed(4)));
    const finishingOutstanding = Math.max(0, Number((target - achievedQuantity).toFixed(4)));
    const grindingStatus =
      grindingOutstanding <= 0.0001
        ? 'COMPLETED'
        : groundQuantity > 0 || receivedQuantity > 0
          ? 'IN_PROGRESS'
          : 'PENDING';
    const finishingStatus =
      finishingOutstanding <= 0.0001
        ? 'COMPLETED'
        : achievedQuantity > 0 || groundQuantity > 0
          ? 'IN_PROGRESS'
          : 'PENDING';

    return {
      ...item,
      grindingRecords: grinding,
      finishingRecords: finishing,
      // Backwards-compatible convenience fields.
      grindingRecord: grinding[grinding.length - 1] ?? null,
      finishingRecord: finishing[finishing.length - 1] ?? null,
      expectedYield: Number(expectedYield.toFixed(4)),
      expectedBatches: Number(expectedBatches.toFixed(4)),
      groundQuantity: Number(groundQuantity.toFixed(4)),
      receivedQuantity: Number(receivedQuantity.toFixed(4)),
      batchesGround: Number(batchesGround.toFixed(4)),
      achievedQuantity: Number(achievedQuantity.toFixed(4)),
      rejectedQuantity: Number(rejectedQuantity.toFixed(4)),
      grindingOutstanding,
      finishingOutstanding,
      variance: Number((achievedQuantity - target).toFixed(4)),
      grindingStatus,
      finishingStatus,
      stationStatus: finishingStatus,
      // Unfinished output from earlier batches of this product.
      carryoverAvailable: carryover?.get(item.bomId) ?? 0,
    };
  });
}

function serializePlan(plan: any, carryover?: Map<string, number>) {
  const orders: any[] = plan.stationWorkOrders ?? [];
  return {
    id: plan.id,
    planNumber: plan.planNumber,
    description: plan.description,
    status: plan.status,
    scheduledFor: plan.scheduledFor,
    startedAt: plan.startedAt,
    completedAt: plan.completedAt,
    createdBy: plan.createdBy ?? null,
    releasedAt: plan.releasedAt ?? null,
    outstandingClosedAt: plan.outstandingClosedAt ?? null,
    outstandingCloseReason: plan.outstandingCloseReason ?? null,
    items: enrichItems(plan, carryover),
    aggregatedIngredients: plan.aggregatedIngredients ?? [],
    ingredientIssues: plan.ingredientIssues ?? [],
    stationWorkOrders: STATION_ORDER.map((station) => {
      const order = orders.find((row) => row.station === station);
      const expected = Number(order?.expectedQuantity ?? 0);
      const processed = Number(order?.processedQuantity ?? 0);
      return {
        station,
        label: STATION_LABELS[station],
        status: order?.status ?? 'PENDING',
        expectedQuantity: expected,
        receivedQuantity: Number(order?.receivedQuantity ?? 0),
        processedQuantity: processed,
        transferredQuantity: Number(order?.transferredQuantity ?? 0),
        outstandingQuantity: Number(order?.outstandingQuantity ?? 0),
        variance: Number((processed - expected).toFixed(4)),
        unitOfMeasure: order?.unitOfMeasure ?? 'kg',
      };
    }),
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
      batchLot: {
        select: { id: true, batchNumber: true, lotCode: true, setNumber: true, status: true },
      },
    },
    orderBy: { sequence: 'asc' as const },
  },
  aggregatedIngredients: {
    include: { material: { select: { id: true, name: true, sku: true, unitOfMeasure: true } } },
    orderBy: { materialId: 'asc' as const },
  },
  ingredientIssues: {
    include: { material: { select: { id: true, name: true, sku: true, unitOfMeasure: true } } },
    orderBy: { issuedAt: 'desc' as const },
  },
  stationWorkOrders: true,
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

  // Older plans predate the work-order feature: backfill them once, then reuse.
  await Promise.all(
    (plans as any[]).map(async (plan) => {
      if ((plan.stationWorkOrders ?? []).length < 3) {
        plan.stationWorkOrders = await refreshStationWorkOrders(plan.id).catch(() => []);
      }
    })
  );

  const carryover = await computeCarryoverByBom(plans.flatMap((p) => p.items.map((i) => i.bomId)));
  return plans.map((plan) => serializePlan(plan, carryover));
}

export async function getPlanStationView(planId: string) {
  const plan = await prisma.productionPlan.findUnique({
    where: { id: planId },
    include: PLAN_INCLUDE,
  });
  if (!plan) throw new Error('Production plan not found');
  const existing = (plan as any).stationWorkOrders ?? [];
  const stationWorkOrders = existing.length < 3 ? await refreshStationWorkOrders(plan.id) : existing;
  const carryover = await computeCarryoverByBom(plan.items.map((i) => i.bomId));
  return serializePlan({ ...plan, stationWorkOrders }, carryover);
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
      return (
        plan.status === 'IN_PROGRESS' &&
        plan.items.some((item: any) => Number(item.grindingOutstanding ?? item.targetQuantity) > 0.0001)
      );
    }
    return (
      plan.status !== 'COMPLETED' &&
      plan.status !== 'CANCELLED' &&
      plan.items.some(
        (item: any) =>
          Number(item.groundQuantity ?? 0) > 0 &&
          Number(item.finishingOutstanding ?? item.targetQuantity) > 0.0001
      )
    );
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
  // Persist the station balances and any outstanding quantity, then tell the
  // grinding station what has landed and what is still missing.
  await syncWorkInProgress(plan.id).catch((error) =>
    console.error('syncWorkInProgress (issue) failed:', error)
  );
  await refreshStationWorkOrders(plan.id).catch((error) =>
    console.error('refreshStationWorkOrders (issue) failed:', error)
  );
  await notifyStationWorkOrders({
    planId: plan.id,
    stations: ['GRINDING'],
    action: 'Ingredients have been issued. Receive them and record the grinding throughput.',
  }).catch((error) => console.error('notifyStationWorkOrders (issue) failed:', error));

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
  /** Actual quantity received from the Ingredient Station for this record. */
  receivedQuantity?: number;
  /** Number of formula batches processed in this record. */
  batchesProcessed?: number;
  remainderQuantity?: number;
  remainders?: Array<{ materialId: string; quantity: number; batchLotId?: string | null; warehouseId?: string | null }>;
  inputs?: Array<{ materialId: string; quantity: number; batchLotId?: string | null }>;
  machineId?: string | null;
  batchNumber?: string | null;
  /** Serial grinding batch number. Omit to take the next number automatically. */
  grindingBatchNumber?: number | string | null;
  productionDate?: string;
  remarks?: string;
  recordedById: string;
}) {
  const item = await prisma.productionPlanItem.findUnique({
    where: { id: data.planItemId },
    include: {
      bom: {
        select: { productName: true, finishedSku: { select: { unitOfMeasure: true } } },
      },
      batchLot: {
        select: { id: true, batchNumber: true, lotCode: true, status: true },
      },
      productionPlan: { select: { id: true, planNumber: true, status: true } },
    },
  });
  if (!item) throw new Error('Plan item not found');
  if (item.productionPlanId !== data.planId) throw new Error('Plan item does not belong to this plan');
  if (item.productionPlan.status === 'COMPLETED' || item.productionPlan.status === 'CANCELLED') {
    throw new Error(`This production plan is ${item.productionPlan.status.toLowerCase()} and cannot be processed`);
  }

  const input = Number(data.inputQuantity);
  const achieved = Number(data.achievedQuantity);
  const received = data.receivedQuantity === undefined ? input : Number(data.receivedQuantity);
  const batchesProcessed =
    data.batchesProcessed === undefined ? 0 : Number(data.batchesProcessed);
  const remainders = (data.remainders ?? []).filter((r) => Number(r.quantity) > 0);

  if (!Number.isFinite(input) || !Number.isFinite(achieved) || input <= 0 || achieved < 0) {
    throw new Error('Input quantity must be greater than zero and achieved quantity cannot be negative');
  }
  if (achieved > input) throw new Error('Achieved quantity cannot exceed the input quantity');
  if (!Number.isFinite(received) || received < 0) {
    throw new Error('Received quantity cannot be negative');
  }
  if (!Number.isFinite(batchesProcessed) || batchesProcessed < 0) {
    throw new Error('Batches processed cannot be negative');
  }

  if (!item.batchLotId || !item.batchLot) {
    throw new Error('This batch has no QA batch code yet — release the ingredients first');
  }
  if (item.batchLot.status === 'REJECTED') {
    throw new Error('This batch was rejected by QA and cannot be produced');
  }
  const approvedBatchLot = item.batchLot;

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
    const grindingBatchNumber = await claimGrindingBatchNumber(tx, data.grindingBatchNumber);

    const created = await tx.productionStageRecord.create({
      data: {
        productionPlanId: data.planId,
        planItemId: data.planItemId,
        stage: 'GRINDING',
        inputQuantity: input,
        achievedQuantity: achieved,
        receivedQuantity: received,
        batchesProcessed,
        remainderQuantity: remainderTotal,
        unitOfMeasure: item.bom.finishedSku?.unitOfMeasure ?? 'kg',
        machineId: data.machineId ?? null,
        batchNumber: approvedBatchLot.lotCode ?? approvedBatchLot.batchNumber,
        batchLotId: approvedBatchLot.id,
        grindingBatchNumber,
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

  // Ground output moves to the production station; leftovers stay in WIP.
  await syncWorkInProgress(plan.id).catch((error) =>
    console.error('syncWorkInProgress (grinding) failed:', error)
  );
  await refreshStationWorkOrders(plan.id).catch((error) =>
    console.error('refreshStationWorkOrders (grinding) failed:', error)
  );
  await notifyStationWorkOrders({
    planId: plan.id,
    stations: ['PRODUCTION'],
    action: 'Ground material is available. Receive it and record the finished output.',
  }).catch((error) => console.error('notifyStationWorkOrders (grinding) failed:', error));

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
  /** Finished goods rejected/lost during this production record. */
  rejectedQuantity?: number;
  warehouseId: string;
  /** Legacy field kept for API compatibility — the QA-approved lot code wins. */
  batchNumber?: string | null;
  expiryDate?: string;
  productionDate?: string;
  remarks?: string;
  recordedById: string;
}) {
  if (!data.warehouseId) throw new Error('A receiving warehouse is required');

  const item = await prisma.productionPlanItem.findUnique({
    where: { id: data.planItemId },
    include: {
      bom: {
        include: { finishedSku: { select: { id: true, name: true, unitOfMeasure: true, standardCost: true } } },
      },
      batchLot: {
        select: { id: true, batchNumber: true, lotCode: true, status: true, expiryDate: true },
      },
      productionPlan: { select: { id: true, planNumber: true, status: true } },
    },
  });
  if (!item) throw new Error('Plan item not found');
  if (item.productionPlanId !== data.planId) throw new Error('Plan item does not belong to this plan');
  if (item.productionPlan.status === 'COMPLETED' || item.productionPlan.status === 'CANCELLED') {
    throw new Error(`This production plan is ${item.productionPlan.status.toLowerCase()} and cannot be processed`);
  }

  const finishedSku = item.bom?.finishedSku;
  if (!finishedSku) throw new Error('This plan item\'s BOM has no finished SKU configured');

  if (!item.batchLotId || !item.batchLot) {
    throw new Error('This batch has no QA batch code yet — release the ingredients first');
  }
  if (item.batchLot.status === 'REJECTED') {
    throw new Error('This batch was rejected by QA and cannot be finished');
  }
  const approvedBatchNumber = item.batchLot.lotCode ?? item.batchLot.batchNumber;

  const achieved = Number(data.achievedQuantity);
  if (!(achieved >= 0)) throw new Error('Achieved quantity must be zero or greater');
  const rejected = Number(data.rejectedQuantity ?? 0);
  if (!Number.isFinite(rejected) || rejected < 0) {
    throw new Error('Rejected quantity cannot be negative');
  }

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
    const finishedBatchLotId = item.batchLotId;

    if (achieved > 0) {
      await postLedgerEntry(tx, {
        eventType: LedgerEventType.PROD_OUTPUT,
        materialId: finishedSku.id,
        batchLotId: finishedBatchLotId,
        warehouseId: data.warehouseId,
        quantity: achieved,
        unitOfMeasure: finishedSku.unitOfMeasure ?? 'kg',
        referenceType: 'PLAN_FINISHING',
        referenceId: planId,
        createdById: data.recordedById,
        notes: `Finished output for plan ${item.productionPlan.planNumber}`,
      });
    }

    const created = await tx.productionStageRecord.create({
      data: {
        productionPlanId: planId,
        planItemId: item.id,
        stage: 'FINISHING',
        inputQuantity: required,
        achievedQuantity: achieved,
        rejectedQuantity: rejected,
        remainderQuantity: Number(data.remainderQuantity ?? 0),
        carryoverUsedQuantity: carryoverUsed,
        unitOfMeasure: finishedSku.unitOfMeasure ?? 'kg',
        // Snapshot the output cost so the day's value never drifts.
        unitCost: Number(finishedSku.standardCost ?? 0),
        batchNumber: approvedBatchNumber,
        batchLotId: finishedBatchLotId,
        warehouseId: data.warehouseId,
        finishedBatchLotId,
        productionDate: data.productionDate ? new Date(data.productionDate) : new Date(),
        remarks: data.remarks,
        recordedById: data.recordedById,
      },
    });

    // actualYield is the cumulative finished quantity for this batch, not just
    // the last partial record.
    const finishedTotal = await tx.productionStageRecord.aggregate({
      where: { planItemId: item.id, stage: 'FINISHING' },
      _sum: { achievedQuantity: true },
    });
    await tx.productionPlanItem.update({
      where: { id: item.id },
      data: { actualYield: Number(finishedTotal._sum.achievedQuantity ?? 0) },
    });

    // Complete only when every batch's required quantity is fully accounted
    // for. Outstanding quantities must be explicitly reconciled/closed first.
    const allItems = await tx.productionPlanItem.findMany({
      where: { productionPlanId: planId },
      include: { stageRecords: true },
    });
    const allFinished = allItems.every((planItem) => {
      const target = Number(planItem.targetQuantity);
      const finished = planItem.stageRecords
        .filter((record) => record.stage === 'FINISHING')
        .reduce((sum, record) => sum + Number(record.achievedQuantity), 0);
      return target > 0 && finished >= target - 0.0001;
    });
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

  // Close out completed WIP and refresh the station balances.
  await syncWorkInProgress(planId).catch((error) =>
    console.error('syncWorkInProgress (finishing) failed:', error)
  );
  await refreshStationWorkOrders(planId).catch((error) =>
    console.error('refreshStationWorkOrders (finishing) failed:', error)
  );

  return getPlanStationView(planId);
}

/**
 * Explicitly reconcile and close outstanding production quantities.
 * A plan with a shortfall can only complete through this action — the WIP pool
 * is closed with the reason and the audit trail records it.
 */
export async function closePlanOutstanding(data: {
  planId: string;
  userId: string;
  reason: string;
}) {
  const reason = String(data.reason ?? '').trim();
  if (!reason) throw new Error('A reconciliation reason is required');

  const plan = await prisma.productionPlan.findUnique({
    where: { id: data.planId },
    select: {
      id: true,
      planNumber: true,
      status: true,
      items: { include: { stageRecords: true } },
    },
  });
  if (!plan) throw new Error('Production plan not found');
  if (plan.status === 'COMPLETED') throw new Error('Production plan is already completed');
  if (plan.status === 'CANCELLED') throw new Error('Cancelled production plans cannot be reconciled');

  const outstanding = plan.items.map((item) => {
    const target = Number(item.targetQuantity);
    const finished = item.stageRecords
      .filter((record) => record.stage === 'FINISHING')
      .reduce((sum, record) => sum + Number(record.achievedQuantity), 0);
    return {
      planItemId: item.id,
      target,
      finished,
      outstanding: Math.max(0, Number((target - finished).toFixed(4))),
    };
  });
  const totalOutstanding = Number(
    outstanding.reduce((sum, row) => sum + row.outstanding, 0).toFixed(4)
  );

  await prisma.$transaction(async (tx) => {
    await tx.workInProgress.updateMany({
      where: {
        productionPlanId: plan.id,
        status: { in: ['OPEN', 'PARTIAL'] as any },
      },
      data: {
        status: 'CLOSED' as any,
        closedAt: new Date(),
        notes: `Closed during production reconciliation: ${reason}`,
      },
    });

    await tx.productionPlan.update({
      where: { id: plan.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        outstandingClosedAt: new Date(),
        outstandingClosedById: data.userId,
        outstandingCloseReason: reason,
      },
    });
  });

  await logActivity({
    userId: data.userId,
    activityType: 'ADJUST',
    module: 'production',
    description: `Closed ${totalOutstanding} outstanding unit(s) on plan ${plan.planNumber}: ${reason}`,
    entityType: 'ProductionPlan',
    entityId: plan.id,
    details: { totalOutstanding, reason, items: outstanding },
  });

  await refreshStationWorkOrders(plan.id).catch((error) =>
    console.error('refreshStationWorkOrders (close outstanding) failed:', error)
  );

  return {
    plan: await getPlanStationView(plan.id),
    reconciliation: { totalOutstanding, reason, items: outstanding },
  };
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
