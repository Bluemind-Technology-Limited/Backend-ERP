/**
 * Production batch identity (SOP KIB/QCA/010 + QA approval).
 *
 * Every plan item (one batch formula = one produced batch) gets exactly one
 * `BatchLot` with a system-generated lot code at release time. QA approves (and
 * may revise) that code through the inspection flow. Grinding, finishing and WIP
 * all reference the same `batchLotId`, so no station ever invents its own batch
 * number.
 */
import { buildLotCode, buildYearCode } from '../lib/lotCode.js';

/** Internal vendor code used in finished-goods lot codes. */
export const FINISHED_VENDOR_CODE =
  (process.env.LOT_FINISHED_VENDOR_CODE ?? '').trim() || 'KIB';

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Allocate the next set number for one finished material + year.
 * An advisory transaction lock serialises concurrent releases for the same
 * material/year so two batches can never receive the same set number.
 */
async function allocateFinishedSetNumber(
  tx: any,
  materialId: string,
  yearCode: string
): Promise<number> {
  const key = `finished_lot_set:${materialId}:${yearCode}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;

  const highest = await tx.batchLot.aggregate({
    where: {
      materialId,
      supplierId: null,
      yearCode,
      setNumber: { not: null },
    },
    _max: { setNumber: true },
  });

  return (highest._max.setNumber ?? 0) + 1;
}

/**
 * Provision the production batch lot and its pending QA inspection for every
 * plan item that does not have one yet. Runs inside the release transaction.
 */
export async function provisionPlanBatches(
  tx: any,
  planId: string,
  productionDate: Date
) {
  const items = await tx.productionPlanItem.findMany({
    where: { productionPlanId: planId },
    include: {
      bom: {
        include: {
          finishedSku: {
            select: {
              id: true,
              name: true,
              traceabilityCode: true,
              shelfLifeDays: true,
              defaultExpiryDate: true,
              unitOfMeasure: true,
            },
          },
        },
      },
    },
    orderBy: { sequence: 'asc' },
  });

  const provisions: Array<{ planItemId: string; batchLotId: string; lotCode: string }> = [];

  for (const item of items) {
    if (item.batchLotId) continue;

    const sku = item.bom?.finishedSku;
    if (!sku) {
      throw new Error(
        `"${item.bom?.productName ?? 'Batch formula'}" has no finished product configured.`
      );
    }
    if (!sku.traceabilityCode) {
      throw new Error(
        `Finished product "${sku.name}" has no traceability code. Add it in Master Data → Products before releasing.`
      );
    }

    const yearCode = buildYearCode(productionDate);
    let setNumber = await allocateFinishedSetNumber(tx, sku.id, yearCode);
    let lotCode = buildLotCode({
      vendorCode: FINISHED_VENDOR_CODE,
      ingredientCode: sku.traceabilityCode,
      setNumber,
      yearCode,
    });

    // Two materials can share a traceability code; keep advancing until the
    // rendered code is globally unique.
    while (lotCode) {
      const clash = await tx.batchLot.findUnique({
        where: { lotCode },
        select: { id: true },
      });
      if (!clash) break;
      setNumber += 1;
      lotCode = buildLotCode({
        vendorCode: FINISHED_VENDOR_CODE,
        ingredientCode: sku.traceabilityCode,
        setNumber,
        yearCode,
      });
    }

    if (!lotCode) {
      throw new Error(`Could not build a lot code for "${sku.name}".`);
    }

    const expiryDate =
      sku.shelfLifeDays && Number(sku.shelfLifeDays) > 0
        ? addDays(productionDate, Number(sku.shelfLifeDays))
        : sku.defaultExpiryDate ?? null;

    const batchLot = await tx.batchLot.create({
      data: {
        materialId: sku.id,
        // The approved code is mirrored into batchNumber so legacy views and
        // labels always show the same identity.
        batchNumber: lotCode,
        lotCode,
        setNumber,
        vendorCode: FINISHED_VENDOR_CODE,
        ingredientCode: sku.traceabilityCode,
        yearCode,
        origin: 'FINISHED',
        // Quality approval is pending; the lot is released when QA approves it.
        status: 'QUARANTINE',
        manufacturingDate: productionDate,
        expiryDate,
        notes: `Production batch for plan ${planId}`,
      },
    });

    await tx.productionPlanItem.update({
      where: { id: item.id },
      data: { batchLotId: batchLot.id },
    });

    await tx.inspectionRecord.create({
      data: {
        inspectionType: 'FINISHED_BATCH',
        materialId: sku.id,
        batchLotId: batchLot.id,
        // The QA list resolves this to the plan number + product.
        referenceId: item.id,
        result: 'PENDING',
        notes: 'Awaiting QA approval of the production batch code',
      },
    });

    provisions.push({ planItemId: item.id, batchLotId: batchLot.id, lotCode });
  }

  return provisions;
}

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
