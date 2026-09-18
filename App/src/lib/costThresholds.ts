/**
 * Cost modification thresholds for approval workflows
 * Different roles require different approval levels based on cost change magnitude
 */

export const COST_THRESHOLDS = {
  // Percentage threshold: changes > this % require approval
  PERCENT_THRESHOLD: 5, // 5% change triggers approval requirement
  
  // Absolute amount threshold: changes > this amount require approval
  ABSOLUTE_THRESHOLD: 10000, // ₦10,000 triggers approval requirement
  
  // High-value threshold: changes > this amount require executive approval
  HIGH_VALUE_THRESHOLD: 50000, // ₦50,000 requires EXECUTIVE_ADMIN approval
  
  // Roles that can approve cost changes
  APPROVERS: ['SUPER_ADMIN', 'EXECUTIVE_ADMIN'],
  
  // Roles that can create/modify costs without initial approval
  COST_MANAGERS: ['SUPER_ADMIN', 'PROCUREMENT_OFFICER', 'PRODUCTION_MANAGER', 'STORE_OFFICER'],
};

export interface CostChangeRequest {
  entityType: string; // Material, PurchaseOrderItem, BomIngredient, ProductionOrder, GoodsReceiptItem
  entityId: string;
  fieldName: string;
  oldValue: number | null; // null when the field had no prior value
  newValue: number;
  reason?: string;
  changeType: 'MANUAL' | 'APPROVED' | 'BULK_UPDATE';
  requestedBy: string; // User ID
}

export interface CostApprovalDecision {
  costAuditId: string;
  approved: boolean;
  approvedBy: string; // User ID
  rejectionReason?: string;
}

/**
 * Determine if a cost change requires approval
 */
export function requiresApproval(oldValue: number | null, newValue: number): boolean {
  const old = oldValue || 0;
  const change = Math.abs(newValue - old);
  const percentChange = old > 0 ? (change / old) * 100 : 100;
  
  // Require approval if either threshold is exceeded
  return percentChange > COST_THRESHOLDS.PERCENT_THRESHOLD || 
         change > COST_THRESHOLDS.ABSOLUTE_THRESHOLD;
}

/**
 * Determine if cost change is high-value (requires executive approval)
 */
export function isHighValueChange(oldValue: number | null, newValue: number): boolean {
  const change = Math.abs((newValue || 0) - (oldValue || 0));
  return change > COST_THRESHOLDS.HIGH_VALUE_THRESHOLD;
}

/**
 * Calculate cost variance percentage
 */
export function calculateVariancePercent(oldValue: number | null, newValue: number): number {
  const old = oldValue || 0;
  if (old === 0) return 100;
  return Math.round(((newValue - old) / old) * 10000) / 100; // 2 decimal places
}
