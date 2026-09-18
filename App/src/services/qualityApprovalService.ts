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
import * as storage from '../lib/storage.js';

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

    if (consignment.items.length === 0) {
      throw new Error('Consignment has no items to inspect');
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

    // Derive counters from the freshly created checks (keeps ingredient-level
    // progress authoritative from the start).
    await recomputeApprovalProgress(prisma, qualityApproval.id);

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
 * Recompute an approval's counters from its check items.
 *
 * Counters are tracked at *ingredient* (consignment item) granularity so a
 * consignment can hold several independent checks per ingredient: an ingredient
 * is PASSED only when every one of its checks passed, FAILED when any check
 * failed, and PENDING while any check is outstanding or none was recorded.
 */
export async function recomputeApprovalProgress(
  prisma: PrismaClient,
  qualityApprovalId: string
) {
  const approval = await prisma.qualityApproval.findUnique({
    where: { id: qualityApprovalId },
    include: {
      checkItems: true,
      consignment: { include: { items: true } },
    },
  });

  if (!approval) {
    throw new Error('Quality approval record not found');
  }

  type Bucket = { pending: number; failed: number; checks: number };
  const byIngredient = new Map<string, Bucket>();
  for (const item of approval.consignment.items) {
    byIngredient.set(item.id, { pending: 0, failed: 0, checks: 0 });
  }

  for (const check of approval.checkItems) {
    const bucket = byIngredient.get(check.consignmentItemId);
    if (!bucket) continue;
    bucket.checks += 1;
    if (check.status === 'PENDING' || !check.result) bucket.pending += 1;
    else if (check.result === 'FAIL') bucket.failed += 1;
  }

  let passedItems = 0;
  let failedItems = 0;
  let pendingItems = 0;
  for (const bucket of byIngredient.values()) {
    if (bucket.checks === 0 || bucket.pending > 0) pendingItems += 1;
    else if (bucket.failed > 0) failedItems += 1;
    else passedItems += 1;
  }

  const totalItems = byIngredient.size;
  let status: QualityApprovalStatus;
  if (pendingItems > 0) status = QualityApprovalStatus.IN_PROGRESS;
  else status = failedItems > 0 ? QualityApprovalStatus.FAILED : QualityApprovalStatus.PASSED;

  const updated = await prisma.qualityApproval.update({
    where: { id: qualityApprovalId },
    data: {
      totalItems,
      passedItems,
      failedItems,
      status,
      completedAt: pendingItems === 0 ? approval.completedAt ?? new Date() : null,
    },
  });

  return { ...updated, pendingItems };
}

/**
 * Record a QA check result for a consignment item.
 * Persists the check status (PASSED/FAILED) so it stops counting as pending.
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

    if (['APPROVED', 'REJECTED'].includes(checkItem.qualityApproval.status)) {
      throw new Error(
        `Cannot modify checks: quality approval is already ${checkItem.qualityApproval.status}`
      );
    }

    const updatedItem = await prisma.qualityCheckItem.update({
      where: { id: checkItemId },
      data: {
        checkType: data.checkType as QualityCheckType,
        result: data.result,
        status:
          data.result === 'PASS' ? QualityApprovalStatus.PASSED : QualityApprovalStatus.FAILED,
        remarks: data.remarks,
        checkedAt: new Date(),
        checkedById: data.inspectorId,
      },
    });

    await recomputeApprovalProgress(prisma, checkItem.qualityApprovalId);

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
// ADD INDEPENDENT CHECK
// ============================================================================

/**
 * Append an extra, independent check to a specific ingredient.
 *
 * A consignment groups many ingredients, but each ingredient is checked on its
 * own; a single ingredient may carry more than one check type (e.g. physical
 * inspection + laboratory test), each recorded as its own row.
 */
export async function addCheckItem(
  prisma: PrismaClient,
  qualityApprovalId: string,
  data: {
    consignmentItemId: string;
    checkType: QualityCheckType | string;
    result?: 'PASS' | 'FAIL';
    remarks?: string;
    inspectorId: string;
  }
) {
  try {
    const approval = await prisma.qualityApproval.findUnique({
      where: { id: qualityApprovalId },
      include: { consignment: { include: { items: true } } },
    });

    if (!approval) {
      throw new Error('Quality approval record not found');
    }

    if (['APPROVED', 'REJECTED'].includes(approval.status)) {
      throw new Error(`Cannot add checks: quality approval is already ${approval.status}`);
    }

    const belongsToConsignment = approval.consignment.items.some(
      (item) => item.id === data.consignmentItemId
    );
    if (!belongsToConsignment) {
      throw new Error('Consignment item does not belong to this consignment');
    }

    const check = await prisma.qualityCheckItem.create({
      data: {
        qualityApprovalId,
        consignmentItemId: data.consignmentItemId,
        checkType: data.checkType as QualityCheckType,
        result: data.result,
        status: data.result
          ? data.result === 'PASS'
            ? QualityApprovalStatus.PASSED
            : QualityApprovalStatus.FAILED
          : QualityApprovalStatus.PENDING,
        remarks: data.remarks,
        checkedAt: data.result ? new Date() : null,
        checkedById: data.result ? data.inspectorId : null,
      },
    });

    await recomputeApprovalProgress(prisma, qualityApprovalId);

    await logActivity({
      userId: data.inspectorId,
      activityType: 'CREATE',
      module: 'qa',
      description: `QA check added (${data.checkType}) for consignment ${approval.consignment.consignmentNumber}`,
      entityType: 'QualityCheckItem',
      entityId: check.id,
    });

    return check;
  } catch (error) {
    console.error('Error adding check item:', error);
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

    // Recompute ingredient-level progress so stale counters can never gate approval.
    const progress = await recomputeApprovalProgress(prisma, qualityApprovalId);

    if (progress.totalItems === 0) {
      throw new Error('Cannot approve: consignment has no items to check');
    }
    if (progress.pendingItems > 0) {
      throw new Error(`Cannot approve: ${progress.pendingItems} ingredient(s) still pending checks`);
    }
    if (progress.failedItems > 0) {
      throw new Error(`Cannot approve: ${progress.failedItems} ingredient(s) failed QA checks`);
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
              include: {
                material: {
                  select: { id: true, name: true, sku: true, unitOfMeasure: true },
                },
              },
            },
            checkedBy: { select: { fullName: true } },
            attachments: {
              include: { uploadedBy: { select: { fullName: true } } },
              orderBy: { createdAt: 'asc' },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
        startedBy: { select: { fullName: true } },
        approvedBy: { select: { fullName: true } },
        consignment: {
          include: {
            supplier: { select: { id: true, name: true } },
            warehouse: { select: { id: true, name: true } },
            items: {
              include: {
                material: {
                  select: { id: true, name: true, sku: true, unitOfMeasure: true },
                },
              },
              orderBy: { materialId: 'asc' },
            },
          },
        },
      },
    });

    if (!qualityApproval) {
      return null;
    }

    // Sign every attachment so the client can open the proof directly.
    const checkItems = await Promise.all(
      qualityApproval.checkItems.map(async (item) => ({
        ...item,
        attachments: await Promise.all(
          item.attachments.map(async (attachment) => ({
            ...attachment,
            url: await storage.createQaReadUrl(attachment.storagePath),
          }))
        ),
      }))
    );

    // Group the independent checks under the ingredient they belong to.
    const ingredientMap = new Map<string, any>();
    for (const consignmentItem of qualityApproval.consignment.items) {
      ingredientMap.set(consignmentItem.id, {
        consignmentItemId: consignmentItem.id,
        material: consignmentItem.material,
        quantity: consignmentItem.quantity,
        distributedQty: consignmentItem.distributedQty,
        unitOfMeasure: consignmentItem.unitOfMeasure,
        status: 'PENDING',
        attachmentCount: 0,
        checks: [],
      });
    }

    for (const check of checkItems) {
      const group = ingredientMap.get(check.consignmentItemId);
      if (!group) continue;
      group.checks.push(check);
      group.attachmentCount += check.attachments.length;
    }

    let passedItems = 0;
    let failedItems = 0;
    let pendingItems = 0;
    for (const group of ingredientMap.values()) {
      const hasPending = group.checks.some(
        (check: any) => check.status === 'PENDING' || !check.result
      );
      const hasFailed = group.checks.some((check: any) => check.result === 'FAIL');
      if (group.checks.length === 0 || hasPending) {
        group.status = 'PENDING';
        pendingItems += 1;
      } else if (hasFailed) {
        group.status = 'FAILED';
        failedItems += 1;
      } else {
        group.status = 'PASSED';
        passedItems += 1;
      }
    }

    const totalItems = ingredientMap.size;
    const itemsByStatus = {
      pending: checkItems.filter((item) => item.status === 'PENDING' || !item.result),
      passed: checkItems.filter((item) => item.result === 'PASS'),
      failed: checkItems.filter((item) => item.result === 'FAIL'),
    };

    return {
      ...qualityApproval,
      checkItems,
      itemsByIngredient: Array.from(ingredientMap.values()),
      itemsByStatus,
      summary: {
        totalItems,
        passedItems,
        failedItems,
        pendingItems,
        totalChecks: checkItems.length,
        completionPercentage:
          totalItems === 0
            ? 0
            : Math.round(((passedItems + failedItems) / totalItems) * 100),
      },
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
        attachments: {
          include: { uploadedBy: { select: { fullName: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return Promise.all(
      failedItems.map(async (item) => ({
        ...item,
        attachments: await Promise.all(
          item.attachments.map(async (attachment) => ({
            ...attachment,
            url: await storage.createQaReadUrl(attachment.storagePath),
          }))
        ),
      }))
    );
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
            attachments: true,
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
            proofCount: i.attachments?.length ?? 0,
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
          // RECEIVED = received but QA not yet started; QUALITY_PENDING = in progress.
          status: { in: ['RECEIVED', 'QUALITY_PENDING'] },
        },
        include: {
          supplier: { select: { id: true, name: true } },
          warehouse: { select: { id: true, name: true } },
          items: {
            include: {
              material: {
                select: { id: true, name: true, sku: true, unitOfMeasure: true },
              },
            },
          },
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
        where: { status: { in: ['RECEIVED', 'QUALITY_PENDING'] } },
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
          items: {
            include: {
              material: {
                select: { id: true, name: true, sku: true, unitOfMeasure: true },
              },
            },
          },
          qualityApproval: {
            include: {
              checkItems: true,
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
// PROOF-OF-CHECK ATTACHMENTS
// ============================================================================

const EDITABLE_APPROVAL_STATUSES = ['PENDING', 'IN_PROGRESS', 'PASSED', 'FAILED'];

/**
 * Mint a signed upload URL for a proof file tied to a specific check item.
 * The row is only created once the client confirms the upload (see
 * `createAttachment`).
 */
export async function createAttachmentUploadUrl(
  prisma: PrismaClient,
  checkItemId: string,
  fileName: string
) {
  const checkItem = await prisma.qualityCheckItem.findUnique({
    where: { id: checkItemId },
    include: { qualityApproval: true },
  });

  if (!checkItem) {
    throw new Error('Quality check item not found');
  }
  if (!EDITABLE_APPROVAL_STATUSES.includes(checkItem.qualityApproval.status)) {
    throw new Error(
      `Cannot upload proof: quality approval is already ${checkItem.qualityApproval.status}`
    );
  }

  const path = storage.buildQaAttachmentPath(
    checkItem.qualityApproval.consignmentId,
    checkItemId,
    fileName
  );
  const upload = await storage.createQaUploadUrl(path);

  return {
    ...upload,
    checkItemId,
    consignmentId: checkItem.qualityApproval.consignmentId,
  };
}

/** Register attachment metadata after the binary has been uploaded. */
export async function createAttachment(
  prisma: PrismaClient,
  checkItemId: string,
  data: {
    fileName: string;
    storagePath: string;
    mimeType?: string;
    fileSize?: number;
    kind?: string;
    uploadedById: string;
  }
) {
  const checkItem = await prisma.qualityCheckItem.findUnique({
    where: { id: checkItemId },
    include: { qualityApproval: true },
  });

  if (!checkItem) {
    throw new Error('Quality check item not found');
  }
  if (!EDITABLE_APPROVAL_STATUSES.includes(checkItem.qualityApproval.status)) {
    throw new Error(
      `Cannot attach proof: quality approval is already ${checkItem.qualityApproval.status}`
    );
  }

  // Guard against a caller registering an object outside this check's folder.
  const expectedPrefix = `consignments/${checkItem.qualityApproval.consignmentId}/checks/${checkItemId}/`;
  if (!data.storagePath.startsWith(expectedPrefix)) {
    throw new Error('storagePath does not match this check item');
  }

  const attachment = await prisma.qualityCheckAttachment.create({
    data: {
      qualityCheckItemId: checkItemId,
      consignmentId: checkItem.qualityApproval.consignmentId,
      fileName: data.fileName,
      storagePath: data.storagePath,
      mimeType: data.mimeType,
      fileSize: data.fileSize,
      kind: data.kind,
      uploadedById: data.uploadedById,
    },
    include: { uploadedBy: { select: { fullName: true } } },
  });

  await logActivity({
    userId: data.uploadedById,
    activityType: 'CREATE',
    module: 'qa',
    description: `QA proof attached: ${data.fileName}`,
    entityType: 'QualityCheckAttachment',
    entityId: attachment.id,
  });

  return {
    ...attachment,
    url: await storage.createQaReadUrl(attachment.storagePath),
  };
}

/** List the proof attached to a single check item, with signed read URLs. */
export async function listAttachments(prisma: PrismaClient, checkItemId: string) {
  const attachments = await prisma.qualityCheckAttachment.findMany({
    where: { qualityCheckItemId: checkItemId },
    include: { uploadedBy: { select: { fullName: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return Promise.all(
    attachments.map(async (attachment) => ({
      ...attachment,
      url: await storage.createQaReadUrl(attachment.storagePath),
    }))
  );
}

/** All proof attached anywhere on a consignment (for the detail view). */
export async function listConsignmentAttachments(
  prisma: PrismaClient,
  consignmentId: string
) {
  const attachments = await prisma.qualityCheckAttachment.findMany({
    where: { consignmentId },
    include: { uploadedBy: { select: { fullName: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return Promise.all(
    attachments.map(async (attachment) => ({
      ...attachment,
      url: await storage.createQaReadUrl(attachment.storagePath),
    }))
  );
}

/** Delete a proof file (row + storage object). Blocked once approved. */
export async function deleteAttachment(
  prisma: PrismaClient,
  attachmentId: string,
  deletedById: string
) {
  const attachment = await prisma.qualityCheckAttachment.findUnique({
    where: { id: attachmentId },
    include: { qualityCheckItem: { include: { qualityApproval: true } } },
  });

  if (!attachment) {
    throw new Error('Attachment not found');
  }

  const approvalStatus = attachment.qualityCheckItem.qualityApproval.status;
  if (approvalStatus === 'APPROVED') {
    throw new Error('Cannot delete proof from an approved consignment. Reject first if needed.');
  }

  await prisma.qualityCheckAttachment.delete({ where: { id: attachmentId } });

  try {
    await storage.removeQaObject(attachment.storagePath);
  } catch (error) {
    // The metadata row is already gone; surface the storage issue without failing.
    console.error('Failed to remove attachment object from storage:', error);
  }

  await logActivity({
    userId: deletedById,
    activityType: 'DELETE',
    module: 'qa',
    description: `QA proof deleted: ${attachment.fileName}`,
    entityType: 'QualityCheckAttachment',
    entityId: attachmentId,
  });

  return { success: true };
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
      include: {
        consignment: true,
        checkItems: { include: { attachments: true } },
      },
    });

    if (!qualityApproval) {
      throw new Error('Quality approval record not found');
    }

    // Only allow deletion if not yet approved
    if (qualityApproval.status === QualityApprovalStatus.APPROVED) {
      throw new Error('Cannot delete approved quality checks. Reject first if needed.');
    }

    // Delete all check items first (cascade removes attachment rows)
    const storagePaths = qualityApproval.checkItems.flatMap((item) =>
      item.attachments.map((attachment) => attachment.storagePath)
    );

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

    // Best-effort cleanup of the orphaned proof files.
    await Promise.all(
      storagePaths.map((path) =>
        storage.removeQaObject(path).catch((error) =>
          console.error('Failed to remove attachment object from storage:', error)
        )
      )
    );

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
