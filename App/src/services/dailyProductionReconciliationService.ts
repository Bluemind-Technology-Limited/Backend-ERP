import { prisma } from '../lib/db.js';
import * as userActivityLogger from './userActivityLogger.js';

/**
 * Daily Production Reconciliation Service
 * Manages end-of-day stock reconciliation comparing planned vs actual production
 * Automatically flags discrepancies and tracks supervisor verification
 */

export interface CreateReconciliationOptions {
  productionPlanId: string;
  supervisorId: string;
  reconciliationDate: Date;
}

export interface ReconciliationItemDetail {
  itemNumber: number;
  product: string;
  targetQuantity: number;
  actualQuantity?: number;
  variance?: number;
  variancePercentage?: number;
  status: 'pending' | 'completed' | 'completed_with_variance';
}

/**
 * Create daily reconciliation by comparing plan items vs completed production orders
 */
export async function createDailyReconciliation(options: CreateReconciliationOptions) {
  const { productionPlanId, supervisorId, reconciliationDate } = options;

  // Fetch plan with all items
  const plan = await prisma.productionPlan.findUnique({
    where: { id: productionPlanId },
    include: {
      items: {
        include: {
          bom: { include: { finishedSku: true } },
        },
      },
    },
  });
  if (!plan) throw new Error(`Production plan ${productionPlanId} not found`);

  // Get all allocations for this plan to find completed batches
  const allocations = await prisma.batchMachineAllocation.findMany({
    where: {
      planItem: {
        productionPlanId,
      },
    },
    include: {
      productionOrder: true,
    },
  });

  // Calculate planned totals
  let plannedItemCount = plan.items.length;
  let plannedTotalQuantity = 0;
  for (const item of plan.items) {
    plannedTotalQuantity += Number(item.targetQuantity);
  }

  // Calculate actual totals from completed allocations
  let actualItemCount = 0;
  let actualTotalQuantity = 0;
  for (const alloc of allocations) {
    if (alloc.status === 'COMPLETED' && alloc.productionOrder.actualYield) {
      actualItemCount++;
      actualTotalQuantity += Number(alloc.productionOrder.actualYield);
    }
  }

  // Calculate variance
  const quantityVariance = actualTotalQuantity - plannedTotalQuantity;
  const variancePercentage = plannedTotalQuantity > 0
    ? (quantityVariance / plannedTotalQuantity) * 100
    : 0;

  // Flag if variance is significant (>5%)
  const isSignificantVariance = Math.abs(variancePercentage) > 5;
  const notes = isSignificantVariance
    ? `Variance exceeds 5% threshold: ${variancePercentage.toFixed(2)}%`
    : '';

  // Create reconciliation
  const reconciliation = await prisma.dailyProductionReconciliation.create({
    data: {
      productionPlanId,
      supervisorId,
      reconciliationDate,
      plannedItemCount,
      plannedTotalQuantity,
      actualItemCount,
      actualTotalQuantity,
      quantityVariance,
      variancePercentage,
      discrepancyNotes: notes,
      status: 'PENDING',
    },
    include: {
      productionPlan: { include: { items: true } },
      supervisor: { select: { id: true, fullName: true } },
    },
  });

  // Log activity
  await userActivityLogger.logActivity({
    userId: supervisorId,
    activityType: 'CREATE',
    module: 'production',
    description: 'Created daily production reconciliation',
    entityType: 'DailyProductionReconciliation',
    entityId: reconciliation.id,
    details: {
      plannedTotal: plannedTotalQuantity,
      actualTotal: actualTotalQuantity,
      variance: quantityVariance,
      variancePercentage,
      flagged: isSignificantVariance,
    },
  });

  return reconciliation;
}

/**
 * Get detailed reconciliation with item-by-item breakdown
 */
export async function getReconciliationDetails(reconciliationId: string) {
  const reconciliation = await prisma.dailyProductionReconciliation.findUnique({
    where: { id: reconciliationId },
    include: {
      productionPlan: {
        include: {
          items: {
            include: {
              bom: { include: { finishedSku: true } },
            },
          },
        },
      },
      supervisor: { select: { id: true, fullName: true, email: true } },
    },
  });

  if (!reconciliation) return null;

  // Get allocations for this plan to get actual yields
  const allocations = await prisma.batchMachineAllocation.findMany({
    where: {
      planItem: {
        productionPlanId: reconciliation.productionPlanId,
      },
    },
    include: {
      productionOrder: true,
    },
  });

  // Build item details array
  const itemDetails: ReconciliationItemDetail[] = reconciliation.productionPlan.items.map((item, idx) => {
    const alloc = allocations.find((a) => a.productionOrder.id === item.id);
    const actualQuantity = alloc?.productionOrder.actualYield
      ? Number(alloc.productionOrder.actualYield)
      : undefined;
    const variance = actualQuantity !== undefined ? actualQuantity - Number(item.targetQuantity) : undefined;
    const variancePercentage = variance !== undefined && Number(item.targetQuantity) > 0
      ? (variance / Number(item.targetQuantity)) * 100
      : undefined;

    return {
      itemNumber: idx + 1,
      product: item.bom.finishedSku?.name || 'Unknown',
      targetQuantity: Number(item.targetQuantity),
      actualQuantity,
      variance,
      variancePercentage,
      status: actualQuantity !== undefined
        ? Math.abs(variancePercentage || 0) <= 5 ? 'completed' : 'completed_with_variance'
        : 'pending',
    };
  });

  return {
    reconciliation,
    itemDetails,
    plan: reconciliation.productionPlan,
  };
}

/**
 * Verify/approve reconciliation
 */
export async function verifyReconciliation(reconciliationId: string, supervisorId: string, notes?: string) {
  const reconciliation = await prisma.dailyProductionReconciliation.findUnique({
    where: { id: reconciliationId },
  });
  if (!reconciliation) throw new Error(`Reconciliation ${reconciliationId} not found`);
  if (reconciliation.status !== 'PENDING') {
    throw new Error(`Cannot verify reconciliation in ${reconciliation.status} status`);
  }

  const updated = await prisma.dailyProductionReconciliation.update({
    where: { id: reconciliationId },
    data: {
      status: 'VERIFIED',
      verifiedAt: new Date(),
      discrepancyNotes: notes || reconciliation.discrepancyNotes,
    },
    include: {
      productionPlan: true,
      supervisor: { select: { fullName: true } },
    },
  });

  // Log activity
  await userActivityLogger.logActivity({
    userId: supervisorId,
    activityType: 'APPROVE',
    module: 'production',
    description: 'Verified daily production reconciliation',
    entityType: 'DailyProductionReconciliation',
    entityId: reconciliationId,
    details: {
      status: 'VERIFIED',
      notes,
    },
  });

  return updated;
}

/**
 * Flag discrepancy in reconciliation
 */
export async function flagDiscrepancy(
  reconciliationId: string,
  supervisorId: string,
  issue: string,
  potentialCause?: string,
  recommendedAction?: string
) {
  const reconciliation = await prisma.dailyProductionReconciliation.findUnique({
    where: { id: reconciliationId },
  });
  if (!reconciliation) throw new Error(`Reconciliation ${reconciliationId} not found`);

  const flaggedNotes = [
    `FLAGGED: ${issue}`,
    potentialCause ? `Potential Cause: ${potentialCause}` : '',
    recommendedAction ? `Recommended Action: ${recommendedAction}` : '',
    reconciliation.discrepancyNotes || '',
  ]
    .filter(Boolean)
    .join('\n');

  const updated = await prisma.dailyProductionReconciliation.update({
    where: { id: reconciliationId },
    data: {
      status: 'FLAGGED',
      discrepancyNotes: flaggedNotes,
    },
    include: {
      productionPlan: true,
      supervisor: { select: { fullName: true } },
    },
  });

  // Log activity
  await userActivityLogger.logActivity({
    userId: supervisorId,
    activityType: 'UPDATE',
    module: 'production',
    description: 'Flagged discrepancy in production reconciliation',
    entityType: 'DailyProductionReconciliation',
    entityId: reconciliationId,
    details: {
      status: 'FLAGGED',
      issue,
      potentialCause,
      recommendedAction,
    },
  });

  return updated;
}

/**
 * Get reconciliation history for a plan
 */
export async function getReconciliationHistory(productionPlanId: string, limit: number = 30) {
  const reconciliations = await prisma.dailyProductionReconciliation.findMany({
    where: { productionPlanId },
    include: {
      supervisor: { select: { fullName: true } },
    },
    orderBy: { reconciliationDate: 'desc' },
    take: limit,
  });

  return reconciliations;
}

/**
 * Get reconciliation statistics across all plans for a date range
 */
export async function getReconciliationStatistics(startDate: Date, endDate: Date) {
  const reconciliations = await prisma.dailyProductionReconciliation.findMany({
    where: {
      reconciliationDate: {
        gte: startDate,
        lte: endDate,
      },
    },
  });

  let totalReconciliations = reconciliations.length;
  let verifiedCount = 0;
  let flaggedCount = 0;
  let totalVariance = 0;
  let totalVarianceCount = 0;

  for (const recon of reconciliations) {
    if (recon.status === 'VERIFIED') verifiedCount++;
    if (recon.status === 'FLAGGED') flaggedCount++;
    if (Math.abs(Number(recon.variancePercentage)) > 5) {
      totalVariance += Number(recon.variancePercentage);
      totalVarianceCount++;
    }
  }

  const avgVarianceAboveThreshold = totalVarianceCount > 0 ? totalVariance / totalVarianceCount : 0;

  return {
    totalReconciliations,
    verifiedCount,
    flaggedCount,
    verificationRate: totalReconciliations > 0 ? (verifiedCount / totalReconciliations) * 100 : 0,
    flagRate: totalReconciliations > 0 ? (flaggedCount / totalReconciliations) * 100 : 0,
    avgVarianceAboveThreshold: Math.round(avgVarianceAboveThreshold * 100) / 100,
  };
}

/**
 * Get reconciliations for a specific date
 */
export async function getReconciliationsByDate(date: Date) {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const reconciliations = await prisma.dailyProductionReconciliation.findMany({
    where: {
      reconciliationDate: {
        gte: startOfDay,
        lte: endOfDay,
      },
    },
    include: {
      productionPlan: { select: { planNumber: true } },
      supervisor: { select: { fullName: true } },
    },
    orderBy: { reconciliationDate: 'desc' },
  });

  return reconciliations;
}
