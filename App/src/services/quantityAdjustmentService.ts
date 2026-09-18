/**
 * Quantity Adjustment Service
 *
 * QC inspects a consignment ingredient and may propose a corrected quantity
 * (shortage, damage, overage, recount...). The change is recorded as PENDING and
 * only HEAD_OF_QC can approve it. On approval the ingredient's quantity becomes
 * authoritative and — critically — only the portion *not already in the ledger*
 * is posted, so stock ends up reflecting the new number exactly once.
 */
import { prisma } from '../lib/db.js';
import { LedgerEventType } from '@prisma/client';
import { postLedgerEntry } from '../lib/ledger.js';
import { logActivity } from './userActivityLogger.js';

// Adjustments are only meaningful before the consignment is signed off.
const EDITABLE_CONSIGNMENT_STATUSES = [
  'DRAFT',
  'READY_FOR_SHIPMENT',
  'IN_TRANSIT',
  'RECEIVED',
  'QUALITY_PENDING',
];

const REASON_CODES = ['SHORTAGE', 'DAMAGE', 'OVERAGE', 'QUALITY_REJECT', 'RECOUNT'];

// Roles that may approve (Head of QC owns this; Super Admin as break-glass).
export const QUANTITY_APPROVER_ROLES = ['HEAD_OF_QC', 'SUPER_ADMIN'];

async function notifyUser(
  userId: string,
  data: { title: string; body: string; referenceId?: string; notificationType?: string }
) {
  try {
    await prisma.notification.create({
      data: {
        userId,
        type: 'APPROVAL',
        notificationType: data.notificationType ?? 'APPROVAL_PENDING',
        title: data.title,
        body: data.body,
        referenceId: data.referenceId,
        isActionable: true,
      },
    });
  } catch (error) {
    // Notifications must never break the workflow.
    console.error('Failed to create notification:', error);
  }
}

async function notifyRole(role: string, data: { title: string; body: string; referenceId?: string }) {
  const users = await prisma.user.findMany({ where: { role: role as never, isActive: true }, select: { id: true } });
  await Promise.all(users.map((u) => notifyUser(u.id, data)));
}

// ============================================================================
// PROPOSE (QC)
// ============================================================================

export async function proposeQuantityAdjustment(data: {
  consignmentItemId: string;
  newQuantity: number;
  reasonCode?: string;
  reason?: string;
  requestedById: string;
}) {
  const item = await prisma.consignmentItem.findUnique({
    where: { id: data.consignmentItemId },
    include: {
      consignment: { include: { qualityApproval: { include: { checkItems: true } } } },
      material: { select: { name: true, sku: true, unitOfMeasure: true } },
    },
  });

  if (!item) {
    throw new Error('Consignment item not found');
  }

  if (!EDITABLE_CONSIGNMENT_STATUSES.includes(item.consignment.status)) {
    throw new Error(
      `Cannot change quantities once the consignment is ${item.consignment.status}`
    );
  }

  const newQuantity = Number(data.newQuantity);
  const oldQuantity = Number(item.quantity);

  if (!Number.isFinite(newQuantity) || newQuantity <= 0) {
    throw new Error('New quantity must be greater than zero');
  }
  if (newQuantity === oldQuantity) {
    throw new Error('New quantity is the same as the current quantity');
  }
  if (newQuantity < Number(item.distributedQty)) {
    throw new Error(
      `New quantity cannot be below the already distributed quantity (${item.distributedQty})`
    );
  }
  if (data.reasonCode && !REASON_CODES.includes(data.reasonCode)) {
    throw new Error(`reasonCode must be one of: ${REASON_CODES.join(', ')}`);
  }

  // Do not allow back-to-back proposals for the same ingredient.
  const existingPending = await prisma.quantityAdjustment.findFirst({
    where: { consignmentItemId: data.consignmentItemId, status: 'PENDING' },
  });
  if (existingPending) {
    throw new Error('A quantity change for this ingredient is already awaiting approval');
  }

  // QC must have finished checking this ingredient before changing its quantity.
  const approval = item.consignment.qualityApproval;
  if (approval) {
    const checks = approval.checkItems.filter((c) => c.consignmentItemId === data.consignmentItemId);
    const outstanding = checks.filter((c) => c.status === 'PENDING' || !c.result);
    if (checks.length === 0 || outstanding.length > 0) {
      throw new Error(
        `Complete all quality checks for ${item.material.name} before changing its quantity`
      );
    }
  }

  const adjustment = await prisma.quantityAdjustment.create({
    data: {
      consignmentId: item.consignmentId,
      consignmentItemId: item.id,
      materialId: item.materialId,
      oldQuantity,
      newQuantity,
      difference: newQuantity - oldQuantity,
      reasonCode: data.reasonCode,
      reason: data.reason,
      requestedById: data.requestedById,
    },
    include: {
      material: { select: { name: true, sku: true } },
      requestedBy: { select: { fullName: true } },
    },
  });

  await notifyRole('HEAD_OF_QC', {
    title: `Quantity change awaiting approval — ${item.material.name}`,
    body: `${item.consignment.consignmentNumber}: ${oldQuantity} → ${newQuantity} ${item.unitOfMeasure} (${data.reasonCode ?? 'adjustment'})`,
    referenceId: adjustment.id,
  });

  await logActivity({
    userId: data.requestedById,
    activityType: 'UPDATE',
    module: 'qa',
    description: `Quantity change proposed for ${item.material.name} on ${item.consignment.consignmentNumber}: ${oldQuantity} → ${newQuantity}`,
    entityType: 'QuantityAdjustment',
    entityId: adjustment.id,
  });

  return adjustment;
}

// ============================================================================
// READ
// ============================================================================

export async function getPendingAdjustments(limit = 100) {
  return prisma.quantityAdjustment.findMany({
    where: { status: 'PENDING' },
    include: {
      material: { select: { id: true, name: true, sku: true, unitOfMeasure: true } },
      requestedBy: { select: { id: true, fullName: true, role: true } },
      consignment: { select: { id: true, consignmentNumber: true, status: true } },
      consignmentItem: { select: { id: true, distributedQty: true } },
    },
    orderBy: { requestedAt: 'asc' },
    take: limit,
  });
}

export async function getConsignmentAdjustments(consignmentId: string) {
  return prisma.quantityAdjustment.findMany({
    where: { consignmentId },
    include: {
      material: { select: { id: true, name: true, sku: true, unitOfMeasure: true } },
      requestedBy: { select: { id: true, fullName: true } },
      approvedBy: { select: { id: true, fullName: true } },
    },
    orderBy: { requestedAt: 'desc' },
  });
}

export async function getAdjustmentSummary(days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const adjustments = await prisma.quantityAdjustment.findMany({
    where: { requestedAt: { gte: since } },
  });

  const pending = adjustments.filter((a) => a.status === 'PENDING').length;
  const approved = adjustments.filter((a) => a.status === 'APPROVED').length;
  const rejected = adjustments.filter((a) => a.status === 'REJECTED').length;

  const totalShortfall = adjustments
    .filter((a) => a.status === 'APPROVED')
    .reduce((sum, a) => sum + (Number(a.difference) < 0 ? Number(a.difference) : 0), 0);

  const byReason: Record<string, number> = {};
  for (const a of adjustments) {
    const key = a.reasonCode ?? 'UNSPECIFIED';
    byReason[key] = (byReason[key] ?? 0) + 1;
  }

  return {
    period: { days, since },
    total: adjustments.length,
    status: { pending, approved, rejected },
    netApprovedChange: totalShortfall,
    byReason,
    reasonCodes: REASON_CODES,
  };
}

// ============================================================================
// APPROVE (HEAD_OF_QC / SUPER_ADMIN)
// ============================================================================

export async function approveQuantityAdjustment(adjustmentId: string, approvedById: string) {
  const existing = await prisma.quantityAdjustment.findUnique({
    where: { id: adjustmentId },
  });
  if (!existing) throw new Error('Quantity adjustment not found');
  if (existing.status !== 'PENDING') {
    throw new Error(`Cannot approve a quantity adjustment with status ${existing.status}`);
  }

  const result = await prisma.$transaction(async (tx) => {
    const adjustment = await tx.quantityAdjustment.findUniqueOrThrow({
      where: { id: adjustmentId },
      include: {
        consignmentItem: { include: { material: { select: { name: true } } } },
        consignment: { select: { id: true, consignmentNumber: true, warehouseId: true } },
      },
    });

    const newQuantity = Number(adjustment.newQuantity);

    // How much of this ingredient is already reflected in the inventory ledger?
    const postedAgg = await tx.inventoryTransaction.aggregate({
      where: { consignmentItemId: adjustment.consignmentItemId },
      _sum: { quantity: true },
    });
    const alreadyPosted = Number(postedAgg._sum.quantity ?? 0);

    // Make the new quantity authoritative on the ingredient.
    await tx.consignmentItem.update({
      where: { id: adjustment.consignmentItemId },
      data: { quantity: newQuantity },
    });

    // Post only the difference. If nothing has reached stock yet, the normal
    // receipt/distribution path will carry the new number, so we post nothing.
    let transactionId: string | null = null;
    if (alreadyPosted !== 0) {
      const delta = newQuantity - alreadyPosted;
      if (delta !== 0) {
        const priorPosting = await tx.inventoryTransaction.findFirst({
          where: { consignmentItemId: adjustment.consignmentItemId, batchLotId: { not: null } },
          select: { batchLotId: true },
        });

        const entry = await postLedgerEntry(tx, {
          eventType: LedgerEventType.ADJUSTMENT,
          materialId: adjustment.materialId,
          batchLotId: priorPosting?.batchLotId ?? null,
          warehouseId: adjustment.consignment.warehouseId,
          consignmentItemId: adjustment.consignmentItemId,
          quantity: delta,
          unitOfMeasure: adjustment.consignmentItem.unitOfMeasure,
          referenceType: 'QUANTITY_ADJUSTMENT',
          referenceId: adjustment.id,
          createdById: adjustment.requestedById,
          approvedById,
          notes: `QC quantity adjustment approved (${adjustment.reasonCode ?? 'ADJUSTMENT'}): ${alreadyPosted} → ${newQuantity}`,
        });
        transactionId = entry.id;
      }
    }

    const updated = await tx.quantityAdjustment.update({
      where: { id: adjustmentId },
      data: {
        status: 'APPROVED',
        approvedById,
        decidedAt: new Date(),
        appliedAt: new Date(),
        inventoryTransactionId: transactionId,
      },
      include: {
        material: { select: { name: true, sku: true } },
        consignment: { select: { consignmentNumber: true } },
      },
    });

    return { updated, alreadyPosted, appliedDelta: transactionId ? newQuantity - alreadyPosted : 0 };
  });

  await notifyUser(existing.requestedById, {
    title: `Quantity change approved — ${result.updated.material.name}`,
    body: `${result.updated.consignment.consignmentNumber}: new quantity ${Number(result.updated.newQuantity)} is now authoritative.`,
    referenceId: adjustmentId,
    notificationType: 'APPROVAL_DECISION',
  });

  await logActivity({
    userId: approvedById,
    activityType: 'APPROVE',
    module: 'qa',
    description: `Quantity change approved for ${result.updated.material.name} on ${result.updated.consignment.consignmentNumber} (${result.updated.oldQuantity} → ${result.updated.newQuantity})`,
    entityType: 'QuantityAdjustment',
    entityId: adjustmentId,
  });

  return result;
}

// ============================================================================
// REJECT (HEAD_OF_QC / SUPER_ADMIN)
// ============================================================================

export async function rejectQuantityAdjustment(
  adjustmentId: string,
  approvedById: string,
  rejectionReason: string
) {
  const existing = await prisma.quantityAdjustment.findUnique({ where: { id: adjustmentId } });
  if (!existing) throw new Error('Quantity adjustment not found');
  if (existing.status !== 'PENDING') {
    throw new Error(`Cannot reject a quantity adjustment with status ${existing.status}`);
  }
  if (!rejectionReason || !rejectionReason.trim()) {
    throw new Error('A rejection reason is required');
  }

  const updated = await prisma.quantityAdjustment.update({
    where: { id: adjustmentId },
    data: {
      status: 'REJECTED',
      approvedById,
      decidedAt: new Date(),
      rejectionReason: rejectionReason.trim(),
    },
    include: {
      material: { select: { name: true } },
      consignment: { select: { consignmentNumber: true } },
    },
  });

  await notifyUser(existing.requestedById, {
    title: `Quantity change rejected — ${updated.material.name}`,
    body: `${updated.consignment.consignmentNumber}: ${rejectionReason.trim()}`,
    referenceId: adjustmentId,
    notificationType: 'APPROVAL_DECISION',
  });

  await logActivity({
    userId: approvedById,
    activityType: 'REJECT',
    module: 'qa',
    description: `Quantity change rejected for ${updated.material.name} on ${updated.consignment.consignmentNumber}: ${rejectionReason.trim()}`,
    entityType: 'QuantityAdjustment',
    entityId: adjustmentId,
  });

  return updated;
}

export { REASON_CODES };
