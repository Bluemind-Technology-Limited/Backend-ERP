import { prisma } from '../lib/db.js';

/**
 * Audit Trail Service
 * Provides utility functions to track and retrieve system-wide activity
 * and entity lifecycle changes. Works in conjunction with timestamp fields
 * added to major entities (Requisition, PurchaseOrder, GoodsReceipt, etc.)
 */

export interface AuditAction {
  entityType: string; // 'Requisition', 'PurchaseOrder', 'GoodsReceipt', 'ProductionOrder', 'Bom'
  entityId: string;
  action: string; // 'CREATED', 'APPROVED', 'REJECTED', 'RECEIVED', 'STARTED', 'COMPLETED'
  userId: string;
  timestamp: Date;
  details?: Record<string, any>;
}

export interface AuditLogEntry {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  userId: string;
  userName: string;
  userRole: string;
  timestamp: Date;
  details?: Record<string, any>;
  createdAt: Date;
}

// ============================================================================
// Core Audit Functions
// ============================================================================

/**
 * Get requisition lifecycle timeline
 */
export async function getRequisitionTimeline(requisitionId: string) {
  const req = await prisma.requisition.findUniqueOrThrow({
    where: { id: requisitionId },
    include: { requestedBy: true },
  });

  const timeline = [];

  timeline.push({
    action: 'CREATED',
    timestamp: req.createdAt,
    userId: req.requestedById,
    status: 'DRAFT',
  });

  if (req.approvedAt) {
    timeline.push({
      action: 'APPROVED',
      timestamp: req.approvedAt,
      status: 'APPROVED',
    });
  }

  if (req.rejectedAt) {
    timeline.push({
      action: 'REJECTED',
      timestamp: req.rejectedAt,
      status: 'REJECTED',
    });
  }

  if (req.updatedAt && req.updatedAt !== req.createdAt) {
    timeline.push({
      action: 'UPDATED',
      timestamp: req.updatedAt,
      status: req.status,
    });
  }

  return {
    entityType: 'Requisition',
    entityId: requisitionId,
    number: req.number,
    status: req.status,
    timeline: timeline.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()),
  };
}

/**
 * Get purchase order lifecycle timeline
 */
export async function getPurchaseOrderTimeline(poId: string) {
  const po = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: poId },
    include: { createdBy: true },
  });

  const timeline = [];

  timeline.push({
    action: 'CREATED',
    timestamp: po.createdAt,
    userId: po.createdById,
    status: 'DRAFT',
  });

  if (po.sentAt) {
    timeline.push({
      action: 'SENT',
      timestamp: po.sentAt,
      status: 'SENT',
    });
  }

  if (po.receivedAt) {
    timeline.push({
      action: 'RECEIVED',
      timestamp: po.receivedAt,
      status: 'RECEIVED',
    });
  }

  if (po.closedAt) {
    timeline.push({
      action: 'CLOSED',
      timestamp: po.closedAt,
      status: 'CLOSED',
    });
  }

  if (po.updatedAt && po.updatedAt !== po.createdAt) {
    timeline.push({
      action: 'UPDATED',
      timestamp: po.updatedAt,
      status: po.status,
    });
  }

  return {
    entityType: 'PurchaseOrder',
    entityId: poId,
    number: po.number,
    status: po.status,
    timeline: timeline.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()),
  };
}

/**
 * Get goods receipt lifecycle timeline
 */
export async function getGoodsReceiptTimeline(grnId: string) {
  const grn = await prisma.goodsReceipt.findUniqueOrThrow({
    where: { id: grnId },
    include: { receivedBy: true },
  });

  const timeline = [];

  timeline.push({
    action: 'CREATED',
    timestamp: grn.createdAt,
    userId: grn.receivedById,
    status: 'PENDING_QA',
  });

  timeline.push({
    action: 'RECEIVED',
    timestamp: grn.receivedAt,
    userId: grn.receivedById,
    status: 'PENDING_QA',
  });

  if (grn.approvedAt) {
    timeline.push({
      action: 'APPROVED',
      timestamp: grn.approvedAt,
      status: 'APPROVED',
    });
  }

  if (grn.rejectedAt) {
    timeline.push({
      action: 'REJECTED',
      timestamp: grn.rejectedAt,
      status: 'REJECTED',
    });
  }

  if (grn.updatedAt && grn.updatedAt !== grn.createdAt) {
    timeline.push({
      action: 'UPDATED',
      timestamp: grn.updatedAt,
      status: grn.status,
    });
  }

  return {
    entityType: 'GoodsReceipt',
    entityId: grnId,
    number: grn.number,
    status: grn.status,
    timeline: timeline.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()),
  };
}

/**
 * Get production order lifecycle timeline
 */
export async function getProductionOrderTimeline(orderId: string) {
  const order = await prisma.productionOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: { createdBy: true },
  });

  const timeline = [];

  timeline.push({
    action: 'CREATED',
    timestamp: order.createdAt,
    userId: order.createdById,
    status: 'SCHEDULED',
  });

  if (order.actualStart) {
    timeline.push({
      action: 'STARTED',
      timestamp: order.actualStart,
      status: 'PROCESSING',
    });
  }

  if (order.ingredientsReleasedAt) {
    timeline.push({
      action: 'INGREDIENTS_RELEASED',
      timestamp: order.ingredientsReleasedAt,
      userId: order.ingredientsReleasedById,
      status: 'RELEASED',
    });
  }

  if (order.yieldLoggedAt) {
    timeline.push({
      action: 'YIELD_LOGGED',
      timestamp: order.yieldLoggedAt,
      userId: order.yieldLoggedById,
      status: 'PROCESSING',
    });
  }

  if (order.actualEnd) {
    timeline.push({
      action: 'COMPLETED',
      timestamp: order.actualEnd,
      status: 'COMPLETED',
    });
  }

  if (order.updatedAt && order.updatedAt !== order.createdAt) {
    timeline.push({
      action: 'UPDATED',
      timestamp: order.updatedAt,
      status: order.status,
    });
  }

  return {
    entityType: 'ProductionOrder',
    entityId: orderId,
    number: order.orderNumber,
    status: order.status,
    timeline: timeline.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()),
  };
}

/**
 * Get BOM lifecycle timeline
 */
export async function getBomTimeline(bomId: string) {
  const bom = await prisma.bom.findUniqueOrThrow({
    where: { id: bomId },
    include: { approvedBy: true, updatedBy: true },
  });

  const timeline = [];

  timeline.push({
    action: 'CREATED',
    timestamp: bom.createdAt,
    status: 'DRAFT',
  });

  if (bom.approvedAt) {
    timeline.push({
      action: 'APPROVED',
      timestamp: bom.approvedAt,
      userId: bom.approvedById,
      status: 'APPROVED',
    });
  }

  if (bom.archivedAt) {
    timeline.push({
      action: 'ARCHIVED',
      timestamp: bom.archivedAt,
      status: 'ARCHIVED',
    });
  }

  if (bom.updatedAt && bom.updatedAt !== bom.createdAt) {
    timeline.push({
      action: 'UPDATED',
      timestamp: bom.updatedAt,
      userId: bom.updatedById,
      status: bom.status,
    });
  }

  return {
    entityType: 'Bom',
    entityId: bomId,
    name: bom.productName,
    status: bom.status,
    timeline: timeline.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()),
  };
}

// ============================================================================
// User Activity Tracking
// ============================================================================

/**
 * Get user activity summary (timestamp-based)
 */
export async function getUserActivity(userId: string, days: number = 30) {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);

  // Get user info
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { fullName: true },
  });

  // Get user activities
  const activities = await prisma.userActivity.findMany({
    where: {
      userId,
      createdAt: { gte: sinceDate },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Group by date
  const dayMap = new Map<string, { date: string; actionCount: number; actions: string[] }>();
  for (const activity of activities) {
    const dateStr = activity.createdAt.toISOString().split('T')[0];
    if (!dayMap.has(dateStr)) {
      dayMap.set(dateStr, {
        date: dateStr,
        actionCount: 0,
        actions: [],
      });
    }
    const day = dayMap.get(dateStr)!;
    day.actionCount++;
    day.actions.push(activity.activityType);
  }

  return {
    userId,
    userName: user?.fullName || 'Unknown',
    actionsCount: activities.length,
    lastAction: activities.length > 0 ? activities[0].createdAt.toISOString() : null,
    days: Array.from(dayMap.values()).slice(-7), // Last 7 days
  };
}

// ============================================================================
// Aggregate Timeline Functions
// ============================================================================

/**
 * Get system activity timeline - all entities across time
 */
export async function getSystemActivityTimeline(days: number = 7, limit: number = 100) {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);

  const timelineMap = new Map<string, any>();

  // Get recent requisitions
  const requisitions = await prisma.requisition.findMany({
    where: { createdAt: { gte: sinceDate } },
    include: { requestedBy: true },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  for (const r of requisitions) {
    const key = `Requisition-${r.id}`;
    if (!timelineMap.has(key)) {
      timelineMap.set(key, {
        entityType: 'Requisition',
        entityId: r.id,
        totalEvents: 0,
        timeline: [],
      });
    }
    const timeline = timelineMap.get(key);
    timeline.timeline.push({
      id: `${r.id}-created`,
      entityType: 'Requisition',
      entityId: r.id,
      action: 'CREATED',
      actor: { id: r.requestedById, fullName: r.requestedBy.fullName },
      timestamp: r.createdAt,
    });
    timeline.totalEvents++;
  }

  // Get recent purchase orders
  const pos = await prisma.purchaseOrder.findMany({
    where: { createdAt: { gte: sinceDate } },
    include: { createdBy: true },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  for (const po of pos) {
    const key = `PurchaseOrder-${po.id}`;
    if (!timelineMap.has(key)) {
      timelineMap.set(key, {
        entityType: 'PurchaseOrder',
        entityId: po.id,
        totalEvents: 0,
        timeline: [],
      });
    }
    const timeline = timelineMap.get(key);
    timeline.timeline.push({
      id: `${po.id}-created`,
      entityType: 'PurchaseOrder',
      entityId: po.id,
      action: 'CREATED',
      actor: { id: po.createdById, fullName: po.createdBy.fullName },
      timestamp: po.createdAt,
    });
    timeline.totalEvents++;
  }

  // Get recent goods receipts
  const grns = await prisma.goodsReceipt.findMany({
    where: { createdAt: { gte: sinceDate } },
    include: { receivedBy: true },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  for (const grn of grns) {
    const key = `GoodsReceipt-${grn.id}`;
    if (!timelineMap.has(key)) {
      timelineMap.set(key, {
        entityType: 'GoodsReceipt',
        entityId: grn.id,
        totalEvents: 0,
        timeline: [],
      });
    }
    const timeline = timelineMap.get(key);
    timeline.timeline.push({
      id: `${grn.id}-created`,
      entityType: 'GoodsReceipt',
      entityId: grn.id,
      action: 'RECEIVED',
      actor: { id: grn.receivedById, fullName: grn.receivedBy.fullName },
      timestamp: grn.createdAt,
    });
    timeline.totalEvents++;
  }

  // Get recent production orders
  const orders = await prisma.productionOrder.findMany({
    where: { createdAt: { gte: sinceDate } },
    include: { createdBy: true },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  for (const o of orders) {
    const key = `ProductionOrder-${o.id}`;
    if (!timelineMap.has(key)) {
      timelineMap.set(key, {
        entityType: 'ProductionOrder',
        entityId: o.id,
        totalEvents: 0,
        timeline: [],
      });
    }
    const timeline = timelineMap.get(key);
    timeline.timeline.push({
      id: `${o.id}-created`,
      entityType: 'ProductionOrder',
      entityId: o.id,
      action: 'CREATED',
      actor: { id: o.createdById, fullName: o.createdBy.fullName },
      timestamp: o.createdAt,
    });
    timeline.totalEvents++;
  }

  // Return as array
  return Array.from(timelineMap.values()).slice(0, limit);
}

// ============================================================================
// Statistics & Reports
// ============================================================================

/**
 * Get approval velocity metrics
 */
export async function getApprovalVelocityMetrics(days: number = 30) {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);

  // Count requisitions approved
  const requisitionsApproved = await prisma.requisition.count({
    where: {
      approvedAt: { gte: sinceDate },
    },
  });

  // Count requisitions rejected
  const requisitionsRejected = await prisma.requisition.count({
    where: {
      rejectedAt: { gte: sinceDate },
    },
  });

  // Count GRNs approved
  const grnsApproved = await prisma.goodsReceipt.count({
    where: {
      approvedAt: { gte: sinceDate },
    },
  });

  // Count GRNs rejected
  const grnsRejected = await prisma.goodsReceipt.count({
    where: {
      rejectedAt: { gte: sinceDate },
    },
  });

  const totalApprovals = requisitionsApproved + grnsApproved;
  const totalRejections = requisitionsRejected + grnsRejected;
  const total = totalApprovals + totalRejections;

  return {
    totalApprovals,
    totalRejections,
    approvalRate: total > 0 ? (totalApprovals / total) * 100 : 0,
    averageApprovalTime: 0, // TODO: calculate from timestamps
    entityCounts: {
      requisitions: requisitionsApproved + requisitionsRejected,
      goodsReceipts: grnsApproved + grnsRejected,
    },
  };
}

/**
 * Get production completion metrics
 */
export async function getProductionMetrics(days: number = 30) {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);

  const orders = await prisma.productionOrder.findMany({
    where: { actualStart: { gte: sinceDate } },
    select: {
      actualStart: true,
      actualEnd: true,
      status: true,
    },
  });

  let completed = 0;
  let inProgress = 0;
  let cancelled = 0;
  let totalLeadTime = 0;

  for (const order of orders) {
    if (order.status === 'COMPLETED' && order.actualEnd) {
      completed++;
      const leadTime = order.actualEnd.getTime() - order.actualStart!.getTime();
      totalLeadTime += leadTime;
    } else if (order.status === 'PROCESSING') {
      inProgress++;
    } else if (order.status === 'WASTED') {
      cancelled++;
    }
  }

  const avgLeadTime = completed > 0 ? Math.round(totalLeadTime / completed / 1000 / 60 / 60) : 0; // in hours

  return {
    totalCompleted: completed,
    totalInProgress: inProgress,
    totalCancelled: cancelled,
    completionRate: orders.length > 0 ? (completed / orders.length) * 100 : 0,
    averageLeadTime: avgLeadTime,
    averageYield: 95.5, // TODO: calculate from actual yield data
    averageWaste: 2.3, // TODO: calculate from actual waste data
  };
}
