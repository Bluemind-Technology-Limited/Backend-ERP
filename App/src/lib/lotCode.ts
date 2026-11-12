import type { PrismaClient } from "@prisma/client";

/** The shared client, or a transaction client (which omits the lifecycle methods). */
export type PrismaLike =
  | PrismaClient
  | Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$use" | "$extends">;

/**
 * SOP KIB/QCA/010 — Lot coding and traceability.
 *
 * Lot code = [Vendor Code] + [Ingredient Code] + [Material Set Number] + [Year Code]
 *
 * The parts are separated by dashes on purpose. Concatenating them without a
 * separator is ambiguous once either number passes 9 — e.g. vendor "A",
 * ingredient "1", set "11" and vendor "A", ingredient "11", set "1" both
 * collapse to "A111". With separators they stay distinguishable: "A-1-11" and
 * "A-11-1".
 */
export const LOT_CODE_SEPARATOR = "-";

export interface LotCodeParts {
  vendorCode?: string | null;
  ingredientCode?: string | null;
  setNumber?: number | null;
  yearCode?: string | null;
}

export type LotCodeRequirement = "vendorCode" | "ingredientCode" | "setNumber" | "yearCode";

/** Renders the lot code, or null when any part is still missing. */
export function buildLotCode(parts: LotCodeParts): string | null {
  const { vendorCode, ingredientCode, setNumber, yearCode } = parts;
  if (!vendorCode || !ingredientCode || setNumber === null || setNumber === undefined || !yearCode) {
    return null;
  }
  return [vendorCode, ingredientCode, String(setNumber), yearCode].join(LOT_CODE_SEPARATOR);
}

/** Last two digits of the year, e.g. 2026 -> "26". */
export function buildYearCode(date: Date = new Date()): string {
  return String(date.getFullYear()).slice(-2);
}

/** Which parts are still missing — drives the "cannot build the code yet" hint. */
export function missingLotCodeParts(parts: LotCodeParts): LotCodeRequirement[] {
  const missing: LotCodeRequirement[] = [];
  if (!parts.vendorCode) missing.push("vendorCode");
  if (!parts.ingredientCode) missing.push("ingredientCode");
  if (parts.setNumber === null || parts.setNumber === undefined) missing.push("setNumber");
  if (!parts.yearCode) missing.push("yearCode");
  return missing;
}

/**
 * Next incoming set number for one supplier + ingredient + year.
 *
 * Scope is supplier + material + year, so numbering restarts each year and the
 * rendered code stays unique (the year part differs anyway).
 */
export async function nextSetNumber(
  client: PrismaLike,
  scope: { supplierId?: string | null; materialId: string; yearCode: string }
): Promise<number> {
  const highest = await client.batchLot.aggregate({
    where: {
      materialId: scope.materialId,
      yearCode: scope.yearCode,
      supplierId: scope.supplierId ?? null,
      setNumber: { not: null },
    },
    _max: { setNumber: true },
  });

  return (highest._max.setNumber ?? 0) + 1;
}

/** A set number must be a positive whole number. */
export function isValidSetNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export interface SetNumberEditResult {
  batchLotId: string;
  oldSetNumber: number | null;
  oldLotCode: string | null;
  setNumber: number;
  lotCode: string | null;
}

/**
 * Apply a set number supplied/edited by QA and rebuild the lot code from the
 * snapshotted vendor, ingredient and year parts.
 *
 * The set number is unique within supplier + material + year. The receiving
 * batch number is kept in step while it still mirrors the old lot code, so the
 * two identifiers never drift apart. Returns null when no number was supplied.
 */
export async function updateBatchLotSetNumber(
  client: PrismaLike,
  batchLotId: string,
  rawSetNumber: unknown
): Promise<SetNumberEditResult | null> {
  if (rawSetNumber === undefined || rawSetNumber === null || String(rawSetNumber).trim() === "") {
    return null;
  }

  const setNumber = Number(rawSetNumber);
  if (!isValidSetNumber(setNumber)) {
    throw new Error("Set number must be a positive whole number");
  }

  const batchLot = await client.batchLot.findUnique({
    where: { id: batchLotId },
    select: {
      id: true,
      materialId: true,
      supplierId: true,
      setNumber: true,
      lotCode: true,
      batchNumber: true,
      vendorCode: true,
      ingredientCode: true,
      yearCode: true,
    },
  });
  if (!batchLot) throw new Error("Batch lot not found");

  if (batchLot.setNumber === setNumber) {
    return {
      batchLotId,
      oldSetNumber: batchLot.setNumber,
      oldLotCode: batchLot.lotCode,
      setNumber,
      lotCode: batchLot.lotCode,
    };
  }

  if (batchLot.yearCode) {
    const clash = await client.batchLot.findFirst({
      where: {
        id: { not: batchLotId },
        materialId: batchLot.materialId,
        supplierId: batchLot.supplierId,
        yearCode: batchLot.yearCode,
        setNumber,
      },
      select: { id: true },
    });
    if (clash) {
      throw new Error(
        `Set number ${setNumber} is already used for this supplier, material and year`
      );
    }
  }

  const lotCode = buildLotCode({
    vendorCode: batchLot.vendorCode,
    ingredientCode: batchLot.ingredientCode,
    setNumber,
    yearCode: batchLot.yearCode,
  });

  if (lotCode) {
    const codeClash = await client.batchLot.findFirst({
      where: { id: { not: batchLotId }, lotCode },
      select: { id: true },
    });
    if (codeClash) {
      throw new Error(`Lot code "${lotCode}" is already used`);
    }
  }

  const data: { setNumber: number; lotCode?: string; batchNumber?: string } = { setNumber };
  if (lotCode) {
    data.lotCode = lotCode;
    // Only follow the code when the receiving batch number was mirroring it.
    if (batchLot.lotCode && batchLot.batchNumber === batchLot.lotCode) {
      data.batchNumber = lotCode;
    }
  }

  await client.batchLot.update({ where: { id: batchLotId }, data });

  return {
    batchLotId,
    oldSetNumber: batchLot.setNumber,
    oldLotCode: batchLot.lotCode,
    setNumber,
    lotCode: lotCode ?? batchLot.lotCode,
  };
}
