/**
 * Legacy finished-batch inspection helpers.
 *
 * Finished products do not get a lot code or a BatchLot: lot codes belong to
 * received materials only, and the production identity is the order number plus
 * the grinding batch number recorded at the grinding station. These helpers stay
 * so inspections created before that rule can still be resolved.
 */
/**
 * Apply a QA approval to a finished production batch. The lot code is already
 * stored; this marks it authoritative, activates the lot and stamps the plan
 * item with who approved it and when.
 */
export async function applyFinishedBatchApproval(
  tx: any,
  input: {
    inspectionId: string;
    batchLotId: string;
    userId: string;
    notes?: string | null;
    /** Final rendered code after any QA set-number edit. */
    lotCode?: string | null;
  }
) {
  const approvedAt = new Date();

  await tx.inspectionRecord.update({
    where: { id: input.inspectionId },
    data: {
      result: 'PASSED',
      notes: input.notes?.trim() ? input.notes.trim() : null,
      inspectedById: input.userId,
      inspectedAt: approvedAt,
    },
  });

  await tx.batchLot.update({
    where: { id: input.batchLotId },
    data: { status: 'ACTIVE' },
  });

  await tx.productionPlanItem.updateMany({
    where: { batchLotId: input.batchLotId },
    data: { batchApprovedAt: approvedAt, batchApprovedById: input.userId },
  });

  // Keep the legacy batchNumber snapshot on stage records aligned with a
  // QA-revised lot code.
  if (input.lotCode) {
    await tx.productionStageRecord.updateMany({
      where: { batchLotId: input.batchLotId },
      data: { batchNumber: input.lotCode },
    });
  }

  return approvedAt;
}

/** Reject a finished production batch and clear its approval stamp. */
export async function applyFinishedBatchRejection(
  tx: any,
  input: {
    inspectionId: string;
    batchLotId: string;
    userId: string;
    notes?: string | null;
  }
) {
  await tx.inspectionRecord.update({
    where: { id: input.inspectionId },
    data: {
      result: 'FAILED',
      notes: input.notes ?? undefined,
      inspectedById: input.userId,
      inspectedAt: new Date(),
    },
  });

  await tx.batchLot.update({
    where: { id: input.batchLotId },
    data: { status: 'REJECTED' },
  });

  await tx.productionPlanItem.updateMany({
    where: { batchLotId: input.batchLotId },
    data: { batchApprovedAt: null, batchApprovedById: null },
  });
}
