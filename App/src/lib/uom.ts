/**
 * Pack / unit-of-measure standard.
 *
 * A material is stocked and handled in **packs**. The pack is defined once on
 * the material as a value + unit — e.g. 25 KG, 500 G — and is rendered as the
 * material's unit of measure label ("25 KG"). Every quantity in the system is a
 * count of those packs, so `100` means 100 × 25 KG = 2,500 KG.
 */
export const PACK_UNITS = ["KG", "G", "PCS"] as const;
export type PackUnit = (typeof PACK_UNITS)[number];

/** Normalise the many ways a unit may be typed into the canonical code. */
export function normalizePackUnit(raw: unknown): PackUnit {
  const value = String(raw ?? "").trim().toUpperCase();
  switch (value) {
    case "KG":
    case "KGS":
    case "KILOGRAM":
    case "KILOGRAMS":
      return "KG";
    case "G":
    case "GR":
    case "GRAM":
    case "GRAMS":
      return "G";
    case "PCS":
    case "PC":
    case "PIECE":
    case "PIECES":
    case "UNIT":
    case "UNITS":
      return "PCS";
    default:
      throw new Error(`Unit must be one of: ${PACK_UNITS.join(", ")}`);
  }
}

/** Trim a pack size to at most 4 decimals without trailing zeros. */
export function formatPackNumber(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return "0";
  return String(Number(num.toFixed(4)));
}

/** The rendered unit-of-measure label, e.g. "25 KG". */
export function buildPackLabel(packSize: unknown, packUnit: unknown): string {
  const size = Number(packSize);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error("Pack size must be greater than zero");
  }
  return `${formatPackNumber(size)} ${normalizePackUnit(packUnit)}`;
}

/** Parse a rendered label back into its parts (used for legacy inputs). */
export function parsePackLabel(
  label: string | null | undefined
): { packSize: number; packUnit: PackUnit } | null {
  const match = String(label ?? "").trim().match(/^([\d.]+)\s*([A-Za-z]+)$/);
  if (!match) return null;
  const packSize = Number(match[1]);
  if (!Number.isFinite(packSize) || packSize <= 0) return null;
  try {
    return { packSize, packUnit: normalizePackUnit(match[2]) };
  } catch {
    return null;
  }
}

/** Weight of one pack in kilograms, or null for non-weight units. */
export function packWeightKg(packSize: unknown, packUnit: unknown): number | null {
  const size = Number(packSize);
  if (!Number.isFinite(size) || size <= 0) return null;
  const unit = normalizePackUnit(packUnit);
  if (unit === "KG") return size;
  if (unit === "G") return size / 1000;
  return null;
}

/** Weight of a pack count in kilograms, or null for non-weight units. */
export function quantityWeightKg(
  quantity: unknown,
  packSize: unknown,
  packUnit: unknown
): number | null {
  const qty = Number(quantity);
  const perPack = packWeightKg(packSize, packUnit);
  if (!Number.isFinite(qty) || perPack === null) return null;
  return Number((qty * perPack).toFixed(4));
}

export interface PackDefinition {
  packSize?: unknown;
  packUnit?: unknown;
  unitOfMeasure?: string | null;
}

/** One pack's weight in kg, from explicit pack fields or the rendered label. */
export function packWeightFrom(def: PackDefinition | null | undefined): number | null {
  if (!def) return null;
  try {
    if (def.packSize !== undefined && def.packSize !== null) {
      return packWeightKg(def.packSize, def.packUnit ?? "KG");
    }
    const parsed = parsePackLabel(def.unitOfMeasure);
    return parsed ? packWeightKg(parsed.packSize, parsed.packUnit) : null;
  } catch {
    return null;
  }
}

/**
 * Convert a percentage-of-batch ingredient into ingredient packs.
 *
 * A percentage is a percentage of the batch *weight*, so the finished unit is
 * converted to kg first and the ingredient kg is then divided by its pack
 * weight. Returns null when either side has no weight (e.g. PCS).
 */
export function percentageIngredientPacks(
  percentage: unknown,
  targetPacks: unknown,
  finished: PackDefinition | null | undefined,
  ingredient: PackDefinition | null | undefined
): number | null {
  const pct = Number(percentage);
  const target = Number(targetPacks);
  if (!Number.isFinite(pct) || !Number.isFinite(target) || pct <= 0) return null;

  const finishedKg = packWeightFrom(finished);
  const ingredientKg = packWeightFrom(ingredient);
  if (finishedKg === null || ingredientKg === null || ingredientKg <= 0) return null;

  return Number((((pct / 100) * target * finishedKg) / ingredientKg).toFixed(4));
}

/** Human-readable pack quantity, e.g. "100 × 25 KG = 2,500 KG". */
export function formatPackQuantity(quantity: unknown, unitLabel: string | null | undefined): string {
  const display = (value: number) =>
    new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
  const qty = display(Number(quantity));
  const parsed = parsePackLabel(unitLabel);
  if (!parsed) return unitLabel ? `${qty} ${unitLabel}` : qty;
  const weight = quantityWeightKg(quantity, parsed.packSize, parsed.packUnit);
  if (weight === null) return `${qty} × ${unitLabel}`;
  return `${qty} × ${unitLabel} = ${display(weight)} KG`;
}
