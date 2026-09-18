/**
 * Inspection Report Service
 *
 * Cross-consignment view of everything the quality team did: per-ingredient
 * consignment checks (`QualityCheckItem`), GRN/finished-batch inspections
 * (`InspectionRecord`), and the quantity changes QC proposed.
 *
 * The two check sources are normalised into one feed so admins get a single,
 * filterable audit trail.
 */
import { prisma } from '../lib/db.js';

export interface InspectionReportFilters {
  dateFrom?: string;
  dateTo?: string;
  consignmentId?: string;
  materialId?: string;
  checkType?: string;
  result?: string;
  checkedById?: string;
  approvalStatus?: string;
  q?: string;
  page?: number;
  limit?: number;
}

export interface NormalisedInspection {
  id: string;
  source: 'CONSIGNMENT_CHECK' | 'BATCH_INSPECTION';
  document: string | null; // consignment number / GRN / order reference
  material: { name: string; sku: string } | null;
  checkType: string;
  result: string;
  remarks: string | null;
  checkedBy: string | null;
  checkedAt: string | null;
  attachmentCount: number;
  approvalStatus: string | null;
}

const MAX_PER_SOURCE = 500;

export async function getInspectionReport(filters: InspectionReportFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(200, Math.max(1, filters.limit ?? 50));
  const search = filters.q?.trim();

  const dateFilter =
    filters.dateFrom || filters.dateTo
      ? {
          ...(filters.dateFrom ? { gte: new Date(filters.dateFrom) } : {}),
          ...(filters.dateTo ? { lte: new Date(filters.dateTo) } : {}),
        }
      : undefined;

  // ---- Source 1: consignment ingredient checks -----------------------------
  const checkWhere: any = {};
  if (dateFilter) checkWhere.checkedAt = dateFilter;
  if (filters.checkType) checkWhere.checkType = filters.checkType;
  if (filters.result) checkWhere.result = filters.result;
  if (filters.checkedById) checkWhere.checkedById = filters.checkedById;
  if (filters.materialId) checkWhere.consignmentItem = { materialId: filters.materialId };
  if (filters.consignmentId) checkWhere.qualityApproval = { consignmentId: filters.consignmentId };
  if (search) {
    checkWhere.OR = [
      { consignmentItem: { material: { name: { contains: search, mode: 'insensitive' } } } },
      { consignmentItem: { material: { sku: { contains: search, mode: 'insensitive' } } } },
      { qualityApproval: { consignment: { consignmentNumber: { contains: search, mode: 'insensitive' } } } },
    ];
  }

  const consignmentChecks = await prisma.qualityCheckItem.findMany({
    where: checkWhere,
    include: {
      consignmentItem: {
        include: {
          material: { select: { name: true, sku: true } },
          consignment: { select: { consignmentNumber: true } },
        },
      },
      checkedBy: { select: { fullName: true } },
      qualityApproval: { select: { status: true, consignment: { select: { consignmentNumber: true } } } },
      attachments: { select: { id: true } },
    },
    orderBy: [{ checkedAt: 'desc' }, { createdAt: 'desc' }],
    take: MAX_PER_SOURCE,
  });

  let feed: NormalisedInspection[] = consignmentChecks.map((c) => ({
    id: c.id,
    source: 'CONSIGNMENT_CHECK' as const,
    document:
      c.consignmentItem?.consignment?.consignmentNumber ??
      c.qualityApproval?.consignment?.consignmentNumber ??
      null,
    material: c.consignmentItem?.material
      ? { name: c.consignmentItem.material.name, sku: c.consignmentItem.material.sku }
      : null,
    checkType: c.checkType,
    result: c.result ?? 'PENDING',
    remarks: c.remarks,
    checkedBy: c.checkedBy?.fullName ?? null,
    checkedAt: c.checkedAt ? c.checkedAt.toISOString() : null,
    attachmentCount: c.attachments.length,
    approvalStatus: c.qualityApproval?.status ?? null,
  }));

  // ---- Source 2: GRN / finished-batch inspections --------------------------
  const inspectionWhere: any = {};
  if (dateFilter) inspectionWhere.inspectedAt = dateFilter;
  if (filters.result) inspectionWhere.result = filters.result;
  if (filters.checkedById) inspectionWhere.inspectedById = filters.checkedById;
  if (filters.materialId) inspectionWhere.materialId = filters.materialId;

  const batchInspections = await prisma.inspectionRecord.findMany({
    where: inspectionWhere,
    include: {
      material: { select: { name: true, sku: true } },
      batchLot: { select: { batchNumber: true } },
      inspector: { select: { fullName: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_PER_SOURCE,
  });

  feed = feed.concat(
    batchInspections.map((i) => ({
      id: i.id,
      source: 'BATCH_INSPECTION' as const,
      document: i.batchLot?.batchNumber ?? i.referenceId ?? null,
      material: i.material ? { name: i.material.name, sku: i.material.sku } : null,
      checkType: i.inspectionType,
      result: i.result,
      remarks: i.notes,
      checkedBy: i.inspector?.fullName ?? null,
      checkedAt: (i.inspectedAt ?? i.createdAt).toISOString(),
      attachmentCount: 0,
      approvalStatus: null,
    }))
  );

  // ---- Filter the merged feed (source-specific filters already applied) -----
  if (filters.q && search) {
    const needle = search.toLowerCase();
    feed = feed.filter(
      (row) =>
        (row.material?.name ?? '').toLowerCase().includes(needle) ||
        (row.material?.sku ?? '').toLowerCase().includes(needle) ||
        (row.document ?? '').toLowerCase().includes(needle)
    );
  }
  if (filters.approvalStatus) {
    feed = feed.filter((row) => row.approvalStatus === filters.approvalStatus);
  }

  feed.sort((a, b) => (b.checkedAt ?? '').localeCompare(a.checkedAt ?? ''));

  const total = feed.length;
  const items = feed.slice((page - 1) * limit, page * limit);

  // ---- Summary over the whole filtered set ---------------------------------
  const passed = feed.filter((r) => r.result === 'PASS' || r.result === 'PASSED').length;
  const failed = feed.filter((r) => r.result === 'FAIL' || r.result === 'FAILED').length;
  const pending = feed.filter((r) => r.result === 'PENDING').length;

  const byCheckType: Record<string, number> = {};
  const byInspector: Record<string, number> = {};
  const byDay: Record<string, number> = {};
  for (const row of feed) {
    byCheckType[row.checkType] = (byCheckType[row.checkType] ?? 0) + 1;
    const who = row.checkedBy ?? 'Unassigned';
    byInspector[who] = (byInspector[who] ?? 0) + 1;
    const day = (row.checkedAt ?? '').slice(0, 10);
    if (day) byDay[day] = (byDay[day] ?? 0) + 1;
  }

  // ---- Recent quantity changes (approved by Head of QC) ---------------------
  const adjustments = await prisma.quantityAdjustment.findMany({
    where: {
      ...(filters.consignmentId ? { consignmentId: filters.consignmentId } : {}),
      ...(dateFilter ? { requestedAt: dateFilter } : {}),
    },
    include: {
      material: { select: { name: true, sku: true } },
      requestedBy: { select: { fullName: true } },
      approvedBy: { select: { fullName: true } },
      consignment: { select: { consignmentNumber: true } },
    },
    orderBy: { requestedAt: 'desc' },
    take: 100,
  });

  return {
    items,
    adjustments,
    summary: {
      totalChecks: total,
      passed,
      failed,
      pending,
      consignmentChecks: feed.filter((r) => r.source === 'CONSIGNMENT_CHECK').length,
      batchInspections: feed.filter((r) => r.source === 'BATCH_INSPECTION').length,
      quantityAdjustments: adjustments.length,
      pendingQuantityAdjustments: adjustments.filter((a) => a.status === 'PENDING').length,
      byCheckType,
      byInspector,
      byDay,
    },
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    filters: { checkTypes: Object.keys(byCheckType), inspectors: Object.keys(byInspector) },
  };
}
