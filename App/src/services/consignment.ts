import { prisma } from '../lib/db.js';
import { ConsignmentStatus, LedgerEventType } from '@prisma/client';
import { postLedgerEntry } from '../lib/ledger.js';
import { buildLotCode, buildYearCode, isValidSetNumber, nextSetNumber } from '../lib/lotCode.js';
import { recomputePurchaseOrderStatus } from './purchaseOrderStatus.js';

/**
 * Consignment Service
 * Manages warehouse stocking through consignments (grouped shipments)
 */

// ============================================================================
// Core CRUD Operations
// ============================================================================

/**
 * Create a consignment — this IS the receipt.
 *
 * The store officer opens a purchase order, ticks the lines that actually
 * arrived and enters how much of each came in. Saving the consignment:
 *   - records the received quantities (PO lines advance, the rest stays
 *     outstanding and shows up next time the same PO is opened),
 *   - posts the stock to the ledger,
 *   - creates the inbound lot and the QA inspection records.
 *
 * There is no separate "receive consignment" step afterwards.
 */
export async function createConsignment(data: {
  supplierId: string;
  warehouseId: string;
  createdById: string;
  poId: string;
  notes?: string | null;
  poNumbers?: string;
  shipDate?: Date;
  expectedDelivery?: Date;
  /** The single date this delivery was received. */
  receivedAt?: Date;
  items: Array<{
    poItemId?: string | null;
    materialId: string;
    quantity: number;
    unitOfMeasure: string;
    expiryDate?: string | Date | null;
    supplierBatchNumber?: string | null;
    /** Lot set number override (SOP lot code), when the officer supplied one. */
    setNumber?: number | string | null;
    /** Per-line destination warehouse; defaults to the consignment warehouse. */
    warehouseId?: string | null;
    unitCost?: number | string | null;
  }>;
}) {
  const consignmentNumber = `CSN-${Date.now()}-${Math.random().toString(36).slice(2, 11).toUpperCase()}`;
  const yearCode = buildYearCode();
  // One receipt date for the whole shipment — backdatable, and each revisit of
  // a partly delivered PO gets its own stamp.
  const receivedAt = data.receivedAt ?? new Date();

  return prisma.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.findUnique({
      where: { id: data.poId },
      include: { items: { include: { material: true } } },
    });

    if (!po) throw new Error('Purchase order not found');
    if (po.status === 'CLOSED') throw new Error('Purchase order is closed');
    if (po.supplierId !== data.supplierId) {
      throw new Error('The consignment supplier must match the purchase order supplier');
    }

    const supplier = await tx.supplier.findUniqueOrThrow({
      where: { id: data.supplierId },
      select: { id: true, name: true, vendorCode: true },
    });

    const items = data.items ?? [];
    if (items.length === 0) throw new Error('Select at least one material that arrived');

    // Quantities already committed to shipments that have not arrived yet are
    // still outstanding on the PO, so they cannot be received twice.
    const linkedPoItemIds = items.map((i) => i.poItemId).filter(Boolean) as string[];
    const alreadyConsigned = new Map<string, number>();
    if (linkedPoItemIds.length > 0) {
      const openLines = await tx.consignmentItem.findMany({
        where: {
          poItemId: { in: linkedPoItemIds },
          consignment: {
            status: { in: ['DRAFT', 'READY_FOR_SHIPMENT', 'IN_TRANSIT', 'PARTIALLY_RECEIVED'] },
          },
        },
        select: { poItemId: true, quantity: true, receivedQty: true },
      });
      for (const line of openLines) {
        if (!line.poItemId) continue;
        const open = Number(line.quantity) - Number(line.receivedQty);
        if (open <= 0) continue;
        alreadyConsigned.set(line.poItemId, (alreadyConsigned.get(line.poItemId) ?? 0) + open);
      }
    }

    for (const item of items) {
      if (!item.materialId || !item.quantity || Number(item.quantity) <= 0) {
        throw new Error('Each consignment line needs a material and a positive quantity');
      }
      const poItem = item.poItemId ? po.items.find((p) => p.id === item.poItemId) : null;
      if (!item.poItemId || !poItem) throw new Error('Each consignment line must come from a purchase order line');
      if (poItem.materialId !== item.materialId) {
        throw new Error('Consignment line material does not match the purchase order line');
      }
      const remaining = Number(poItem.quantity) - Number(poItem.receivedQty);
      const available = remaining - (alreadyConsigned.get(poItem.id) ?? 0);
      if (Number(item.quantity) > available) {
        throw new Error(
          `Only ${available} ${poItem.unitOfMeasure} is still outstanding on ${po.number} for ${poItem.material.name}`
        );
      }
    }

    // 1. The shipment itself. Everything on it has physically arrived, so it is
    //    recorded as received in the same step.
    const consignment = await tx.consignment.create({
      data: {
        consignmentNumber,
        supplierId: data.supplierId,
        warehouseId: data.warehouseId,
        createdById: data.createdById,
        poId: po.id,
        status: ConsignmentStatus.RECEIVED,
        poNumbers: data.poNumbers ?? po.number,
        shipDate: data.shipDate,
        expectedDelivery: data.expectedDelivery,
        receivedAt,
        receivedById: data.createdById,
      },
    });

    // 2. One GRN behind the shipment so the stock, lots and QA records have a
    //    single document to hang off.
    const grnNumber = `GRN-CSN-${Date.now().toString().slice(-8)}`;
    const receipt = await tx.goodsReceipt.create({
      data: {
        number: grnNumber,
        poId: po.id,
        consignmentId: consignment.id,
        supplierId: data.supplierId,
        source: 'CONSIGNMENT',
        receivedById: data.createdById,
        status: 'PENDING_QA',
        receivedAt,
        notes: data.notes?.trim()
          ? data.notes.trim()
          : `Received via Consignment: ${consignmentNumber}`,
      },
    });

    let lineIndex = 0;
    for (const item of items) {
      const poItem = po.items.find((p) => p.id === item.poItemId)!;
      const material = poItem.material;
      const quantity = Number(item.quantity);
      lineIndex += 1;

      // Lot code (SOP KIB/QCA/010). The officer may have supplied a set number;
      // otherwise the next one in sequence is used.
      const requestedSet = item.setNumber === undefined || item.setNumber === null || item.setNumber === ''
        ? null
        : Number(item.setNumber);
      if (requestedSet !== null && !isValidSetNumber(requestedSet)) {
        throw new Error('Set number must be a positive whole number');
      }
      const setNumber =
        requestedSet ??
        (await nextSetNumber(tx, {
          supplierId: data.supplierId,
          materialId: material.id,
          yearCode,
        }));
      const lotCode = buildLotCode({
        vendorCode: supplier.vendorCode,
        ingredientCode: material.traceabilityCode,
        setNumber,
        yearCode,
      });
      // Batch number is assigned by QA on inspection; the provisional reference
      // only keeps the lot identifiable until then.
      const batchNumber =
        lotCode ?? `PENDING-${consignmentNumber}-${String(lineIndex).padStart(2, '0')}`;

      const batchLot = await tx.batchLot.upsert({
        where: { materialId_batchNumber: { materialId: material.id, batchNumber } },
        update: {},
        create: {
          materialId: material.id,
          batchNumber,
          status: 'QUARANTINE',
          expiryDate: item.expiryDate ? new Date(item.expiryDate) : material.defaultExpiryDate,
          origin: 'INBOUND',
          lotCode,
          setNumber,
          vendorCode: supplier.vendorCode,
          ingredientCode: material.traceabilityCode,
          yearCode,
          supplierBatchNumber: item.supplierBatchNumber ? String(item.supplierBatchNumber).trim() : null,
          supplierId: data.supplierId,
        },
      });

      const consignmentItem = await tx.consignmentItem.create({
        data: {
          consignmentId: consignment.id,
          materialId: material.id,
          poItemId: poItem.id,
          quantity,
          receivedQty: quantity,
          unitOfMeasure: item.unitOfMeasure,
          distributedQty: 0,
        },
      });

      await tx.goodsReceiptItem.create({
        data: {
          grnId: receipt.id,
          materialId: material.id,
          batchLotId: batchLot.id,
          quantity,
          unitOfMeasure: item.unitOfMeasure,
          unitCost: Number(item.unitCost ?? poItem.unitCost),
        },
      });

      const lineWarehouseId = item.warehouseId || data.warehouseId;

      await postLedgerEntry(tx, {
        eventType: LedgerEventType.PO_RECEIPT,
        materialId: material.id,
        batchLotId: batchLot.id,
        warehouseId: lineWarehouseId,
        consignmentItemId: consignmentItem.id,
        quantity,
        unitOfMeasure: item.unitOfMeasure,
        referenceType: 'GRN',
        referenceId: receipt.id,
        createdById: data.createdById,
        notes: `GRN ${grnNumber} via Consignment ${consignmentNumber}`,
      });

      await tx.inspectionRecord.create({
        data: {
          inspectionType: 'GRN',
          materialId: material.id,
          batchLotId: batchLot.id,
          referenceId: receipt.id,
          result: 'PENDING',
        },
      });

      await tx.purchaseOrderItem.update({
        where: { id: poItem.id },
        data: { receivedQty: { increment: quantity } },
      });
    }

    await recomputePurchaseOrderStatus(tx, po.id);

    return tx.consignment.findUniqueOrThrow({
      where: { id: consignment.id },
      include: {
        supplier: true,
        warehouse: true,
        po: { select: { id: true, number: true, status: true } },
        createdBy: true,
        goodsReceipts: { select: { id: true, number: true, status: true } },
        items: {
          include: {
            material: true,
            poItem: { select: { id: true, quantity: true, receivedQty: true, unitCost: true } },
          },
        },
      },
    });
  });
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
      po: { select: { id: true, number: true, status: true } },
      createdBy: true,
      receivedBy: true,
      items: {
        include: {
          material: true,
          poItem: { select: { id: true, quantity: true, receivedQty: true, unitCost: true } },
        },
      },
      qualityApproval: {
        include: {
          checkItems: true,
          approvedBy: { select: { fullName: true } },
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
      po: { select: { id: true, number: true, status: true } },
      createdBy: true,
      receivedBy: true,
      items: {
        include: {
          material: true,
          poItem: { select: { id: true, quantity: true, receivedQty: true, unitCost: true } },
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
  poItemId?: string | null;
}) {
  // Verify consignment exists and is in DRAFT state
  const consignment = await prisma.consignment.findUniqueOrThrow({
    where: { id: data.consignmentId },
    include: { po: { include: { items: true } } },
  });

  if (consignment.status !== ConsignmentStatus.DRAFT) {
    throw new Error(`Cannot add items to consignment in ${consignment.status} status`);
  }

  // Verify material exists
  await prisma.material.findUniqueOrThrow({
    where: { id: data.materialId },
  });

  if (data.poItemId) {
    const poItem = consignment.po?.items.find((p) => p.id === data.poItemId);
    if (!poItem) throw new Error('Purchase order line not found on this consignment\'s PO');
    if (poItem.materialId !== data.materialId) {
      throw new Error('Consignment line material does not match the purchase order line');
    }
    const remaining = Number(poItem.quantity) - Number(poItem.receivedQty);
    if (Number(data.quantity) > remaining) {
      throw new Error(`Only ${remaining} ${poItem.unitOfMeasure} remaining on the purchase order for this material`);
    }
  }

  const item = await prisma.consignmentItem.create({
    data: {
      consignmentId: data.consignmentId,
      materialId: data.materialId,
      poItemId: data.poItemId ?? null,
      quantity: data.quantity,
      unitOfMeasure: data.unitOfMeasure,
      receivedQty: 0,
      distributedQty: 0,
    },
    include: {
      material: true,
      poItem: { select: { id: true, quantity: true, receivedQty: true, unitCost: true } },
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

  // Block distribution while a quantity change for this ingredient awaits
  // Head of QC approval — otherwise the wrong amount would reach stock.
  const pendingAdjustment = await prisma.quantityAdjustment.findFirst({
    where: { consignmentItemId: data.consignmentItemId, status: 'PENDING' },
  });
  if (pendingAdjustment) {
    throw new Error(
      'This ingredient has a quantity change awaiting Head of QC approval. Resolve it before distributing.'
    );
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
      consignment: { include: { supplier: { select: { id: true, name: true, vendorCode: true } } } },
    },
  });

  // Post to stock at most once per consignment ingredient. Consignment GRNs
  // already post the receipt, so this only acts as a fallback for consignments
  // handled without one — preventing the historical double-count.
  const alreadyPosted = await prisma.inventoryTransaction.aggregate({
    where: { consignmentItemId: distribution.consignmentItemId },
    _sum: { quantity: true },
  });

  if (Number(alreadyPosted._sum.quantity ?? 0) === 0) {
    // Same trail as a GRN receipt: a batch lot carrying its lot code, plus a QA
    // inspection. Without this the stock would land with no lot at all and be
    // unreachable from traceability.
    const material = distribution.consignmentItem.material;
    const supplier = distribution.consignment.supplier ?? null;
    const yearCode = buildYearCode();

    const setNumber = await nextSetNumber(prisma, {
      supplierId: supplier?.id ?? null,
      materialId: material.id,
      yearCode,
    });

    const lotCode = buildLotCode({
      vendorCode: supplier?.vendorCode ?? null,
      ingredientCode: material.traceabilityCode ?? null,
      setNumber,
      yearCode,
    });

    // Only reachable if the supplier / material codes are still missing, which
    // the master-data guards exist to prevent.
    const batchNumber =
      lotCode ??
      `CSN-${distribution.consignment.consignmentNumber}-${distribution.consignmentItemId.slice(0, 6)}`;

    const batchLot = await prisma.batchLot.upsert({
      where: { materialId_batchNumber: { materialId: material.id, batchNumber } },
      update: {},
      create: {
        materialId: material.id,
        batchNumber,
        origin: 'INBOUND',
        lotCode,
        setNumber,
        vendorCode: supplier?.vendorCode ?? null,
        ingredientCode: material.traceabilityCode ?? null,
        yearCode,
        supplierId: supplier?.id ?? null,
      },
    });

    await postLedgerEntry(prisma, {
      eventType: LedgerEventType.PO_RECEIPT,
      materialId: distribution.consignmentItem.materialId,
      batchLotId: batchLot.id,
      warehouseId: distribution.bin.warehouse.id,
      binId: distribution.binId,
      consignmentItemId: distribution.consignmentItemId,
      quantity: Number(distribution.quantity),
      unitOfMeasure: distribution.consignmentItem.unitOfMeasure,
      referenceType: 'CONSIGNMENT_DISTRIBUTION',
      referenceId: distribution.id,
      createdById: data.completedById,
      notes: `Distributed via consignment ${distribution.consignment.consignmentNumber}`,
    });

    await prisma.inspectionRecord.create({
      data: {
        inspectionType: 'GRN',
        materialId: material.id,
        batchLotId: batchLot.id,
        referenceId: distribution.id,
        result: 'PENDING',
      },
    });
  }

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
