import { Request, Response, NextFunction } from 'express';
import * as userActivityLogger from '../services/userActivityLogger.js';

/**
 * Middleware to log user activities (page visits and API calls)
 */
export function activityLoggerMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Extract user info from auth token if present
    const user = (req as any).user;
    if (!user) {
      return next();
    }

    // Don't log health checks or internal requests
    if (req.path === '/health' || req.path.includes('/qstash')) {
      return next();
    }

    // Determine activity type based on HTTP method
    let activityType: userActivityLogger.ActivityType = 'PAGE_VISIT';
    if (req.method === 'POST') {
      activityType = 'CREATE';
    } else if (req.method === 'PUT' || req.method === 'PATCH') {
      activityType = 'UPDATE';
    } else if (req.method === 'DELETE') {
      activityType = 'DELETE';
    }

    // Determine module from path
    let module: userActivityLogger.Module = 'dashboard';
    const pathParts = req.path.split('/');
    
    if (req.path.includes('/inventory')) module = 'inventory';
    else if (req.path.includes('/requisitions') || req.path.includes('/purchase-orders') || req.path.includes('/grn')) module = 'procurement';
    else if (req.path.includes('/production')) module = 'production';
    else if (req.path.includes('/qa') || req.path.includes('/inspection')) module = 'qa';
    else if (req.path.includes('/audits') || req.path.includes('/user-activities')) module = 'audit';
    else if (req.path.includes('/admin') || req.path.includes('/users')) module = 'admin';
    else if (req.path.includes('/reports')) module = 'reports';

    // Get IP address
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';

    // Parse request body for context
    let description = `${req.method} ${req.path}`;
    let entityType: string | undefined;
    let entityId: string | undefined;
    let details: Record<string, any> | undefined;

    // Extract entity info from path
    if (req.params.id) {
      entityId = req.params.id;
      if (req.path.includes('/inventory')) entityType = 'Material';
      else if (req.path.includes('/requisitions')) entityType = 'Requisition';
      else if (req.path.includes('/purchase-orders')) entityType = 'PurchaseOrder';
      else if (req.path.includes('/grn')) entityType = 'GoodsReceipt';
      else if (req.path.includes('/production-orders')) entityType = 'ProductionOrder';
    }

    // Log the activity asynchronously (don't wait for it)
    process.nextTick(() => {
      userActivityLogger.logActivity({
        userId: user.id,
        activityType,
        module,
        description,
        entityType,
        entityId,
        details,
        ipAddress,
        userAgent,
      }).catch(err => {
        console.error('Error logging activity:', err);
      });
    });

    next();
  };
}

/**
 * Middleware to log specific business actions
 */
export function logBusinessAction(options: {
  activityType: userActivityLogger.ActivityType;
  module: userActivityLogger.Module;
  entityType: string;
  getEntityId?: (req: Request) => string | undefined;
  getDescription?: (req: Request) => string;
  getDetails?: (req: Request, res?: Response) => Record<string, any>;
}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;
    if (!user) {
      return next();
    }

    const entityId = options.getEntityId?.(req);
    const description = options.getDescription?.(req) || `${options.activityType} ${options.entityType}`;
    const details = options.getDetails?.(req);

    // Log asynchronously
    process.nextTick(() => {
      userActivityLogger.logActivity({
        userId: user.id,
        activityType: options.activityType,
        module: options.module,
        description,
        entityType: options.entityType,
        entityId,
        details,
        ipAddress: req.ip || req.socket.remoteAddress || 'unknown',
        userAgent: req.get('user-agent') || 'unknown',
      }).catch(err => {
        console.error('Error logging action:', err);
      });
    });

    next();
  };
}
