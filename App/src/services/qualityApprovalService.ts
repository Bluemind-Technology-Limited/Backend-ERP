/**
 * Quality Approval Service
 * Manages consignment QA approval workflow: inspection, checks, approval/rejection
 * 
 * Workflow:
 * 1. Consignment received → QUALITY_PENDING status
 * 2. QA Inspector starts checks (creates QualityApproval record)
 * 3. Inspector performs checks on each item (creates QualityCheckItem records)
 * 4. All items checked → QA decides: APPROVE or REJECT
 * 5. If approved → Consignment moved to QUALITY_APPROVED (stock manager can access)
 * 6. If rejected → Consignment stays blocked or returns to supplier
 */

import type { PrismaClient } from '@prisma/client';
import { QualityCheckType, QualityApprovalStatus, ConsignmentStatus } from '@prisma/client';
import { logActivity } from './userActivityLogger.js';

// ============================================================================
// CREATE QUALITY CHECK
// ============================================================================

/**
 * Initiate quality approval process for a consignment
 * Creates QualityApproval master record with PENDING status
 * Creates QualityCheckItem placeholders for each consignment item
 */
export async function initiateQualityCheck(
  prisma: PrismaClient,
  consignmentId: string,
  inspectorId: string
) {
  try {
    // Get consignment with items
    const consignment = await prisma.consignment.findUnique({
      where: { id: consignmentId },
      include: { items: true },
    });

    if (!consignment) {
      throw new Error('Consignment not found');
    }

    if (consignment.status !== 'RECEIVED') {
      throw new Error(`Consignment must be in RECEIVED status to initiate QA checks. Current: ${consignment.status}`);
    }

    // Create QualityApproval master record
    const qualityApproval = await prisma.qualityApproval.create({
      data: {
        consignmentId,
        status: 'IN_PROGRESS',
        totalItems: consignment.items.length,
        startedById: inspectorId,
        startedAt: new Date(),
      },
    });

    // Create QualityCheckItem for each consignment item (PENDING status)
    const checkItems = await Promise.all(
      consignment.items.map((item) =>
        prisma.qualityCheckItem.create({
          data: {
            qualityApprovalId: qualityApproval.id,
            consignmentItemId: item.id,
            checkType: 'PHYSICAL_INSPECTION', // Default check type
            status: 'PENDING',
          },
        })
      )
    );

    // Update consignment status to QUALITY_PENDING
    await prisma.consignment.update({
      where: { id: consignmentId },
      data: { status: 'QUALITY_PENDING' },
    });

    // Log activity
    await logActivity({
      userId: inspectorId,
      activityType: 'CREATE',
      module: 'qa',
      description: `Quality checks initiated for consignment ${consignment.consignmentNumber} with ${consignment.items.length} items`,
      entityType: 'QualityApproval',
      entityId: qualityApproval.id,
    });

    return {
      qualityApproval,
      checkItems,
      consignment,
    };
  } catch (error) {
    console.error('Error initiating quality check:', error);
    throw error;
  }
}

// ============================================================================
// UPDATE CHECK ITEM
// ============================================================================

/**
 * Record a QA check result for a consignment item
 * Updates QualityCheckItem with result (PASS/FAIL) and remarks
 * Updates parent QualityApproval pass/fail counts
 */
export async function updateCheckItem(
  prisma: PrismaClient,
  checkItemId: string,
  data: {
    checkType: QualityCheckType | string; // e.g., PHYSICAL_INSPECTION, QUANTITY_VERIFICATION
    result: 'PASS' | 'FAIL';
    remarks?: string;
    inspectorId: string;
  }
) {
  try {
    const checkItem = await prisma.qualityCheckItem.findUnique({
      where: { id: checkItemId },
      include: { qualityApproval: true },
    });

    if (!checkItem) {
      throw new Error('Quality check item not found');
    }

    // Update check item with result
    const updatedItem = await prisma.qualityCheckItem.update({
      where: { id: checkItemId },
      data: {
        checkType: data.checkType as QualityCheckType,
        result: data.result,
        remarks: data.remarks,
        checkedAt: new Date(),
        checkedById: data.inspectorId,
      },
      include: { qualityApproval: true },
    });

    // Update parent QualityApproval counts
    const allItems = await prisma.qualityCheckItem.findMany({
      where: { qualityApprovalId: checkItem.qualityApprovalId },
    });

    const passedCount = allItems.filter((item) => item.result === 'PASS').length;
    const failedCount = allItems.filter((item) => item.result === 'FAIL').length;
    const pendingCount = allItems.filter((item) => item.status === 'PENDING').length;

    // Determine QualityApproval status based on checks
    let qaStatus: QualityApprovalStatus = QualityApprovalStatus.IN_PROGRESS;
    if (pendingCount === 0) {
      // All items checked
      qaStatus = failedCount > 0 ? QualityApprovalStatus.FAILED : QualityApprovalStatus.PASSED;
    }

    await prisma.qualityApproval.update({
      where: { id: checkItem.qualityApprovalId },
      data: {
        passedItems: passedCount,
        failedItems: failedCount,
        status: qaStatus,
        completedAt: pendingCount === 0 ? new Date() : null,
      },
    });

    // Log activity
    await logActivity({
      userId: data.inspectorId,
      activityType: 'UPDATE',
      module: 'qa',
      description: `QA check recorded: ${data.result} (${data.checkType})`,
      entityType: 'QualityCheckItem',
      entityId: checkItemId,
    });

    return updatedItem;
  } catch (error) {
    console.error('Error updating check item:', error);
    throw error;
  }
}

// ============================================================================
// APPROVE CONSIGNMENT
// ============================================================================

/**
 * Approve consignment for release (all items passed QA checks)
 * Updates QualityApproval status to APPROVED
 * Updates Consignment status to QUALITY_APPROVED (stock manager can now access)
 */
export async function approveConsignment(
  prisma: PrismaClient,
  qualityApprovalId: string,
  data: {
    approverUserId: string;
    notes?: string;
  }
) {
  try {
    const qualityApproval = await prisma.qualityApproval.findUnique({
      where: { id: qualityApprovalId },
      include: { consignment: true },
    });

    if (!qualityApproval) {
      throw new Error('Quality approval record not found');
    }

    // Check all items are completed
    const allItems = await prisma.qualityCheckItem.findMany({
      where: { qualityApprovalId },
    });

    const pendingItems = allItems.filter((item) => item.status === 'PENDING');
    if (pendingItems.length > 0) {
      throw new Error(`Cannot approve: ${pendingItems.length} items still pending checks`);
    }

    const failedItems = allItems.filter((item) => item.result === 'FAIL');
    if (failedItems.length > 0) {
      throw new Error(`Cannot approve: ${failedItems.length} items failed QA checks`);
    }

    // Approve quality check
    const updatedApproval = await prisma.qualityApproval.update({
      where: { id: qualityApprovalId },
      data: {
        status: 'APPROVED',
        approvedAt: new Date(),
        approvedById: data.approverUserId,
        notes: data.notes,
      },
      include: { consignment: true },
    });

    // Update consignment status to QUALITY_APPROVED
    const updatedConsignment = await prisma.consignment.update({
      where: { id: qualityApproval.consignmentId },
      data: { status: 'QUALITY_APPROVED' },
    });

    // Log activity
    await logActivity({
      userId: data.approverUserId,
      activityType: 'APPROVE',
      module: 'qa',
      description: `Consignment ${updatedConsignment.consignmentNumber} approved for release - ready for stock manager access`,
      entityType: 'QualityApproval',
      entityId: qualityApprovalId,
    });

    return {
      qualityApproval: updatedApproval,
      consignment: updatedConsignment,
    };
  } catch (error) {
    console.error('Error approving consignment:', error);
    throw error;
  }
}

// ============================================================================
// REJECT CONSIGNMENT
// ============================================================================

/**
 * Reject consignment due to failed QA checks
 * Updates QualityApproval status to REJECTED
 * Consignment remains QUALITY_PENDING (blocked from stock manager access)
 */
export async function rejectConsignment(
  prisma: PrismaClient,
  qualityApprovalId: string,
  data: {
    rejectorUserId: string;
    rejectionReason: string;
    notes?: string;
  }
) {
  try {
    const qualityApproval = await prisma.qualityApproval.findUnique({
      where: { id: qualityApprovalId },
      include: { consignment: true },
    });

    if (!qualityApproval) {
      throw new Error('Quality approval record not found');
    }

    // Reject quality check
    const updatedApproval = await prisma.qualityApproval.update({
      where: { id: qualityApprovalId },
      data: {
        status: 'REJECTED',
        rejectedAt: new Date(),
        approvedById: data.rejectorUserId, // Using same field for simplicity
        rejectionReason: data.rejectionReason,
        notes: data.notes,
      },
      include: { consignment: true },
    });

    // Consignment stays QUALITY_PENDING (blocked)
    // Stock manager cannot access until new approval or consignment reversion

    // Log activity
    await logActivity({
      userId: data.rejectorUserId,
      activityType: 'REJECT',
      module: 'qa',
      description: `Consignment ${qualityApproval.consignment.consignmentNumber} rejected: ${data.rejectionReason}`,
      entityType: 'QualityApproval',
      entityId: qualityApprovalId,
    });

    return updatedApproval;
  } catch (error) {
    console.error('Error rejecting consignment:', error);
    throw error;
  }
}

// ============================================================================
// GET QUALITY STATUS
// ============================================================================

/**
 * Get complete quality approval status for a consignment
 * Includes approval master record and all check items
 */
export async function getQualityStatus(
  prisma: PrismaClient,
  consignmentId: string
) {
  try {
    const qualityApproval = await prisma.qualityApproval.findUnique({
      where: { consignmentId },
      include: {
        checkItems: {
          include: {
            consignmentItem: {
              include: { material: true },
            },
            checkedBy: { select: { fullName: true } },
          },
        },
        startedBy: { select: { fullName: true } },
        approvedBy: { select: { fullName: true } },
        consignment: true,
      },
    });

    if (!qualityApproval) {
      return null;
    }

    // Group check items by status for summary
    const itemsByStatus = {
      pending: qualityApproval.checkItems.filter((item) => item.status === 'PENDING'),
      passed: qualityApproval.checkItems.filter((item) => item.result === 'PASS'),
      failed: qualityApproval.checkItems.filter((item) => item.result === 'FAIL'),
    };

    return {
      ...qualityApproval,
      summary: {
        totalItems: qualityApproval.totalItems,
        passedItems: qualityApproval.passedItems,
        failedItems: qualityApproval.failedItems,
        pendingItems: qualityApproval.totalItems - qualityApproval.passedItems - qualityApproval.failedItems,
        completionPercentage: Math.round(
          ((qualityApproval.passedItems + qualityApproval.failedItems) / qualityApproval.totalItems) * 100
        ),
      },
      itemsByStatus,
    };
  } catch (error) {
    console.error('Error getting quality status:', error);
    throw error;
  }
}

// ============================================================================
// GET FAILED ITEMS
// ============================================================================

/**
 * Get all failed QA check items for a consignment
 */
export async function getFailedItems(
  prisma: PrismaClient,
  qualityApprovalId: string
) {
  try {
    const failedItems = await prisma.qualityCheckItem.findMany({
      where: {
        qualityApprovalId,
        result: 'FAIL',
      },
      include: {
        consignmentItem: {
          include: { material: true },
        },
        checkedBy: { select: { fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return failedItems;
  } catch (error) {
    console.error('Error getting failed items:', error);
    throw error;
  }
}

// ============================================================================
// GENERATE QUALITY REPORT
// ============================================================================

/**
 * Generate comprehensive QA report for a consignment
 */
export async function generateQualityReport(
  prisma: PrismaClient,
  consignmentId: string
) {
  try {
    const consignment = await prisma.consignment.findUnique({
      where: { id: consignmentId },
      include: {
        supplier: { select: { id: true, name: true } },
        warehouse: { select: { id: true, name: true } },
        items: true,
      },
    });

    const qualityApproval = await prisma.qualityApproval.findUnique({
      where: { consignmentId },
      include: {
        checkItems: {
          include: {
            consignmentItem: {
              include: { material: true },
            },
            checkedBy: { select: { fullName: true } },
          },
        },
        startedBy: { select: { fullName: true } },
        approvedBy: { select: { fullName: true } },
      },
    });

    if (!consignment || !qualityApproval) {
      throw new Error('Consignment or quality approval not found');
    }

    const report = {
      consignment: {
        number: consignment.consignmentNumber,
        supplier: consignment.supplier?.name,
        warehouse: consignment.warehouse?.name,
        status: consignment.status,
        receivedAt: consignment.receivedAt,
      },
      qualityApproval: {
        status: qualityApproval.status,
        totalItems: qualityApproval.totalItems,
        passedItems: qualityApproval.passedItems,
        failedItems: qualityApproval.failedItems,
        startedBy: qualityApproval.startedBy?.fullName,
        startedAt: qualityApproval.startedAt,
        completedAt: qualityApproval.completedAt,
        approvedBy: qualityApproval.approvedBy?.fullName,
        approvedAt: qualityApproval.approvedAt,
        rejectionReason: qualityApproval.rejectionReason,
        notes: qualityApproval.notes,
      },
      details: {
        totalChecks: qualityApproval.checkItems.length,
        checksByType: {
          physical: qualityApproval.checkItems.filter((i) => i.checkType === 'PHYSICAL_INSPECTION').length,
          quantity: qualityApproval.checkItems.filter((i) => i.checkType === 'QUANTITY_VERIFICATION').length,
          expiry: qualityApproval.checkItems.filter((i) => i.checkType === 'EXPIRY_CHECK').length,
          packaging: qualityApproval.checkItems.filter((i) => i.checkType === 'PACKAGING_INSPECTION').length,
          documentation: qualityApproval.checkItems.filter((i) => i.checkType === 'DOCUMENTATION_REVIEW').length,
          lab: qualityApproval.checkItems.filter((i) => i.checkType === 'LABORATORY_TEST').length,
        },
        failedItems: qualityApproval.checkItems
          .filter((i) => i.result === 'FAIL')
          .map((i) => ({
            material: i.consignmentItem?.material?.name,
            checkType: i.checkType,
            remarks: i.remarks,
            checkedBy: i.checkedBy?.fullName,
            checkedAt: i.checkedAt,
          })),
      },
    };

    return report;
  } catch (error) {
    console.error('Error generating quality report:', error);
    throw error;
  }
}

// ============================================================================
// GET CONSIGNMENTS AWAITING QA
// ============================================================================

/**
 * Get list of consignments awaiting QA approval
 */
export async function getConsignmentsAwaitingQA(
  prisma: PrismaClient,
  limit: number = 50,
  offset: number = 0
) {
  try {
    const [consignments, total] = await Promise.all([
      prisma.consignment.findMany({
        where: {
          status: 'QUALITY_PENDING',
        },
        include: {
          supplier: { select: { id: true, name: true } },
          warehouse: { select: { id: true, name: true } },
          items: true,
          qualityApproval: {
            include: {
              checkItems: true,
              startedBy: { select: { fullName: true } },
            },
          },
        },
        orderBy: { receivedAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      prisma.consignment.count({
        where: { status: 'QUALITY_PENDING' },
      }),
    ]);

    return {
      consignments,
      pagination: { limit, offset, total, pages: Math.ceil(total / limit) },
    };
  } catch (error) {
    console.error('Error getting consignments awaiting QA:', error);
    throw error;
  }
}

// ============================================================================
// GET APPROVED CONSIGNMENTS (for stock manager access)
// ============================================================================

/**
 * Get approved consignments ready for stock manager distribution
 */
export async function getApprovedConsignments(
  prisma: PrismaClient,
  limit: number = 50,
  offset: number = 0
) {
  try {
    const [consignments, total] = await Promise.all([
      prisma.consignment.findMany({
        where: {
          status: 'QUALITY_APPROVED',
        },
        include: {
          supplier: { select: { id: true, name: true } },
          warehouse: { select: { id: true, name: true } },
          items: true,
          qualityApproval: {
            include: {
              approvedBy: { select: { fullName: true } },
            },
          },
        },
        orderBy: { receivedAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      prisma.consignment.count({
        where: { status: 'QUALITY_APPROVED' },
      }),
    ]);

    return {
      consignments,
      pagination: { limit, offset, total, pages: Math.ceil(total / limit) },
    };
  } catch (error) {
    console.error('Error getting approved consignments:', error);
    throw error;
  }
}

// ============================================================================
// DELETE QUALITY APPROVAL
// ============================================================================

/**
 * Delete a quality approval record and revert consignment status
 */
export async function deleteQualityApproval(
  prisma: PrismaClient,
  qualityApprovalId: string,
  deletedById: string
) {
  try {
    const qualityApproval = await prisma.qualityApproval.findUnique({
      where: { id: qualityApprovalId },
      include: { consignment: true, checkItems: true },
    });

    if (!qualityApproval) {
      throw new Error('Quality approval record not found');
    }

    // Only allow deletion if not yet approved
    if (qualityApproval.status === QualityApprovalStatus.APPROVED) {
      throw new Error('Cannot delete approved quality checks. Reject first if needed.');
    }

    // Delete all check items first (cascade)
    await prisma.qualityCheckItem.deleteMany({
      where: { qualityApprovalId },
    });

    // Delete the quality approval
    await prisma.qualityApproval.delete({
      where: { id: qualityApprovalId },
    });

    // Revert consignment to RECEIVED status (undo the QUALITY_PENDING)
    await prisma.consignment.update({
      where: { id: qualityApproval.consignmentId },
      data: {
        status: ConsignmentStatus.RECEIVED,
      },
    });

    // Log activity
    await logActivity({
      userId: deletedById,
      activityType: 'DELETE',
      module: 'qa',
      description: `Quality approval deleted for consignment ${qualityApproval.consignment.consignmentNumber}`,
      entityType: 'QualityApproval',
      entityId: qualityApprovalId,
    });

    return { success: true, message: 'Quality approval deleted and consignment reverted to RECEIVED' };
  } catch (error) {
    console.error('Error deleting quality approval:', error);
    throw error;
  }
}
