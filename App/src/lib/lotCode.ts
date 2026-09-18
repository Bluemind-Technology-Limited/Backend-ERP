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
