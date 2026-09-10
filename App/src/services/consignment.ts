import { prisma } from '../lib/db';
import { ConsignmentStatus } from '@prisma/client';

/**
 * Consignment Service
 * Manages warehouse stocking through consignments (grouped shipments)
 */

// ============================================================================
// Core CRUD Operations
// ============================================================================

/**
 * Create a new consignment
 */
export async function createConsignment(data: {
  supplierId: string;
  warehouseId: string;
  createdById: string;
  poNumbers?: string;
  shipDate?: Date;
  expectedDelivery?: Date;
}) {
  const consignmentNumber = `CSN-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

  const consignment = await prisma.consignment.create({
    data: {
      consignmentNumber,
      supplierId: data.supplierId,
      warehouseId: data.warehouseId,
      createdById: data.createdById,
      status: ConsignmentStatus.DRAFT,
      poNumbers: data.poNumbers,
      shipDate: data.shipDate,
      expectedDelivery: data.expectedDelivery,
    },
    include: {
      supplier: true,
      warehouse: true,
      createdBy: true,
      items: {
        include: {
          material: true,
        },
      },
    },
  });

  return consignment;
}

/**
 * Get all consignments with optional filtering
 */
export async function getConsignments(filters?: {
  supplierId?: string;
  warehouseId?: string;
  status?: ConsignmentStatus;
  skip?: number;
  take?: number;
}) {
  const consignments = await prisma.consignment.findMany({
    where: {
      supplierId: filters?.supplierId,
      warehouseId: filters?.warehouseId,
      status: filters?.status,
    },
    include: {
      supplier: true,
      warehouse: true,
      createdBy: true,
      receivedBy: true,
      items: {
        include: {
          material: true,
        },
      },
    },
    skip: filters?.skip,
    take: filters?.take,
    orderBy: { createdAt: 'desc' },
  });

  return consignments;
}

/**
 * Get a single consignment by ID
 */
export async function getConsignment(id: string) {
  const consignment = await prisma.consignment.findUniqueOrThrow({
    where: { id },
    include: {
      supplier: true,
      warehouse: true,
      createdBy: true,
      receivedBy: true,
      items: {
        include: {
          material: true,
          distributions: {
            include: {
              bin: {
                include: {
                  zone: true,
                },
              },
              distributedBy: true,
            },
          },
        },
      },
      distributions: {
        include: {
          bin: true,
          distributedBy: true,
        },
      },
    },
  });

  return consignment;
}

// ============================================================================
// Item Management
// ============================================================================

/**
 * Add material item to consignment
 */
export async function addItemToConsignment(data: {
  consignmentId: string;
  materialId: string;
  quantity: number;
  unitOfMeasure: string;
}) {
  // Verify consignment exists and is in DRAFT state
  const consignment = await prisma.consignment.findUniqueOrThrow({
    where: { id: data.consignmentId },
  });

  if (consignment.status !== ConsignmentStatus.DRAFT) {
    throw new Error(`Cannot add items to consignment in ${consignment.status} status`);
  }

  // Verify material exists
  await prisma.material.findUniqueOrThrow({
    where: { id: data.materialId },
  });

  const item = await prisma.consignmentItem.create({
    data: {
      consignmentId: data.consignmentId,
      materialId: data.materialId,
      quantity: data.quantity,
      unitOfMeasure: data.unitOfMeasure,
      distributedQty: 0,
    },
    include: {
      material: true,
      consignment: true,
    },
  });

  return item;
}

/**
 * Remove item from consignment
 */
export async function removeItemFromConsignment(itemId: string) {
  const item = await prisma.consignmentItem.findUniqueOrThrow({
    where: { id: itemId },
    include: { consignment: true },
  });

  if (item.consignment.status !== ConsignmentStatus.DRAFT) {
    throw new Error(`Cannot remove items from consignment in ${item.consignment.status} status`);
  }

  // Delete distributions associated with this item
  await prisma.consignmentDistribution.deleteMany({
    where: { consignmentItemId: itemId },
  });

  const deleted = await prisma.consignmentItem.delete({
    where: { id: itemId },
  });

  return deleted;
}

/**
 * Update item quantity in consignment
 */
export async function updateConsignmentItem(data: {
  itemId: string;
  quantity: number;
  unitOfMeasure: string;
}) {
  const item = await prisma.consignmentItem.findUniqueOrThrow({
    where: { id: data.itemId },
    include: { consignment: true },
  });

  if (item.consignment.status !== ConsignmentStatus.DRAFT) {
    throw new Error(`Cannot update items in consignment in ${item.consignment.status} status`);
  }

  const updated = await prisma.consignmentItem.update({
    where: { id: data.itemId },
    data: {
      quantity: data.quantity,
      unitOfMeasure: data.unitOfMeasure,
    },
    include: {
      material: true,
    },
  });

  return updated;
}

// ============================================================================
// Status Transitions
// ============================================================================

/**
 * Mark consignment as ready for shipment
 */
export async function markReadyForShipment(data: {
  consignmentId: string;
  shipDate: Date;
  expectedDelivery: Date;
}) {
  const consignment = await prisma.consignment.findUniqueOrThrow({
    where: { id: data.consignmentId },
  });

  if (consignment.status !== ConsignmentStatus.DRAFT) {
    throw new Error(`Can only transition from DRAFT to READY_FOR_SHIPMENT, current status: ${consignment.status}`);
  }

  // Verify consignment has items
  const itemCount = await prisma.consignmentItem.count({
    where: { consignmentId: data.consignmentId },
  });

  if (itemCount === 0) {
    throw new Error('Cannot mark consignment ready without items');
  }

  const updated = await prisma.consignment.update({
    where: { id: data.consignmentId },
    data: {
      status: ConsignmentStatus.READY_FOR_SHIPMENT,
      shipDate: data.shipDate,
      expectedDelivery: data.expectedDelivery,
    },
    include: {
      supplier: true,
      warehouse: true,
      items: true,
    },
  });

  return updated;
}

/**
 * Mark consignment as in transit
 */
export async function markInTransit(consignmentId: string) {
  const consignment = await prisma.consignment.findUniqueOrThrow({
    where: { id: consignmentId },
  });

  if (consignment.status !== ConsignmentStatus.READY_FOR_SHIPMENT) {
    throw new Error(`Can only transition from READY_FOR_SHIPMENT to IN_TRANSIT, current status: ${consignment.status}`);
  }

  const updated = await prisma.consignment.update({
    where: { id: consignmentId },
    data: {
      status: ConsignmentStatus.IN_TRANSIT,
    },
    include: {
      supplier: true,
      warehouse: true,
    },
  });

  return updated;
}

/**
 * Receive consignment at warehouse
 */
export async function receiveConsignment(data: {
  consignmentId: string;
  receivedById: string;
}) {
  const consignment = await prisma.consignment.findUniqueOrThrow({
    where: { id: data.consignmentId },
  });

  if (consignment.status !== ConsignmentStatus.IN_TRANSIT) {
    throw new Error(`Can only receive consignments in IN_TRANSIT status, current status: ${consignment.status}`);
  }

  const updated = await prisma.consignment.update({
    where: { id: data.consignmentId },
    data: {
      status: ConsignmentStatus.RECEIVED,
      receivedAt: new Date(),
      receivedById: data.receivedById,
    },
    include: {
      supplier: true,
      warehouse: true,
      receivedBy: true,
      items: true,
    },
  });

  return updated;
}

// ============================================================================
// Distribution to Warehouse Bins
// ============================================================================

/**
 * Distribute consignment item to warehouse bin
 */
export async function distributeToWarehouseBin(data: {
  consignmentItemId: string;
  binId: string;
  quantity: number;
  distributedById: string;
}) {
  const item = await prisma.consignmentItem.findUniqueOrThrow({
    where: { id: data.consignmentItemId },
    include: { consignment: true },
  });

  // Quality Approval Check: Consignment must be QUALITY_APPROVED before distribution
  if (item.consignment.status !== ConsignmentStatus.QUALITY_APPROVED) {
    throw new Error(`Consignment requires QA approval before distribution. Current status: ${item.consignment.status}`);
  }

  // Verify bin exists
  await prisma.warehouseBin.findUniqueOrThrow({
    where: { id: data.binId },
  });

  // Check remaining quantity to distribute
  const remainingQty = Number(item.quantity) - Number(item.distributedQty);
  if (data.quantity > remainingQty) {
    throw new Error(`Cannot distribute ${data.quantity}, only ${remainingQty} remaining`);
  }

  // Create distribution record
  const distribution = await prisma.consignmentDistribution.create({
    data: {
      consignmentId: item.consignmentId,
      consignmentItemId: data.consignmentItemId,
      binId: data.binId,
      quantity: data.quantity,
      distributedById: data.distributedById,
      distributedAt: new Date(),
    },
    include: {
      bin: {
        include: {
          zone: true,
        },
      },
      distributedBy: true,
      consignmentItem: {
        include: {
          material: true,
        },
      },
    },
  });

  // Update distributed quantity on item
  const newDistributedQty = Number(item.distributedQty) + data.quantity;
  await prisma.consignmentItem.update({
    where: { id: data.consignmentItemId },
    data: {
      distributedQty: newDistributedQty,
    },
  });

  return distribution;
}

/**
 * Get all distributions for a consignment
 */
export async function getConsignmentDistributions(consignmentId: string) {
  const distributions = await prisma.consignmentDistribution.findMany({
    where: { consignmentId },
    include: {
      consignmentItem: {
        include: {
          material: true,
        },
      },
      bin: {
        include: {
          zone: true,
          warehouse: true,
        },
      },
      distributedBy: true,
    },
    orderBy: { distributedAt: 'desc' },
  });

  return distributions;
}

/**
 * Mark distribution complete and update inventory
 */
export async function markDistributionComplete(data: {
  distributionId: string;
  completedById: string;
}) {
  const distribution = await prisma.consignmentDistribution.findUniqueOrThrow({
    where: { id: data.distributionId },
    include: {
      consignmentItem: {
        include: {
          material: true,
        },
      },
      bin: {
        include: {
          warehouse: true,
        },
      },
      consignment: true,
    },
  });

  // Create inventory transaction for this distribution
  // This adds the material to warehouse inventory
  await prisma.inventoryTransaction.create({
    data: {
      materialId: distribution.consignmentItem.materialId,
      warehouseId: distribution.bin.warehouse.id,
      eventType: 'PO_RECEIPT',
      quantity: distribution.quantity,
      unitOfMeasure: distribution.consignmentItem.unitOfMeasure,
      referenceId: `CSN-${distribution.consignment.consignmentNumber}`,
      binId: distribution.binId,
      createdById: data.completedById,
    },
  });

  return distribution;
}

// ============================================================================
// Status Calculations
// ============================================================================

/**
 * Calculate distribution status for a consignment item
 */
export async function calculateItemDistributionStatus(itemId: string) {
  const item = await prisma.consignmentItem.findUniqueOrThrow({
    where: { id: itemId },
    include: {
      distributions: true,
    },
  });

  const totalDistributed = item.distributions.reduce(
    (sum, dist) => sum + Number(dist.quantity),
    0
  );

  if (totalDistributed === 0) {
    return {
      status: 'PENDING',
      distributed: totalDistributed,
      remaining: Number(item.quantity),
      percentage: 0,
    };
  }

  if (totalDistributed === Number(item.quantity)) {
    return {
      status: 'COMPLETED',
      distributed: totalDistributed,
      remaining: 0,
      percentage: 100,
    };
  }

  return {
    status: 'IN_PROGRESS',
    distributed: totalDistributed,
    remaining: Number(item.quantity) - totalDistributed,
    percentage: Math.round((totalDistributed / Number(item.quantity)) * 100),
  };
}

/**
 * Calculate overall distribution status for a consignment
 */
export async function calculateConsignmentDistributionStatus(consignmentId: string) {
  const items = await prisma.consignmentItem.findMany({
    where: { consignmentId },
    include: {
      distributions: true,
    },
  });

  if (items.length === 0) {
    return {
      status: 'EMPTY',
      itemsTotal: 0,
      itemsCompleted: 0,
      percentage: 0,
    };
  }

  let itemsCompleted = 0;
  let totalQtyToDistribute = 0;
  let totalDistributed = 0;

  for (const item of items) {
    totalQtyToDistribute += Number(item.quantity);
    const itemDistributed = item.distributions.reduce(
      (sum, dist) => sum + Number(dist.quantity),
      0
    );
    totalDistributed += itemDistributed;

    if (itemDistributed === Number(item.quantity)) {
      itemsCompleted++;
    }
  }

  const distributionPercentage = totalQtyToDistribute > 0
    ? Math.round((totalDistributed / totalQtyToDistribute) * 100)
    : 0;

  let status = 'PENDING';
  if (distributionPercentage > 0 && distributionPercentage < 100) {
    status = 'IN_PROGRESS';
  } else if (distributionPercentage === 100) {
    status = 'COMPLETED';
  }

  return {
    status,
    itemsTotal: items.length,
    itemsCompleted,
    totalQtyToDistribute,
    totalDistributed,
    percentage: distributionPercentage,
  };
}

/**
 * Mark consignment as fully distributed
 */
export async function markAsDistributed(consignmentId: string) {
  const consignment = await prisma.consignment.findUniqueOrThrow({
    where: { id: consignmentId },
  });

  const distributionStatus = await calculateConsignmentDistributionStatus(consignmentId);

  if (distributionStatus.percentage !== 100) {
    throw new Error(`Cannot mark as distributed, only ${distributionStatus.percentage}% distributed`);
  }

  const updated = await prisma.consignment.update({
    where: { id: consignmentId },
    data: {
      status: ConsignmentStatus.DISTRIBUTED,
      distributedAt: new Date(),
    },
    include: {
      items: true,
      distributions: true,
    },
  });

  return updated;
}

/**
 * Mark consignment as completed
 */
export async function markAsCompleted(consignmentId: string) {
  const consignment = await prisma.consignment.findUniqueOrThrow({
    where: { id: consignmentId },
  });

  if (consignment.status !== ConsignmentStatus.DISTRIBUTED) {
    throw new Error(`Can only complete DISTRIBUTED consignments, current status: ${consignment.status}`);
  }

  const updated = await prisma.consignment.update({
    where: { id: consignmentId },
    data: {
      status: ConsignmentStatus.COMPLETED,
    },
  });

  return updated;
}

/**
 * Delete a consignment and all related records
 * Only allows deletion of DRAFT, RECEIVED, or QUALITY_PENDING consignments
 */
export async function deleteConsignment(consignmentId: string) {
  const consignment = await prisma.consignment.findUnique({
    where: { id: consignmentId },
    include: {
      items: true,
      distributions: true,
      qualityApproval: { include: { checkItems: true } },
    },
  });

  if (!consignment) {
    throw new Error('Consignment not found');
  }

  // Prevent deletion of advanced statuses
  const blockedStatuses = [ConsignmentStatus.IN_TRANSIT, ConsignmentStatus.DISTRIBUTED, ConsignmentStatus.COMPLETED];
  if (blockedStatuses.includes(consignment.status as any)) {
    throw new Error(`Cannot delete consignments in ${consignment.status} status`);
  }

  // Delete in transaction
  await prisma.$transaction(async (tx) => {
    // 1. Delete quality approval check items
    if (consignment.qualityApproval) {
      await tx.qualityCheckItem.deleteMany({
        where: { qualityApprovalId: consignment.qualityApproval.id },
      });

      // 2. Delete quality approval record
      await tx.qualityApproval.delete({
        where: { id: consignment.qualityApproval.id },
      });
    }

    // 3. Delete consignment distributions
    await tx.consignmentDistribution.deleteMany({
      where: { consignmentId },
    });

    // 4. Delete consignment items
    await tx.consignmentItem.deleteMany({
      where: { consignmentId },
    });

    // 5. Delete the consignment
    await tx.consignment.delete({
      where: { id: consignmentId },
    });
  });

  return { success: true, message: 'Consignment deleted successfully' };
}
