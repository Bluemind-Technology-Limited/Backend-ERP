import { PrismaClient, LedgerEventType } from "../generated/prisma/client.js";

/**
 * KIB ERP — Inventory Ledger Engine
 *
 * THE ONLY writer of stock. Every movement is an immutable `InventoryTransaction`.
 * "Current stock" is ALWAYS derived: SUM(quantity) per material / batch / warehouse.
 * There is no mutable stock column anywhere.
 *
 * All other modules (GRN, production consumption, transfers, adjustments) must
 * go through this service — never call prisma.inventoryTransaction.create directly
 * outside of this file.
 */

export interface LedgerEntryInput {
  eventType: LedgerEventType;
  materialId: string;
  batchLotId?: string | null;
  warehouseId: string;
  binId?: string | null;
  quantity: number; // signed: + in, - out
  unitOfMeasure: string;
  referenceType?: string | null; // PO, GRN, PROD_ORDER, ADJUSTMENT, TRANSFER
  referenceId?: string | null;
  createdById: string;
  approvedById?: string | null; // set for gated ADJUSTMENT entries
  notes?: string | null;
}

/**
 * Minimal DB surface accepted by the ledger writer so it works both with the
 * top-level PrismaClient and inside prisma.$transaction(...) transaction clients.
 */
export interface LedgerDb {
  inventoryTransaction: {
    create: (args: { data: any }) => Promise<any>;
  };
}

/** Append an immutable ledger entry. */
export async function postLedgerEntry(tx: LedgerDb, input: LedgerEntryInput) {
  if (input.quantity === 0) throw new Error("Ledger entries cannot have zero quantity");
  return tx.inventoryTransaction.create({
    data: {
      eventType: input.eventType,
      materialId: input.materialId,
      batchLotId: input.batchLotId ?? null,
      warehouseId: input.warehouseId,
      binId: input.binId ?? null,
      quantity: input.quantity,
      unitOfMeasure: input.unitOfMeasure,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      createdById: input.createdById,
      approvedById: input.approvedById ?? null,
      notes: input.notes ?? null,
    },
  });
}

export interface StockRow {
  materialId: string;
  materialName: string;
  sku: string;
  unitOfMeasure: string;
  batchLotId: string | null;
  batchNumber: string | null;
  warehouseId: string;
  warehouseName: string;
  binId: string | null;
  quantity: number; // SUM of signed ledger entries
}

/** Derive current stock: SUM(quantity) grouped per material/batch/warehouse/bin. */
export async function getStock(
  prisma: PrismaClient,
  filters?: { materialId?: string; warehouseId?: string; batchLotId?: string }
): Promise<StockRow[]> {
  const where: any = {};
  if (filters?.materialId) where.materialId = filters.materialId;
  if (filters?.warehouseId) where.warehouseId = filters.warehouseId;
  if (filters?.batchLotId) where.batchLotId = filters.batchLotId;

  const grouped = await prisma.inventoryTransaction.groupBy({
    by: ["materialId", "warehouseId", "batchLotId", "binId", "unitOfMeasure"],
    where,
    _sum: { quantity: true },
  });

  const materialIds = [...new Set(grouped.map((g) => g.materialId))];
  const warehouseIds = [...new Set(grouped.map((g) => g.warehouseId))];
  const batchIds = [...new Set(grouped.map((g) => g.batchLotId).filter(Boolean))] as string[];

  const [materials, warehouses, batches] = await Promise.all([
    prisma.material.findMany({ where: { id: { in: materialIds } }, select: { id: true, name: true, sku: true, unitOfMeasure: true } }),
    prisma.warehouse.findMany({ where: { id: { in: warehouseIds } }, select: { id: true, name: true } }),
    batchIds.length
      ? prisma.batchLot.findMany({ where: { id: { in: batchIds } }, select: { id: true, batchNumber: true } })
      : Promise.resolve([]),
  ]);

  const matMap = new Map(materials.map((m) => [m.id, m]));
  const whMap = new Map(warehouses.map((w) => [w.id, w]));
  const batchMap = new Map(batches.map((b) => [b.id, b]));

  return grouped
    .filter((g) => (g._sum.quantity ?? 0) !== 0)
    .map((g) => ({
      materialId: g.materialId,
      materialName: matMap.get(g.materialId)?.name ?? g.materialId,
      sku: matMap.get(g.materialId)?.sku ?? "",
      unitOfMeasure: g.unitOfMeasure,
      batchLotId: g.batchLotId,
      batchNumber: g.batchLotId ? batchMap.get(g.batchLotId)?.batchNumber ?? null : null,
      warehouseId: g.warehouseId,
      warehouseName: whMap.get(g.warehouseId)?.name ?? g.warehouseId,
      binId: g.binId,
      quantity: Number(g._sum.quantity ?? 0),
    }))
    .sort((a, b) => (a.quantity < b.quantity ? 1 : -1));
}

/** Get the full transaction history (audit trail) for a material/batch. */
export async function getLedgerHistory(
  prisma: PrismaClient,
  filters?: { materialId?: string; batchLotId?: string }
) {
  return prisma.inventoryTransaction.findMany({
    where: {
      ...(filters?.materialId ? { materialId: filters.materialId } : {}),
      ...(filters?.batchLotId ? { batchLotId: filters.batchLotId } : {}),
    },
    include: {
      material: { select: { name: true, sku: true } },
      batchLot: { select: { batchNumber: true } },
      warehouse: { select: { name: true } },
      createdBy: { select: { fullName: true, email: true } },
      approvedBy: { select: { fullName: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}
