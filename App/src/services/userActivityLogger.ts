import { prisma } from '../lib/db.js';

export type ActivityType = 
  | 'PAGE_VISIT' 
  | 'CREATE' 
  | 'UPDATE' 
  | 'DELETE' 
  | 'APPROVE' 
  | 'REJECT' 
  | 'TRANSFER' 
  | 'ADJUST'
  | 'LOGIN'
  | 'LOGOUT'
  | 'EXPORT'
  | 'IMPORT';

export type Module = 
  | 'inventory' 
  | 'procurement' 
  | 'production' 
  | 'qa' 
  | 'audit' 
  | 'admin'
  | 'reports'
  | 'dashboard';

export interface LogActivityOptions {
  userId: string;
  activityType: ActivityType;
  module: Module;
  description?: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Log a user activity
 */
export async function logActivity(options: LogActivityOptions) {
  try {
    await prisma.userActivity.create({
      data: {
        userId: options.userId,
        activityType: options.activityType,
        module: options.module,
        description: options.description,
        entityType: options.entityType,
        entityId: options.entityId,
        details: options.details,
        ipAddress: options.ipAddress,
        userAgent: options.userAgent,
      },
    });
  } catch (error) {
    console.error('Failed to log user activity:', error);
    // Don't throw - activity logging shouldn't break the main operation
  }
}

/**
 * Get user's activity history
 */
export async function getUserActivityHistory(userId: string, days: number = 30, limit: number = 100) {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);

  const activities = await prisma.userActivity.findMany({
    where: {
      userId,
      createdAt: { gte: sinceDate },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return activities;
}

/**
 * Get user activity summary (aggregated by day and activity type)
 */
export async function getUserActivitySummary(userId: string, days: number = 30) {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);

  const activities = await prisma.userActivity.findMany({
    where: {
      userId,
      createdAt: { gte: sinceDate },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Group by date
  const dayMap = new Map<string, any>();
  for (const activity of activities) {
    const dateStr = activity.createdAt.toISOString().split('T')[0];
    if (!dayMap.has(dateStr)) {
      dayMap.set(dateStr, {
        date: dateStr,
        actionCount: 0,
        actions: [],
      });
    }
    const day = dayMap.get(dateStr);
    day.actionCount++;
    day.actions.push(activity.activityType);
  }

  // Get user info
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { fullName: true },
  });

  return {
    userId,
    userName: user?.fullName || 'Unknown',
    actionsCount: activities.length,
    lastAction: activities.length > 0 ? activities[0].createdAt.toISOString() : null,
    days: Array.from(dayMap.values()).slice(-7), // Last 7 days
  };
}

/**
 * Get system-wide user activities
 */
export async function getSystemUserActivities(days: number = 7, limit: number = 100) {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);

  const activities = await prisma.userActivity.findMany({
    where: {
      createdAt: { gte: sinceDate },
    },
    include: {
      user: {
        select: { fullName: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return activities.map((activity) => ({
    id: activity.id,
    userId: activity.userId,
    userName: activity.user.fullName,
    activityType: activity.activityType,
    module: activity.module,
    description: activity.description,
    entityType: activity.entityType,
    entityId: activity.entityId,
    timestamp: activity.createdAt,
  }));
}

/**
 * Get activity statistics by type
 */
export async function getActivityStatistics(days: number = 30) {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);

  const activities = await prisma.userActivity.findMany({
    where: {
      createdAt: { gte: sinceDate },
    },
    select: {
      activityType: true,
      module: true,
    },
  });

  const typeStats = new Map<string, number>();
  const moduleStats = new Map<string, number>();

  for (const activity of activities) {
    typeStats.set(
      activity.activityType,
      (typeStats.get(activity.activityType) || 0) + 1
    );
    moduleStats.set(
      activity.module,
      (moduleStats.get(activity.module) || 0) + 1
    );
  }

  return {
    totalActivities: activities.length,
    byType: Object.fromEntries(typeStats),
    byModule: Object.fromEntries(moduleStats),
  };
}

/**
 * Get user's actions by entity type
 */
export async function getUserActionsByEntity(userId: string, days: number = 30) {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);

  const activities = await prisma.userActivity.findMany({
    where: {
      userId,
      createdAt: { gte: sinceDate },
      entityType: { not: null },
    },
  });

  const entityStats = new Map<string, { count: number; lastAction: Date }>();

  for (const activity of activities) {
    if (activity.entityType) {
      const current = entityStats.get(activity.entityType) || { count: 0, lastAction: activity.createdAt };
      entityStats.set(activity.entityType, {
        count: current.count + 1,
        lastAction: activity.createdAt > current.lastAction ? activity.createdAt : current.lastAction,
      });
    }
  }

  return Object.fromEntries(entityStats);
}

/**
 * Clean up old activity logs (older than specified days)
 */
export async function cleanupOldActivities(olderThanDays: number = 90) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

  const result = await prisma.userActivity.deleteMany({
    where: {
      createdAt: { lt: cutoffDate },
    },
  });

  return result.count;
}
