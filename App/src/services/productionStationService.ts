/**
 * Three-station production flow.
 *
 * A released production plan creates one work order per station:
 *
 *   INGREDIENT  →  GRINDING  →  PRODUCTION
 *
 * Each work order carries the expected quantity and is kept in sync with what
 * was received, processed and transferred. Anything that has not reached the
 * next station is persisted in the `work_in_progress` pool so it is never
 * counted as completed output and can always be traced back to its plan/batch.
 *
 * This module deliberately has no dependency on `productionLineService` or
 * `productionPlan` so both can call into it without an import cycle.
 */
import { prisma } from '../lib/db.js';
import { quantityWeightKg } from '../lib/uom.js';
import { logActivity } from './userActivityLogger.js';

export const STATION_ORDER = ['INGREDIENT', 'GRINDING', 'PRODUCTION'] as const;
export type StationCode = (typeof STATION_ORDER)[number];

export const STATION_LABELS: Record<StationCode, string> = {
  INGREDIENT: 'Ingredients Station',
  GRINDING: 'Grinding Station',
  PRODUCTION: 'Production Station',
};

const STATION_ROLES: Record<StationCode, string[]> = {
  INGREDIENT: ['STORE_OFFICER'],
  GRINDING: ['GRINDING_SUPERVISOR'],
  PRODUCTION: ['PRODUCTION_MANAGER', 'PRODUCTION_SUPERVISOR'],
};

const STATION_ACTIONS: Record<StationCode, string> = {
  INGREDIENT: 'Receive the plan requirements and issue the ingredients.',
  GRINDING: 'Receive the issued ingredients and record the grinding throughput.',
  PRODUCTION: 'Receive the ground material and record the finished output.',
};

const EPSILON = 0.0001;

function round(value: number): number {
  return Number(Number(value).toFixed(4));
}

function sum(values: Array<number | string | null | undefined>): number {
  return round(values.reduce((total: number, value) => total + Number(value ?? 0), 0));
}

/** Weight-based total when every line is weighable, otherwise pack counts. */
function weightedTotal(
  lines: Array<{ quantity: number | string; material?: { packSize?: unknown; packUnit?: unknown } | null }>
): { quantity: number; unit: string } {
  let total = 0;
  let weighable = lines.length > 0;
  for (const line of lines) {
    const weight = line.material
      ? quantityWeightKg(line.quantity, line.material.packSize, line.material.packUnit)
      : null;
    if (weight === null) weighable = false;
    total += weight ?? Number(line.quantity ?? 0);
  }
  return { quantity: round(total), unit: weighable ? 'KG' : 'packs' };
}

interface PlanFlow {
  plan: any;
  expectedIngredients: { quantity: number; unit: string };
  issuedIngredients: { quantity: number; unit: string };
  expectedOutput: number;
  outputUnit: string;
  grindingInput: number;
  grindingOutput: number;
  finishingOutput: number;
  products: string[];
}

/** Load everything needed to derive the three station balances. */
async function loadPlanFlow(planId: string, db: any = prisma): Promise<PlanFlow> {
  const plan = await db.productionPlan.findUnique({
    where: { id: planId },
    include: {
      createdBy: { select: { id: true, fullName: true } },
      items: {
        include: {
          bom: {
            include: {
              finishedSku: {
                select: { id: true, name: true, sku: true, packSize: true, packUnit: true, unitOfMeasure: true },
              },
            },
          },
          stageRecords: true,
        },
        orderBy: { sequence: 'asc' },
      },
      aggregatedIngredients: {
        include: {
          material: {
            select: { id: true, name: true, sku: true, packSize: true, packUnit: true, unitOfMeasure: true },
          },
        },
      },
    },
  });
  if (!plan) throw new Error('Production plan not found');

  const expectedIngredients = weightedTotal(
    plan.aggregatedIngredients.map((agg: any) => ({
      quantity: agg.totalQuantity,
      material: agg.material,
    }))
  );
  const issuedIngredients = weightedTotal(
    plan.aggregatedIngredients.map((agg: any) => ({
      quantity: agg.issuedQuantity ?? 0,
      material: agg.material,
    }))
  );

  const stageRecords = plan.items.flatMap((item: any) => item.stageRecords ?? []);
  const grinding = stageRecords.filter((r: any) => r.stage === 'GRINDING');
  const finishing = stageRecords.filter((r: any) => r.stage === 'FINISHING');

  const outputUnit =
    plan.items.find((i: any) => i.bom?.yieldUnit)?.bom?.yieldUnit ??
    plan.items.find((i: any) => i.bom?.finishedSku?.unitOfMeasure)?.bom?.finishedSku?.unitOfMeasure ??
    'kg';

  return {
    plan,
    expectedIngredients,
    issuedIngredients,
    expectedOutput: sum(plan.items.map((i: any) => i.targetQuantity)),
    outputUnit,
    grindingInput: sum(grinding.map((r: any) => r.inputQuantity)),
    grindingOutput: sum(grinding.map((r: any) => r.achievedQuantity)),
    finishingOutput: sum(finishing.map((r: any) => r.achievedQuantity)),
    products: plan.items.map(
      (i: any) => i.bom?.finishedSku?.name ?? i.bom?.productName ?? 'Product'
    ),
  };
}

function manualTransferred(
  wipRows: Array<{ originStation: string; transferredQuantity: unknown }>,
  station: StationCode
): number {
  return sum(
    wipRows.filter((row) => row.originStation === station).map((row) => row.transferredQuantity as number)
  );
}

function manualReceived(
  wipRows: Array<{ destinationStation: string | null; transferredQuantity: unknown }>,
  station: StationCode
): number {
  return sum(
    wipRows
      .filter((row) => row.destinationStation === station)
      .map((row) => row.transferredQuantity as number)
  );
}

function deriveBalances(
  flow: PlanFlow,
  wipRows: Array<{ originStation: string; destinationStation: string | null; transferredQuantity: unknown }>
) {
  const ingredientExpected = flow.expectedIngredients;
  const issued = flow.issuedIngredients;

  const balances: Record<StationCode, {
    expectedQuantity: number;
    receivedQuantity: number;
    processedQuantity: number;
    transferredQuantity: number;
    outstandingQuantity: number;
    unitOfMeasure: string;
  }> = {
    INGREDIENT: {
      expectedQuantity: ingredientExpected.quantity,
      // Requirements are received from the plan itself.
      receivedQuantity: ingredientExpected.quantity,
      processedQuantity: issued.quantity,
      transferredQuantity: Math.min(issued.quantity, ingredientExpected.quantity),
      outstandingQuantity: Math.max(0, round(ingredientExpected.quantity - issued.quantity)),
      unitOfMeasure: ingredientExpected.unit,
    },
    GRINDING: {
      expectedQuantity: ingredientExpected.quantity,
      receivedQuantity: issued.quantity,
      processedQuantity: flow.grindingInput,
      transferredQuantity: flow.grindingOutput,
      outstandingQuantity: Math.max(0, round(ingredientExpected.quantity - flow.grindingInput)),
      unitOfMeasure: ingredientExpected.unit,
    },
    PRODUCTION: {
      expectedQuantity: flow.expectedOutput,
      receivedQuantity: flow.grindingOutput,
      processedQuantity: flow.finishingOutput,
      transferredQuantity: flow.finishingOutput,
      outstandingQuantity: Math.max(0, round(flow.expectedOutput - flow.finishingOutput)),
      unitOfMeasure: flow.outputUnit,
    },
  };

  // Manual WIP transfers count as movement at the origin and receipt at the
  // destination station. Clamp to the station's expectation so a quantity that
  // is both transferred and later recorded can never be counted twice.
  for (const station of STATION_ORDER) {
    const expected = balances[station].expectedQuantity;
    const extra = manualTransferred(wipRows, station);
    if (extra > 0) {
      balances[station].transferredQuantity = round(
        Math.min(expected, balances[station].transferredQuantity + extra)
      );
      balances[station].outstandingQuantity = Math.max(
        0,
        round(expected - balances[station].processedQuantity - extra)
      );
    }
    const incoming = manualReceived(wipRows, station);
    if (incoming > 0) {
      const received = balances[station].receivedQuantity + incoming;
      balances[station].receivedQuantity = round(
        expected > 0 ? Math.min(expected, received) : received
      );
    }
  }

  return balances;
}

function statusFor(balance: {
  expectedQuantity: number;
  processedQuantity: number;
  receivedQuantity: number;
  outstandingQuantity: number;
}): 'COMPLETED' | 'IN_PROGRESS' | 'PENDING' {
  if (balance.expectedQuantity > 0 && balance.outstandingQuantity <= EPSILON) return 'COMPLETED';
  if (balance.receivedQuantity > 0 || balance.processedQuantity > 0) return 'IN_PROGRESS';
  return 'PENDING';
}

/**
 * Recompute and persist the three work orders for a plan. Safe to call at every
 * hand-off; it creates the rows if the plan predates the feature.
 */
export async function refreshStationWorkOrders(planId: string, tx?: any) {
  const db = tx ?? prisma;
  const flow = await loadPlanFlow(planId, db);
  const existingWip = await db.workInProgress.findMany({
    where: { productionPlanId: planId },
    select: { originStation: true, destinationStation: true, transferredQuantity: true },
  });
  const balances = deriveBalances(flow, existingWip);

  const orders = [] as any[];
  for (const station of STATION_ORDER) {
    const balance = balances[station];
    const status = statusFor(balance);
    const now = new Date();

    const existing = await db.productionStationWorkOrder.findUnique({
      where: { productionPlanId_station: { productionPlanId: planId, station } } as any,
    });

    const data = {
      status,
      expectedQuantity: balance.expectedQuantity,
      receivedQuantity: balance.receivedQuantity,
      processedQuantity: balance.processedQuantity,
      transferredQuantity: balance.transferredQuantity,
      outstandingQuantity: balance.outstandingQuantity,
      unitOfMeasure: balance.unitOfMeasure,
      startedAt: existing?.startedAt ?? (balance.processedQuantity > 0 ? now : null),
      completedAt: status === 'COMPLETED' ? existing?.completedAt ?? now : null,
    };

    const order = await db.productionStationWorkOrder.upsert({
      where: { productionPlanId_station: { productionPlanId: planId, station } } as any,
      update: data,
      create: { productionPlanId: planId, station, ...data },
    });
    orders.push(order);
  }

  return orders;
}

/**
 * Create the work orders and send each station its own notification with the
 * production order, date, products and the action required from that station.
 */
export async function notifyStationWorkOrders(input: {
  planId: string;
  action?: string;
  /** Limit the notifications to these stations; defaults to all three. */
  stations?: StationCode[];
  /** Join an existing transaction so release is all-or-nothing. */
  tx?: any;
}) {
  const db = input.tx ?? prisma;
  const orders = await refreshStationWorkOrders(input.planId, input.tx);
  const plan = await db.productionPlan.findUnique({
    where: { id: input.planId },
    include: {
      items: {
        include: {
          bom: { include: { finishedSku: { select: { name: true } } } },
        },
        orderBy: { sequence: 'asc' },
      },
    },
  });
  if (!plan) return orders;

  const productionDate = plan.scheduledFor ?? new Date();
  const dateLabel = productionDate.toISOString().slice(0, 10);
  const products =
    plan.items
      .map((item: any) => item.bom?.finishedSku?.name ?? item.bom?.productName)
      .filter(Boolean)
      .join(', ') || 'No products';

  for (const order of orders) {
    const station = order.station as StationCode;
    if (input.stations && !input.stations.includes(station)) continue;
    const roles = STATION_ROLES[station];
    const users = await db.user.findMany({
      where: { role: { in: roles as any[] }, isActive: true },
      select: { id: true },
    });
    if (users.length === 0) continue;

    const expected = Number(order.expectedQuantity);
    const body = [
      `Production order ${plan.planNumber}`,
      `Date ${dateLabel}`,
      `Products: ${products}`,
      `Expected: ${expected} ${order.unitOfMeasure}`,
      input.action ?? STATION_ACTIONS[station],
    ].join(' · ');

    await db.notification.createMany({
      data: users.map((user: { id: string }) => ({
        userId: user.id,
        title: `${STATION_LABELS[station]} — ${plan.planNumber}`,
        body,
        type: 'SYSTEM',
        notificationType: 'SYSTEM',
        referenceId: plan.id,
        isActionable: true,
      })),
      skipDuplicates: false,
    });

    await db.productionStationWorkOrder.update({
      where: { id: order.id },
      data: { notifiedAt: new Date() },
    });
  }

  return orders;
}

/**
 * Reconcile the persisted WIP pool from the plan's current state. One row per
 * plan + origin station + item/material, so the same material is never counted
 * twice. Completed rows are closed, not deleted, to keep the history.
 */
export async function syncWorkInProgress(planId: string) {
  const flow = await loadPlanFlow(planId);
  const orders = await prisma.productionStationWorkOrder.findMany({
    where: { productionPlanId: planId },
  });
  const orderByStation = new Map(orders.map((order) => [order.station, order]));

  const productionDate = flow.plan.scheduledFor ?? new Date();
  const planItems = new Map(flow.plan.items.map((item: any) => [item.id, item]));

  const rows: Array<{
    key: string;
    productionPlanId: string;
    planItemId?: string | null;
    stationWorkOrderId?: string | null;
    productionDate: Date;
    productName?: string | null;
    batchNumber?: string | null;
    batchLotId?: string | null;
    materialId?: string | null;
    originStation: StationCode;
    destinationStation: StationCode | null;
    expectedQuantity: number;
    completedQuantity: number;
    transferredQuantity: number;
    remainingQuantity: number;
    unitOfMeasure: string;
    notes?: string | null;
  }> = [];

  // 1. Ingredients issued short of the requirement stay at the ingredient station.
  for (const agg of flow.plan.aggregatedIngredients as any[]) {
    const required = quantityWeightKg(agg.totalQuantity, agg.material.packSize, agg.material.packUnit);
    const issued = quantityWeightKg(agg.issuedQuantity ?? 0, agg.material.packSize, agg.material.packUnit);
    const expectedQuantity = required ?? Number(agg.totalQuantity ?? 0);
    const completedQuantity = issued ?? Number(agg.issuedQuantity ?? 0);
    const remaining = Math.max(0, round(expectedQuantity - completedQuantity));

    rows.push({
      key: `wip:${planId}:INGREDIENT:${agg.materialId}`,
      productionPlanId: planId,
      stationWorkOrderId: orderByStation.get('INGREDIENT')?.id ?? null,
      productionDate,
      materialId: agg.materialId,
      originStation: 'INGREDIENT',
      destinationStation: 'GRINDING',
      expectedQuantity,
      completedQuantity,
      transferredQuantity: 0,
      remainingQuantity: remaining,
      unitOfMeasure: required === null ? agg.unitOfMeasure : 'KG',
      notes: remaining > 0 ? 'Ingredient requirement not yet issued to grinding' : null,
    });
  }

  // 2. Ground output not yet finished sits between grinding and production.
  for (const item of flow.plan.items as any[]) {
    const grinding = (item.stageRecords ?? []).filter((r: any) => r.stage === 'GRINDING');
    if (grinding.length === 0) continue;
    const input = sum(grinding.map((r: any) => r.inputQuantity));
    const output = sum(grinding.map((r: any) => r.achievedQuantity));
    const last = grinding[grinding.length - 1];
    rows.push({
      key: `wip:${planId}:GRINDING:${item.id}`,
      productionPlanId: planId,
      planItemId: item.id,
      stationWorkOrderId: orderByStation.get('GRINDING')?.id ?? null,
      productionDate: last.productionDate ?? productionDate,
      productName: item.bom?.finishedSku?.name ?? item.bom?.productName ?? null,
      batchNumber: last.batchNumber ?? (last.grindingBatchNumber ? String(last.grindingBatchNumber) : null),
      batchLotId: null,
      materialId: item.bom?.finishedSku?.id ?? null,
      originStation: 'GRINDING',
      destinationStation: 'PRODUCTION',
      expectedQuantity: input,
      completedQuantity: output,
      transferredQuantity: 0,
      remainingQuantity: Math.max(0, round(input - output)),
      unitOfMeasure: last.unitOfMeasure ?? flow.outputUnit,
      notes: 'Ground material awaiting production',
    });
  }

  // 3. Planned finished output not yet produced stays at the production station.
  for (const item of flow.plan.items as any[]) {
    const finishing = (item.stageRecords ?? []).filter((r: any) => r.stage === 'FINISHING');
    if (finishing.length === 0) continue;
    const achieved = sum(finishing.map((r: any) => r.achievedQuantity));
    const target = Number(item.targetQuantity ?? 0);
    const last = finishing[finishing.length - 1];
    rows.push({
      key: `wip:${planId}:PRODUCTION:${item.id}`,
      productionPlanId: planId,
      planItemId: item.id,
      stationWorkOrderId: orderByStation.get('PRODUCTION')?.id ?? null,
      productionDate: last.productionDate ?? productionDate,
      productName: item.bom?.finishedSku?.name ?? item.bom?.productName ?? null,
      batchNumber: last.batchNumber ?? null,
      batchLotId: last.finishedBatchLotId ?? null,
      materialId: item.bom?.finishedSku?.id ?? null,
      originStation: 'PRODUCTION',
      destinationStation: null,
      expectedQuantity: target,
      completedQuantity: achieved,
      transferredQuantity: 0,
      remainingQuantity: Math.max(0, round(target - achieved)),
      unitOfMeasure: flow.outputUnit,
      notes: 'Finished quantity awaiting completion',
    });
  }

  for (const row of rows) {
    const existing = await prisma.workInProgress.findUnique({ where: { key: row.key } });
    // Never count manual transfers twice: preserve what was already moved.
    const transferred = Number(existing?.transferredQuantity ?? 0);
    const remaining = Math.max(0, round(row.expectedQuantity - row.completedQuantity - transferred));

    if (remaining <= EPSILON) {
      if (existing && existing.status !== 'CLOSED') {
        await prisma.workInProgress.update({
          where: { id: existing.id },
          data: {
            completedQuantity: row.completedQuantity,
            remainingQuantity: 0,
            status: transferred > 0 ? 'TRANSFERRED' : 'CLOSED',
            closedAt: new Date(),
          },
        });
      }
      continue;
    }

    await prisma.workInProgress.upsert({
      where: { key: row.key },
      update: {
        planItemId: row.planItemId ?? null,
        stationWorkOrderId: row.stationWorkOrderId ?? existing?.stationWorkOrderId ?? null,
        productionDate: row.productionDate,
        productName: row.productName ?? null,
        batchNumber: row.batchNumber ?? null,
        batchLotId: row.batchLotId ?? null,
        materialId: row.materialId ?? null,
        originStation: row.originStation,
        destinationStation: row.destinationStation,
        expectedQuantity: row.expectedQuantity,
        completedQuantity: row.completedQuantity,
        remainingQuantity: remaining,
        unitOfMeasure: row.unitOfMeasure,
        status: transferred > 0 ? 'PARTIAL' : 'OPEN',
        notes: row.notes ?? null,
        closedAt: null,
      },
      create: {
        key: row.key,
        productionPlanId: planId,
        planItemId: row.planItemId ?? null,
        stationWorkOrderId: row.stationWorkOrderId ?? null,
        productionDate: row.productionDate,
        productName: row.productName ?? null,
        batchNumber: row.batchNumber ?? null,
        batchLotId: row.batchLotId ?? null,
        materialId: row.materialId ?? null,
        originStation: row.originStation,
        destinationStation: row.destinationStation,
        expectedQuantity: row.expectedQuantity,
        completedQuantity: row.completedQuantity,
        transferredQuantity: 0,
        remainingQuantity: remaining,
        unitOfMeasure: row.unitOfMeasure,
        status: 'OPEN',
        notes: row.notes ?? null,
      },
    });
  }
}

/** Full flow view for the station dashboards. */
export async function getStationFlow(planId: string) {
  const flow = await loadPlanFlow(planId);
  const orders = await refreshStationWorkOrders(planId);
  const wip = await prisma.workInProgress.findMany({
    where: { productionPlanId: planId, status: { in: ['OPEN', 'PARTIAL'] as any } },
    orderBy: { createdAt: 'asc' },
  });

  return {
    planId,
    planNumber: flow.plan.planNumber,
    status: flow.plan.status,
    productionDate: flow.plan.scheduledFor,
    products: flow.products,
    stations: STATION_ORDER.map((station) => {
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
        // Negative = shortfall, positive = over-production.
        variance: round(processed - expected),
        unitOfMeasure: order?.unitOfMeasure ?? 'kg',
        notifiedAt: order?.notifiedAt ?? null,
      };
    }),
    wip,
  };
}

/** List the carry-over repository with optional filters. */
export async function getWorkInProgress(filters?: {
  status?: string;
  station?: string;
  planId?: string;
  from?: string;
  to?: string;
}) {
  const where: any = {};
  if (filters?.status) {
    const raw = filters.status.toUpperCase();
    if (raw === 'ACTIVE' || raw === 'OPEN') {
      // The repository's "active" view is everything still moving.
      where.status = { in: raw === 'ACTIVE' ? ['OPEN', 'PARTIAL'] : ['OPEN'] };
    } else {
      const statuses = raw.split(',').map((value) => value.trim()).filter(Boolean);
      where.status = statuses.length > 1 ? { in: statuses } : statuses[0];
    }
  }
  if (filters?.station) {
    const stations = filters.station.toUpperCase().split(',').map((value) => value.trim()).filter(Boolean);
    where.originStation = stations.length > 1 ? { in: stations } : stations[0];
  }
  if (filters?.planId) where.productionPlanId = filters.planId;
  if (filters?.from || filters?.to) {
    where.productionDate = {};
    if (filters.from) where.productionDate.gte = new Date(filters.from);
    if (filters.to) {
      const to = new Date(filters.to);
      to.setHours(23, 59, 59, 999);
      where.productionDate.lte = to;
    }
  }

  const entries = await prisma.workInProgress.findMany({
    where,
    include: {
      productionPlan: {
        select: { id: true, planNumber: true, status: true, scheduledFor: true },
      },
      stationWorkOrder: { select: { id: true, station: true, status: true } },
    },
    orderBy: [{ status: 'asc' }, { productionDate: 'desc' }],
  });

  const totals = entries.reduce(
    (acc, entry) => {
      acc.remaining += Number(entry.remainingQuantity);
      acc.transferred += Number(entry.transferredQuantity);
      return acc;
    },
    { remaining: 0, transferred: 0 }
  );

  return {
    entries,
    totals: { remaining: round(totals.remaining), transferred: round(totals.transferred) },
  };
}

/**
 * Move outstanding WIP to the next station. Operationally only: the material was
 * already deducted from stock when it was issued, so this never posts a ledger
 * entry and can never double-count stock.
 */
export async function transferWorkInProgress(input: {
  id: string;
  quantity: number;
  userId: string;
  notes?: string;
}) {
  const entry = await prisma.workInProgress.findUnique({
    where: { id: input.id },
    include: { stationWorkOrder: true },
  });
  if (!entry) throw new Error('WIP record not found');

  if (!['OPEN', 'PARTIAL'].includes(entry.status)) {
    throw new Error(`WIP record is already ${entry.status.toLowerCase()}`);
  }

  const quantity = Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Transfer quantity must be greater than zero');
  }
  if (quantity > Number(entry.remainingQuantity) + EPSILON) {
    throw new Error(
      `Only ${entry.remainingQuantity} ${entry.unitOfMeasure} is outstanding on this record`
    );
  }

  const remaining = Math.max(0, round(Number(entry.remainingQuantity) - quantity));
  const status = remaining <= EPSILON ? 'TRANSFERRED' : 'PARTIAL';

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.workInProgress.update({
      where: { id: entry.id },
      data: {
        transferredQuantity: round(Number(entry.transferredQuantity) + quantity),
        remainingQuantity: remaining,
        status: status as any,
        closedAt: status === 'TRANSFERRED' ? new Date() : null,
        notes: input.notes ?? entry.notes,
      },
    });

    if (entry.stationWorkOrderId) {
      await tx.productionStationWorkOrder.update({
        where: { id: entry.stationWorkOrderId },
        data: {
          transferredQuantity: { increment: quantity },
          outstandingQuantity: { decrement: quantity },
        },
      });
    }

    if (entry.destinationStation) {
      await tx.productionStationWorkOrder.updateMany({
        where: {
          productionPlanId: entry.productionPlanId,
          station: entry.destinationStation,
        },
        data: {
          receivedQuantity: { increment: quantity },
          startedAt: new Date(),
        },
      });
    }

    return row;
  });

  await logActivity({
    userId: input.userId,
    activityType: 'TRANSFER',
    module: 'production',
    description: `Transferred ${quantity} ${entry.unitOfMeasure} of WIP from ${entry.originStation}${
      entry.destinationStation ? ` to ${entry.destinationStation}` : ''
    } for plan ${entry.productionPlanId}`,
    entityType: 'WorkInProgress',
    entityId: entry.id,
  });

  await refreshStationWorkOrders(entry.productionPlanId);
  return updated;
}
