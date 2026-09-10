import { prisma } from '../lib/db.js';
import * as userActivityLogger from './userActivityLogger.js';

/**
 * Batch Machine Allocation Service
 * Manages runtime allocation of production orders/batches to machines
 * Tracks scheduled vs actual production times and links to batch numbers
 */

export interface AllocateBatchOptions {
  productionPlanItemId: string;
  productionOrderId: string;
  machineId: string;
  supervisorId: string;
  notes?: string;
  scheduledStartTime?: Date;
  scheduledEndTime?: Date;
}

/**
 * Allocate a batch (production order) to a specific machine
 */
export async function allocateBatchToMachine(options: AllocateBatchOptions) {
  const {
    productionPlanItemId,
    productionOrderId,
    machineId,
    supervisorId,
    notes,
    scheduledStartTime,
    scheduledEndTime,
  } = options;

  // Validate production order exists
  const order = await prisma.productionOrder.findUnique({
    where: { id: productionOrderId },
    include: { bom: { include: { finishedSku: { select: { name: true } } } } },
  });
  if (!order) throw new Error(`Production order ${productionOrderId} not found`);

  // Validate plan item exists
  const planItem = await prisma.productionPlanItem.findUnique({
    where: { id: productionPlanItemId },
    include: { bom: true, productionPlan: true },
  });
  if (!planItem) throw new Error(`Production plan item ${productionPlanItemId} not found`);

  // Validate machine exists
  const machine = await prisma.machine.findUnique({
    where: { id: machineId },
  });
  if (!machine) throw new Error(`Machine ${machineId} not found`);

  // Create allocation
  const allocation = await prisma.batchMachineAllocation.create({
    data: {
      productionPlanItemId,
      productionOrderId,
      machineId,
      supervisorId,
      notes,
      scheduledStartTime,
      scheduledEndTime,
      status: 'ALLOCATED',
    },
    include: {
      productionOrder: { include: { bom: true } },
      machine: true,
      planItem: true,
      supervisor: { select: { id: true, fullName: true } },
    },
  });

  // Log activity
  await userActivityLogger.logActivity({
    userId: supervisorId,
    activityType: 'CREATE',
    module: 'production',
    description: `Allocated batch to machine ${machine.name}`,
    entityType: 'BatchMachineAllocation',
    entityId: allocation.id,
    details: {
      productionOrderId,
      machineId,
      scheduledStartTime,
      scheduledEndTime,
    },
  });

  return allocation;
}

/**
 * Get machine workload for a given date
 */
export async function getMachineWorkload(machineId: string, date: Date) {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const allocations = await prisma.batchMachineAllocation.findMany({
    where: {
      machineId,
      OR: [
        { scheduledStartTime: { gte: startOfDay, lte: endOfDay } },
        { actualStartTime: { gte: startOfDay, lte: endOfDay } },
      ],
    },
    include: {
      productionOrder: {
        include: { bom: { include: { finishedSku: { select: { name: true } } } } },
      },
      machine: true,
    },
    orderBy: { scheduledStartTime: 'asc' },
  });

  return allocations.map((alloc) => ({
    id: alloc.id,
    batchNumber: alloc.batchNumber || 'TBD',
    product: alloc.productionOrder.bom.finishedSku?.name || 'Unknown',
    targetQuantity: alloc.productionOrder.targetQuantity,
    scheduledStartTime: alloc.scheduledStartTime,
    scheduledEndTime: alloc.scheduledEndTime,
    actualStartTime: alloc.actualStartTime,
    actualEndTime: alloc.actualEndTime,
    status: alloc.status,
  }));
}

/**
 * Start batch production (confirm production started on machine)
 */
export async function startBatchProduction(
  allocationId: string,
  supervisorId: string,
  actualStartTime?: Date
) {
  const allocation = await prisma.batchMachineAllocation.findUnique({
    where: { id: allocationId },
    include: { productionOrder: { include: { bom: true } }, machine: true },
  });
  if (!allocation) throw new Error(`Allocation ${allocationId} not found`);
  if (allocation.status !== 'ALLOCATED' && allocation.status !== 'SCHEDULED') {
    throw new Error(`Cannot start production for allocation in ${allocation.status} status`);
  }

  const updated = await prisma.batchMachineAllocation.update({
    where: { id: allocationId },
    data: {
      status: 'IN_PROGRESS',
      actualStartTime: actualStartTime || new Date(),
    },
    include: {
      productionOrder: { include: { bom: true } },
      machine: true,
      supervisor: { select: { fullName: true } },
    },
  });

  // Log activity
  await userActivityLogger.logActivity({
    userId: supervisorId,
    activityType: 'UPDATE',
    module: 'production',
    description: `Started batch production on ${allocation.machine.name}`,
    entityType: 'BatchMachineAllocation',
    entityId: allocationId,
    details: {
      status: 'IN_PROGRESS',
      actualStartTime: updated.actualStartTime,
    },
  });

  return updated;
}

/**
 * Complete batch production (confirm production finished, store batch number)
 */
export async function completeBatchProduction(
  allocationId: string,
  supervisorId: string,
  batchNumber?: string,
  actualEndTime?: Date
) {
  const allocation = await prisma.batchMachineAllocation.findUnique({
    where: { id: allocationId },
    include: { productionOrder: true, machine: true },
  });
  if (!allocation) throw new Error(`Allocation ${allocationId} not found`);
  if (allocation.status !== 'IN_PROGRESS') {
    throw new Error(`Cannot complete allocation in ${allocation.status} status`);
  }

  const updated = await prisma.batchMachineAllocation.update({
    where: { id: allocationId },
    data: {
      status: 'COMPLETED',
      actualEndTime: actualEndTime || new Date(),
      batchNumber,
    },
    include: {
      productionOrder: { include: { bom: true } },
      machine: true,
      supervisor: { select: { fullName: true } },
    },
  });

  // Log activity
  await userActivityLogger.logActivity({
    userId: supervisorId,
    activityType: 'UPDATE',
    module: 'production',
    description: `Completed batch production on ${allocation.machine.name}`,
    entityType: 'BatchMachineAllocation',
    entityId: allocationId,
    details: {
      status: 'COMPLETED',
      batchNumber,
      actualEndTime: updated.actualEndTime,
    },
  });

  return updated;
}

/**
 * Get all allocations for a production plan item
 */
export async function getPlanItemAllocations(planItemId: string) {
  const allocations = await prisma.batchMachineAllocation.findMany({
    where: { productionPlanItemId: planItemId },
    include: {
      machine: true,
      productionOrder: { include: { bom: { include: { finishedSku: true } } } },
      supervisor: { select: { id: true, fullName: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return allocations;
}

/**
 * Get supervisor's daily allocations
 */
export async function getSupervisorDailyAllocations(supervisorId: string, date: Date) {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const allocations = await prisma.batchMachineAllocation.findMany({
    where: {
      supervisorId,
      createdAt: { gte: startOfDay, lte: endOfDay },
    },
    include: {
      machine: true,
      productionOrder: { include: { bom: { include: { finishedSku: true } } } },
      planItem: { include: { bom: true } },
    },
    orderBy: { scheduledStartTime: 'asc' },
  });

  return allocations;
}

/**
 * Reallocate batch to a different machine (only if not yet started)
 */
export async function reallocateBatchToMachine(
  allocationId: string,
  newMachineId: string,
  supervisorId: string
) {
  const allocation = await prisma.batchMachineAllocation.findUnique({
    where: { id: allocationId },
  });
  if (!allocation) throw new Error(`Allocation ${allocationId} not found`);
  if (allocation.status !== 'ALLOCATED') {
    throw new Error(`Can only reallocate allocations in ALLOCATED status, current: ${allocation.status}`);
  }

  // Validate new machine
  const machine = await prisma.machine.findUnique({
    where: { id: newMachineId },
  });
  if (!machine) throw new Error(`Machine ${newMachineId} not found`);

  const updated = await prisma.batchMachineAllocation.update({
    where: { id: allocationId },
    data: {
      machineId: newMachineId,
    },
    include: {
      machine: true,
      productionOrder: { include: { bom: true } },
    },
  });

  // Log activity
  await userActivityLogger.logActivity({
    userId: supervisorId,
    activityType: 'UPDATE',
    module: 'production',
    description: `Reallocated batch to machine ${machine.name}`,
    entityType: 'BatchMachineAllocation',
    entityId: allocationId,
    details: {
      newMachineId,
      previousMachineId: allocation.machineId,
    },
  });

  return updated;
}

/**
 * Get detailed allocation with all related info
 */
export async function getAllocationDetails(allocationId: string) {
  const allocation = await prisma.batchMachineAllocation.findUnique({
    where: { id: allocationId },
    include: {
      machine: true,
      productionOrder: {
        include: {
          bom: { include: { finishedSku: true, ingredients: true } },
          productionIngredients: {
            include: {
              material: true,
              batchLot: true,
            },
          },
        },
      },
      planItem: { include: { bom: true } },
      supervisor: { select: { id: true, fullName: true, email: true } },
    },
  });

  if (!allocation) return null;

  return {
    ...allocation,
    duration: allocation.actualStartTime && allocation.actualEndTime
      ? Math.round((allocation.actualEndTime.getTime() - allocation.actualStartTime.getTime()) / 1000 / 60) // minutes
      : null,
  };
}

/**
 * Get all allocations for a plan
 */
export async function getPlanAllocations(productionPlanId: string) {
  const planItems = await prisma.productionPlanItem.findMany({
    where: { productionPlanId },
  });

  const itemIds = planItems.map((item) => item.id);

  const allocations = await prisma.batchMachineAllocation.findMany({
    where: {
      productionPlanItemId: { in: itemIds },
    },
    include: {
      machine: true,
      productionOrder: { include: { bom: { include: { finishedSku: true } } } },
      planItem: true,
      supervisor: { select: { fullName: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return allocations;
}
