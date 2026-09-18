/**
 * Cost Management Service
 * Handles cost modifications, approvals, and audit trail tracking
 */
import { prisma } from "../lib/db.js";
import { COST_THRESHOLDS, requiresApproval, isHighValueChange, calculateVariancePercent } from "../lib/costThresholds.js";
import type { CostChangeRequest, CostApprovalDecision } from "../lib/costThresholds.js";

/**
 * Request a cost change - creates audit record and handles approval workflow
 */
export async function requestCostChange(request: CostChangeRequest) {
  // Determine if approval is needed
  const needsApproval = requiresApproval(request.oldValue, request.newValue);
  const isHighValue = isHighValueChange(request.oldValue, request.newValue);

  // Create audit record
  const audit = await prisma.costAudit.create({
    data: {
      entityType: request.entityType,
      entityId: request.entityId,
      fieldName: request.fieldName,
      oldValue: request.oldValue,
      newValue: request.newValue,
      reason: request.reason,
      changeType: request.changeType,
      status: needsApproval ? "PENDING" : "APPROVED",
      changedById: request.requestedBy,
      approvedById: needsApproval ? null : request.requestedBy, // Auto-approve if under threshold
      approvedAt: needsApproval ? null : new Date(),
    },
    include: {
      changedBy: { select: { id: true, fullName: true, email: true } },
      approvedBy: { select: { id: true, fullName: true, email: true } },
    },
  });

  // If approved, apply the cost change immediately
  if (!needsApproval) {
    await applyCostChange(request.entityType, request.entityId, request.fieldName, request.newValue);
  }

  return {
    audit,
    requiresApproval: needsApproval,
    isHighValue,
    variancePercent: calculateVariancePercent(request.oldValue, request.newValue),
  };
}

/**
 * Approve a pending cost change
 */
export async function approveCostChange(auditId: string, approvedBy: string, rejectionReason?: string) {
  const audit = await prisma.costAudit.findUnique({ where: { id: auditId } });

  if (!audit) {
    throw new Error("Cost audit record not found");
  }

  if (audit.status !== "PENDING") {
    throw new Error(`Cannot approve cost change with status: ${audit.status}`);
  }

  const approved = !rejectionReason; // If no rejection reason, it's approved

  // Update audit record
  const updated = await prisma.costAudit.update({
    where: { id: auditId },
    data: {
      status: approved ? "APPROVED" : "REJECTED",
      approvedById: approvedBy,
      approvedAt: new Date(),
      rejectionReason,
    },
    include: {
      changedBy: { select: { id: true, fullName: true, email: true } },
      approvedBy: { select: { id: true, fullName: true, email: true } },
    },
  });

  // If approved, apply the cost change
  if (approved) {
    await applyCostChange(audit.entityType, audit.entityId, audit.fieldName, audit.newValue);
  }

  return updated;
}

/**
 * Apply the cost change to the actual entity
 */
async function applyCostChange(entityType: string, entityId: string, fieldName: string, newValue: number) {
  switch (entityType) {
    case "Material":
      await prisma.material.update({
        where: { id: entityId },
        data: {
          standardCost: newValue,
          lastCostUpdateAt: new Date(),
        },
      });
      break;

    case "PurchaseOrderItem":
      await prisma.purchaseOrderItem.update({
        where: { id: entityId },
        data: { unitCost: newValue },
      });
      break;

    case "BomIngredient":
      await prisma.bomIngredient.update({
        where: { id: entityId },
        data: {
          estimatedCost: newValue,
          costUpdatedAt: new Date(),
        },
      });
      break;

    case "ProductionOrder":
      if (fieldName === "estimatedCost") {
        await prisma.productionOrder.update({
          where: { id: entityId },
          data: { estimatedCost: newValue },
        });
      } else if (fieldName === "actualCost") {
        // Calculate variance when actual cost is set
        const order = await prisma.productionOrder.findUnique({ where: { id: entityId } });
        const variance = order?.estimatedCost ? Number(newValue) - Number(order.estimatedCost) : 0;

        await prisma.productionOrder.update({
          where: { id: entityId },
          data: {
            actualCost: newValue,
            costVariance: variance,
          },
        });
      }
      break;

    case "GoodsReceiptItem":
      await prisma.goodsReceiptItem.update({
        where: { id: entityId },
        data: { unitCost: newValue },
      });
      break;

    default:
      throw new Error(`Unknown entity type: ${entityType}`);
  }
}

/**
 * Get pending cost approvals for a user
 */
export async function getPendingApprovals(userId: string, limit = 50) {
  return prisma.costAudit.findMany({
    where: { status: "PENDING" },
    include: {
      changedBy: { select: { id: true, fullName: true, email: true, role: true } },
      approvedBy: { select: { id: true, fullName: true, email: true } },
    },
    orderBy: { changedAt: "desc" },
    take: limit,
  });
}

/**
 * Get cost change history for an entity
 */
export async function getCostHistory(entityType: string, entityId: string, limit = 50) {
  return prisma.costAudit.findMany({
    where: { entityType, entityId },
    include: {
      changedBy: { select: { id: true, fullName: true, email: true } },
      approvedBy: { select: { id: true, fullName: true, email: true } },
    },
    orderBy: { changedAt: "desc" },
    take: limit,
  });
}

/**
 * Get cost audit summary (statistics)
 */
export async function getCostAuditSummary(days = 30) {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);

  const audits = await prisma.costAudit.findMany({
    where: { changedAt: { gte: sinceDate } },
  });

  const pending = audits.filter((a) => a.status === "PENDING").length;
  const approved = audits.filter((a) => a.status === "APPROVED").length;
  const rejected = audits.filter((a) => a.status === "REJECTED").length;

  // Group by entity type
  const byEntityType: Record<string, number> = {};
  audits.forEach((a) => {
    byEntityType[a.entityType] = (byEntityType[a.entityType] || 0) + 1;
  });

  // Group by change type
  const byChangeType: Record<string, number> = {};
  audits.forEach((a) => {
    byChangeType[a.changeType] = (byChangeType[a.changeType] || 0) + 1;
  });

  return {
    period: { days, since: sinceDate },
    totalChanges: audits.length,
    status: { pending, approved, rejected },
    byEntityType,
    byChangeType,
  };
}

/**
 * Get material cost history with current price
 */
export async function getMaterialCostInfo(materialId: string) {
  const material = await prisma.material.findUnique({
    where: { id: materialId },
    select: {
      id: true,
      name: true,
      sku: true,
      standardCost: true,
      lastCostUpdateAt: true,
      lastCostUpdatedBy: true,
    },
  });

  if (!material) {
    throw new Error("Material not found");
  }

  const history = await getCostHistory("Material", materialId, 10);

  // Get latest PO cost if available
  const latestPO = await prisma.purchaseOrderItem.findFirst({
    where: { materialId },
    include: { po: { select: { orderDate: true } } },
    orderBy: { po: { orderDate: "desc" } },
  });

  return {
    material,
    history,
    latestPOCost: latestPO ? Number(latestPO.unitCost) : null,
  };
}
