import { prisma } from '../lib/db.js';
import * as batchMachineAllocationService from './batchMachineAllocationService.js';
import * as dailyProductionReconciliationService from './dailyProductionReconciliationService.js';

/**
 * Supervisor Production Service
 * Coordination service that combines batch allocation and reconciliation workflows
 * Provides high-level dashboard and execution status functions
 */

/**
 * Get supervisor dashboard data
 */
export async function getSupervisorDashboard(supervisorId: string, date: Date) {
  // Get active production plans
  const activePlans = await prisma.productionPlan.findMany({
    where: {
      status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
    },
    include: {
      items: true,
      createdBy: { select: { fullName: true } },
    },
    orderBy: { scheduledFor: 'asc' },
  });

  // Get supervisor's allocations for today
  const todaysAllocations = await batchMachineAllocationService.getSupervisorDailyAllocations(supervisorId, date);

  // Get today's reconciliation if exists
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const todaysReconciliation = await prisma.dailyProductionReconciliation.findFirst({
    where: {
      supervisorId,
      reconciliationDate: {
        gte: startOfDay,
        lte: endOfDay,
      },
    },
  });

  // Get execution status for each active plan
  const planStatus = await Promise.all(
    activePlans.map((plan) => getPlanExecutionStatus(plan.id))
  );

  return {
    activePlans: activePlans.map((plan, idx) => ({
      ...plan,
      status: planStatus[idx],
    })),
    todaysAllocations: todaysAllocations.map((alloc) => ({
      id: alloc.id,
      machine: alloc.machine.name,
      product: alloc.productionOrder.bom.finishedSku?.name || 'Unknown',
      targetQuantity: alloc.productionOrder.targetQuantity,
      scheduledStartTime: alloc.scheduledStartTime,
      scheduledEndTime: alloc.scheduledEndTime,
      status: alloc.status,
      batchNumber: alloc.batchNumber,
    })),
    todaysReconciliation: todaysReconciliation ? {
      id: todaysReconciliation.id,
      plannedQuantity: todaysReconciliation.plannedTotalQuantity,
      actualQuantity: todaysReconciliation.actualTotalQuantity,
      variance: todaysReconciliation.quantityVariance,
      variancePercentage: todaysReconciliation.variancePercentage,
      status: todaysReconciliation.status,
    } : null,
  };
}

/**
 * Get execution status of a production plan
 */
export async function getPlanExecutionStatus(productionPlanId: string) {
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

  // Get all allocations for this plan
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

  // Calculate totals
  const totalItems = plan.items.length;
  let plannedTotalQty = 0;
  for (const item of plan.items) {
    plannedTotalQty += Number(item.targetQuantity);
  }

  // Allocations status
  const allocatedCount = allocations.filter((a) => a.status !== 'COMPLETED').length;
  const completedCount = allocations.filter((a) => a.status === 'COMPLETED').length;
  const inProgressCount = allocations.filter((a) => a.status === 'IN_PROGRESS').length;

  // Actual quantities
  let actualTotalQty = 0;
  for (const alloc of allocations) {
    if (alloc.status === 'COMPLETED' && alloc.productionOrder.actualYield) {
      actualTotalQty += Number(alloc.productionOrder.actualYield);
    }
  }

  const completionPercentage = totalItems > 0 ? (completedCount / totalItems) * 100 : 0;
  const variance = actualTotalQty - plannedTotalQty;
  const variancePercentage = plannedTotalQty > 0 ? (variance / plannedTotalQty) * 100 : 0;

  return {
    totalItems,
    plannedTotalQty,
    actualTotalQty,
    completedCount,
    inProgressCount,
    allocatedCount,
    completionPercentage: Math.round(completionPercentage),
    variance,
    variancePercentage: Math.round(variancePercentage * 100) / 100,
    status: plan.status,
  };
}

/**
 * Get machine workload for a specific date
 */
export async function getMachineSchedule(machineId: string, date: Date) {
  return await batchMachineAllocationService.getMachineWorkload(machineId, date);
}

/**
 * Get all machines with their daily workloads
 */
export async function getAllMachinesSchedule(date: Date) {
  const machines = await prisma.machine.findMany({
    where: { status: 'ACTIVE' },
    include: { batchMachineAllocations: { where: {} } }, // Will filter in loop
  });

  const schedules = await Promise.all(
    machines.map(async (machine) => {
      const workload = await batchMachineAllocationService.getMachineWorkload(machine.id, date);
      return {
        machine,
        workload,
      };
    })
  );

  return schedules;
}

/**
 * Get supervisor's KPI metrics
 */
export async function getSupervisorMetrics(supervisorId: string, days: number = 30) {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);

  // Get all allocations by this supervisor
  const allocations = await prisma.batchMachineAllocation.findMany({
    where: {
      supervisorId,
      createdAt: { gte: sinceDate },
    },
    include: {
      productionOrder: true,
    },
  });

  // Get all reconciliations by this supervisor
  const reconciliations = await prisma.dailyProductionReconciliation.findMany({
    where: {
      supervisorId,
      createdAt: { gte: sinceDate },
    },
  });

  // Calculate metrics
  const totalAllocations = allocations.length;
  const completedAllocations = allocations.filter((a) => a.status === 'COMPLETED').length;
  const allocationCompletionRate = totalAllocations > 0 ? (completedAllocations / totalAllocations) * 100 : 0;

  let totalProductionTime = 0;
  let productionTimeCount = 0;
  for (const alloc of allocations) {
    if (alloc.actualStartTime && alloc.actualEndTime) {
      const duration = alloc.actualEndTime.getTime() - alloc.actualStartTime.getTime();
      totalProductionTime += duration;
      productionTimeCount++;
    }
  }
  const avgProductionTimeHours = productionTimeCount > 0 ? totalProductionTime / productionTimeCount / 1000 / 60 / 60 : 0;

  // Reconciliation metrics
  const totalReconciliations = reconciliations.length;
  const verifiedReconciliations = reconciliations.filter((r) => r.status === 'VERIFIED').length;
  const flaggedReconciliations = reconciliations.filter((r) => r.status === 'FLAGGED').length;
  const reconciliationAccuracy = totalReconciliations > 0 ? (verifiedReconciliations / totalReconciliations) * 100 : 0;

  // Variance analysis
  let totalVariance = 0;
  let significantVarianceCount = 0;
  for (const recon of reconciliations) {
    totalVariance += recon.variancePercentage;
    if (Math.abs(recon.variancePercentage) > 5) significantVarianceCount++;
  }
  const avgVariancePercentage = totalReconciliations > 0 ? totalVariance / totalReconciliations : 0;

  return {
    period: `Last ${days} days`,
    allocations: {
      total: totalAllocations,
      completed: completedAllocations,
      completionRate: Math.round(allocationCompletionRate),
      avgProductionTimeHours: Math.round(avgProductionTimeHours * 100) / 100,
    },
    reconciliations: {
      total: totalReconciliations,
      verified: verifiedReconciliations,
      flagged: flaggedReconciliations,
      verificationRate: Math.round(reconciliationAccuracy),
    },
    variance: {
      avgVariancePercentage: Math.round(avgVariancePercentage * 100) / 100,
      significantVarianceCount,
      significantVarianceRate: totalReconciliations > 0 ? Math.round((significantVarianceCount / totalReconciliations) * 100) : 0,
    },
  };
}

/**
 * Get summary report for a production plan
 */
export async function getPlanSummaryReport(productionPlanId: string) {
  const plan = await prisma.productionPlan.findUnique({
    where: { id: productionPlanId },
    include: {
      items: {
        include: {
          bom: { include: { finishedSku: true } },
        },
      },
      reconciliations: {
        orderBy: { reconciliationDate: 'desc' },
      },
    },
  });

  if (!plan) throw new Error(`Production plan ${productionPlanId} not found`);

  const allocations = await prisma.batchMachineAllocation.findMany({
    where: {
      planItem: {
        productionPlanId,
      },
    },
    include: {
      machine: true,
      productionOrder: true,
      supervisor: { select: { fullName: true } },
    },
  });

  // Item-by-item summary
  const itemSummaries = plan.items.map((item, idx) => {
    const itemAllocations = allocations.filter((a) => a.productionOrder.id === item.id);
    const completedAllocations = itemAllocations.filter((a) => a.status === 'COMPLETED');
    const totalActualYield = completedAllocations.reduce((sum, a) => sum + Number(a.productionOrder.actualYield || 0), 0);
    const variance = totalActualYield - Number(item.targetQuantity);

    return {
      itemNumber: idx + 1,
      product: item.bom.finishedSku?.name || 'Unknown',
      targetQuantity: Number(item.targetQuantity),
      actualQuantity: totalActualYield,
      variance,
      variancePercentage: Number(item.targetQuantity) > 0 ? (variance / Number(item.targetQuantity)) * 100 : 0,
      allocations: itemAllocations.length,
      completedAllocations: completedAllocations.length,
      machines: [...new Set(itemAllocations.map((a) => a.machine.name))],
    };
  });

  // Overall summary
  const totalPlanned = itemSummaries.reduce((sum, item) => sum + item.targetQuantity, 0);
  const totalActual = itemSummaries.reduce((sum, item) => sum + item.actualQuantity, 0);
  const totalVariance = totalActual - totalPlanned;

  return {
    plan: {
      id: plan.id,
      planNumber: plan.planNumber,
      status: plan.status,
      scheduledFor: plan.scheduledFor,
      startedAt: plan.startedAt,
      completedAt: plan.completedAt,
    },
    summary: {
      totalItems: plan.items.length,
      totalPlannedQuantity: totalPlanned,
      totalActualQuantity: totalActual,
      totalVariance,
      variancePercentage: totalPlanned > 0 ? (totalVariance / totalPlanned) * 100 : 0,
      completionPercentage: itemSummaries.filter((i) => i.completedAllocations > 0).length / plan.items.length * 100,
    },
    itemSummaries,
    allocations: allocations.length,
    completedAllocations: allocations.filter((a) => a.status === 'COMPLETED').length,
    lastReconciliation: plan.reconciliations.length > 0 ? plan.reconciliations[0] : null,
  };
}
