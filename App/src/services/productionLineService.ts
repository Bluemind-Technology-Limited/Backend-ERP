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
        include: { finishedSku: { select: { id: true, name: true, unitOfMeasure: true } } },
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
