import { prisma } from "../lib/db.js";
import { postLedgerEntry } from "../lib/ledger.js";
import { LedgerEventType } from "@prisma/client";
import { packWeightFrom, percentageIngredientPacks } from "../lib/uom.js";
import { notifyStationWorkOrders, refreshStationWorkOrders } from "./productionStationService.js";
import { provisionPlanBatches } from "./productionBatchService.js";
import { logActivity } from "./userActivityLogger.js";

export interface CreateProductionPlanInput {
  description?: string;
  scheduledFor?: Date;
  createdById: string;
  /**
   * Explicit plan number. Production orders pass their own PRD- number here so
   * one order has one identifier across the plan, the stations and the ledger.
   */
  planNumber?: string;
  /** Products (batch formulations) to run on this plan, in order. */
  items?: Array<{ bomId: string; targetQuantity: number }>;
}

export interface AggregatedIngredient {
  materialId: string;
  materialName: string;
  sku: string;
  unitOfMeasure: string;
  totalQuantity: number;
  itemCount: number; // how many plan items use this ingredient
}

/**
 * Create a new production plan (starts in DRAFT status).
 *
 * The selected batch formulations are created with the plan in one write, so a
 * plan can never end up half-built if one product fails validation.
 */
export async function createProductionPlan(input: CreateProductionPlanInput) {
  try {
    const planNumber = input.planNumber ?? `PLAN-${Date.now().toString().slice(-8)}`;
    const items = input.items ?? [];

    if (items.length > 0) {
      const bomIds = items.map((item) => item.bomId);
      if (new Set(bomIds).size !== bomIds.length) {
        throw new Error("Each product can only be added to the plan once");
      }

      const invalid = items.find(
        (item) => !item.bomId || !Number.isFinite(item.targetQuantity) || item.targetQuantity <= 0
      );
      if (invalid) {
        throw new Error("Every selected product needs a positive target quantity");
      }

      const boms = await prisma.bom.findMany({
        where: { id: { in: bomIds } },
        select: { id: true, productName: true, status: true },
      });
      if (boms.length !== bomIds.length) {
        throw new Error("One or more batch formulations were not found");
      }

      const notReady = boms.find((b) => b.status !== "ACTIVE" && b.status !== "APPROVED");
      if (notReady) {
        throw new Error(
          `"${notReady.productName}" is ${notReady.status}. Approve the batch formulation before planning it.`
        );
      }
    }

    const plan = await prisma.productionPlan.create({
      data: {
        planNumber,
        description: input.description,
        status: "DRAFT",
        scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
        createdById: input.createdById,
        items: items.length
          ? {
              create: items.map((item, index) => ({
                bomId: item.bomId,
                targetQuantity: Number(item.targetQuantity),
                sequence: index + 1,
              })),
            }
          : undefined,
      },
      include: {
        items: {
          include: {
            bom: {
              select: { id: true, productName: true, finishedSku: { select: { sku: true } } },
            },
          },
          orderBy: { sequence: "asc" },
        },
        createdBy: { select: { id: true, fullName: true, email: true } },
      },
    });

    // Aggregated ingredients are a derived cache of the plan's items.
    if (items.length > 0) {
      await aggregateIngredientsForPlan(plan.id);

      // Work orders exist as soon as the plan has requirements; stations are
      // notified when the plan is actually released.
      await refreshStationWorkOrders(plan.id).catch((error) =>
        console.error("refreshStationWorkOrders (plan) failed:", error)
      );
    }

    console.log(`✓ Created production plan: ${plan.planNumber} (${items.length} product(s))`);
    return plan;
  } catch (error) {
    console.error("createProductionPlan error:", error);
    throw error;
  }
}

/**
 * Edit a DRAFT production plan: description/date and the full set of batch
 * formulations (each keeps its own target quantity and identity).
 */
export async function updateProductionPlan(
  planId: string,
  data: {
    description?: string | null;
    scheduledFor?: Date | null;
    items: Array<{ bomId: string; targetQuantity: number }>;
  }
) {
  try {
    const plan = await prisma.productionPlan.findUnique({
      where: { id: planId },
      select: { id: true, status: true },
    });
    if (!plan) throw new Error(`Production plan not found: ${planId}`);
    if (plan.status !== "DRAFT") {
      throw new Error(
        `Only DRAFT production plans can be edited. Current status: ${plan.status}`
      );
    }

    const items = data.items ?? [];
    if (items.length === 0) throw new Error("Select at least one batch formulation");
    if (items.some((item) => !item.bomId || !(Number(item.targetQuantity) > 0))) {
      throw new Error("Every batch formulation needs a positive target quantity");
    }

    const bomIds = items.map((item) => item.bomId);
    if (new Set(bomIds).size !== bomIds.length) {
      throw new Error("Each batch formulation can only be added once");
    }

    const boms = await prisma.bom.findMany({
      where: { id: { in: bomIds } },
      select: { id: true, productName: true, status: true },
    });
    if (boms.length !== bomIds.length) {
      throw new Error("One or more batch formulations were not found");
    }
    const notReady = boms.find((b) => b.status !== "ACTIVE" && b.status !== "APPROVED");
    if (notReady) {
      throw new Error(
        `"${notReady.productName}" is ${notReady.status}. Approve the batch formulation before planning it.`
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.productionPlanItem.deleteMany({ where: { productionPlanId: planId } });
      await tx.productionPlan.update({
        where: { id: planId },
        data: {
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.scheduledFor !== undefined
            ? { scheduledFor: data.scheduledFor ? new Date(data.scheduledFor) : null }
            : {}),
          items: {
            create: items.map((item, index) => ({
              bomId: item.bomId,
              targetQuantity: Number(item.targetQuantity),
              sequence: index + 1,
            })),
          },
        },
      });
    });

    await aggregateIngredientsForPlan(planId);
    return getProductionPlan(planId);
  } catch (error) {
    console.error("updateProductionPlan error:", error);
    throw error;
  }
}

/**
 * Get all production plans with optional filters.
 */
export async function getProductionPlans(filters?: {
  status?: string;
  search?: string;
}) {
  try {
    const where: any = {};

    if (filters?.status) {
      where.status = filters.status;
    }

    if (filters?.search) {
      where.OR = [
        { planNumber: { contains: filters.search, mode: "insensitive" } },
        { description: { contains: filters.search, mode: "insensitive" } },
      ];
    }

    const plans = await prisma.productionPlan.findMany({
      where,
      include: {
        items: {
          include: {
            bom: {
              select: {
                id: true,
                productName: true,
                yieldUnit: true,
                expectedYield: true,
                finishedSku: { select: { id: true, sku: true, name: true } },
                ingredients: {
                  include: {
                    material: { select: { id: true, name: true, sku: true, unitOfMeasure: true } },
                  },
                },
              },
            },
            batchLot: {
              select: { id: true, batchNumber: true, lotCode: true, setNumber: true, status: true },
            },
            batchApprovedBy: { select: { id: true, fullName: true } },
          },
          orderBy: { sequence: "asc" },
        },
        aggregatedIngredients: {
          include: {
            material: { select: { id: true, name: true, sku: true, unitOfMeasure: true } },
          },
        },
        createdBy: { select: { id: true, fullName: true } },
        releasedBy: { select: { id: true, fullName: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return plans;
  } catch (error) {
    console.error("getProductionPlans error:", error);
    throw error;
  }
}

/**
 * Get single production plan with full details.
 */
export async function getProductionPlan(planId: string) {
  try {
    const plan = await prisma.productionPlan.findUnique({
      where: { id: planId },
      include: {
        items: {
          include: {
            bom: {
              include: {
                ingredients: {
                  include: {
                    material: { select: { id: true, name: true, sku: true, unitOfMeasure: true } },
                  },
                },
                finishedSku: { select: { id: true, sku: true, name: true } },
              },
            },
            batchLot: {
              select: { id: true, batchNumber: true, lotCode: true, setNumber: true, status: true },
            },
            batchApprovedBy: { select: { id: true, fullName: true } },
          },
          orderBy: { sequence: "asc" },
        },
        aggregatedIngredients: {
          include: {
            material: { select: { id: true, name: true, sku: true, unitOfMeasure: true, minQuantity: true } },
          },
          orderBy: { material: { name: "asc" } },
        },
        createdBy: { select: { id: true, fullName: true, email: true } },
        releasedBy: { select: { id: true, fullName: true, email: true } },
      },
    });

    if (!plan) {
      throw new Error(`Production plan not found: ${planId}`);
    }

    return plan;
  } catch (error) {
    console.error("getProductionPlan error:", error);
    throw error;
  }
}

/**
 * Add a batch formulation (BOM) to the production plan.
 * Only DRAFT plans can be modified.
 */
export async function addFormulationToPlan(
  planId: string,
  bomId: string,
  targetQuantity: number,
  sequence?: number
) {
  if (!Number.isFinite(Number(targetQuantity)) || Number(targetQuantity) <= 0) {
    throw new Error('Target quantity must be greater than zero');
  }
  try {
    const plan = await prisma.productionPlan.findUnique({
      where: { id: planId },
      select: { id: true, status: true },
    });

    if (!plan) {
      throw new Error(`Production plan not found: ${planId}`);
    }

    if (plan.status !== "DRAFT") {
      throw new Error(
        `Cannot modify production plan with status ${plan.status}. Only DRAFT plans can be modified.`
      );
    }

    // Check BOM exists and is ACTIVE
    const bom = await prisma.bom.findUnique({
      where: { id: bomId },
      select: { id: true, productName: true, status: true },
    });

    if (!bom) {
      throw new Error(`Batch formulation not found: ${bomId}`);
    }

    if (bom.status !== "ACTIVE") {
      throw new Error(
        `Batch formulation must be ACTIVE. Current status: ${bom.status}`
      );
    }

    // Get max sequence if not provided
    let finalSequence = sequence ?? 1;
    if (!sequence) {
      const maxSeq = await prisma.productionPlanItem.aggregate({
        where: { productionPlanId: planId },
        _max: { sequence: true },
      });
      finalSequence = (maxSeq._max.sequence ?? 0) + 1;
    }

    const item = await prisma.productionPlanItem.create({
      data: {
        productionPlanId: planId,
        bomId,
        targetQuantity,
        sequence: finalSequence,
      },
      include: {
        bom: { select: { id: true, productName: true, finishedSku: { select: { sku: true } } } },
      },
    });

    console.log(
      `✓ Added ${bom.productName} to production plan with target quantity ${targetQuantity}`
    );

    // Recalculate aggregated ingredients
    await aggregateIngredientsForPlan(planId);

    return item;
  } catch (error) {
    console.error("addFormulationToPlan error:", error);
    throw error;
  }
}

/**
 * Remove a formulation from the production plan.
 * Only DRAFT plans can be modified.
 */
export async function removeFormulationFromPlan(planId: string, itemId: string) {
  try {
    const item = await prisma.productionPlanItem.findUnique({
      where: { id: itemId },
      include: { productionPlan: { select: { id: true, status: true } } },
    });

    if (!item) {
      throw new Error(`Plan item not found: ${itemId}`);
    }

    if (item.productionPlan.status !== "DRAFT") {
      throw new Error(
        `Cannot modify production plan with status ${item.productionPlan.status}.`
      );
    }

    await prisma.productionPlanItem.delete({ where: { id: itemId } });

    console.log(`✓ Removed formulation from production plan`);

    // Recalculate aggregated ingredients
    await aggregateIngredientsForPlan(planId);

    return { ok: true };
  } catch (error) {
    console.error("removeFormulationFromPlan error:", error);
    throw error;
  }
}

/**
 * Aggregate all ingredients needed for the entire production plan.
 * Sums up all ingredients from all BOMs in the plan, considering target quantities.
 * Stores result in plan_aggregated_ingredients for easy viewing.
 */
export async function aggregateIngredientsForPlan(planId: string, tx?: any) {
  const db = tx ?? prisma;
  try {
    const plan = await db.productionPlan.findUnique({
      where: { id: planId },
      include: {
        items: {
          include: {
            bom: {
              include: {
                finishedSku: {
                  select: { id: true, packSize: true, packUnit: true, unitOfMeasure: true },
                },
                ingredients: {
                  include: {
                    material: {
                      select: {
                        id: true,
                        name: true,
                        packSize: true,
                        packUnit: true,
                        unitOfMeasure: true,
                      },
                    },
                  },
                },
              },
            },
          },
          orderBy: { sequence: "asc" },
        },
      },
    });

    if (!plan) {
      throw new Error(`Production plan not found: ${planId}`);
    }

    // One snapshot row per formula × ingredient: the exact per-batch quantity,
    // the batch multiplier and the resulting total requirement.
    const requirementRows: Array<{
      productionPlanId: string;
      planItemId: string;
      bomId: string;
      materialId: string;
      quantityPerBatch: number;
      perBatchRequired: number;
      batchCount: number;
      totalRequired: number;
      unitOfMeasure: string;
      isPercentage: boolean;
    }> = [];

    for (const item of plan.items) {
      for (const line of computeFormulaRequirements(item)) {
        requirementRows.push({
          productionPlanId: planId,
          planItemId: item.id,
          bomId: item.bomId,
          ...line,
        });
      }
    }

    // Consolidated requirements are the sum of the formula-level rows, so the
    // Ingredient Station can never be given a total that disagrees with them.
    const ingredientMap = new Map<
      string,
      { quantity: number; unitOfMeasure: string; itemCount: number }
    >();
    for (const row of requirementRows) {
      const existing = ingredientMap.get(row.materialId);
      if (existing) {
        existing.quantity += row.totalRequired;
        existing.itemCount += 1;
      } else {
        ingredientMap.set(row.materialId, {
          quantity: row.totalRequired,
          unitOfMeasure: row.unitOfMeasure,
          itemCount: 1,
        });
      }
    }

    const aggregatedData: any[] = [];
    for (const [materialId, data] of ingredientMap.entries()) {
      aggregatedData.push({
        id: `agg-${planId}-${materialId}`,
        productionPlanId: planId,
        materialId,
        totalQuantity: Number(data.quantity.toFixed(4)),
        unitOfMeasure: data.unitOfMeasure,
        status: "PENDING",
      });
    }

    const writeSnapshot = async (client: any) => {
      await client.planIngredientRequirement.deleteMany({ where: { productionPlanId: planId } });
      await client.planAggregatedIngredient.deleteMany({ where: { productionPlanId: planId } });

      if (requirementRows.length > 0) {
        await client.planIngredientRequirement.createMany({
          data: requirementRows,
          skipDuplicates: true,
        });
      }
      if (aggregatedData.length > 0) {
        await client.planAggregatedIngredient.createMany({
          data: aggregatedData,
          skipDuplicates: true,
        });
      }
    };

    // Join the caller's transaction when one is provided (release), otherwise
    // commit the snapshot on its own (create/edit).
    if (tx) {
      await writeSnapshot(tx);
    } else {
      await prisma.$transaction(writeSnapshot);
    }

    console.log(
      `✓ Aggregated ${aggregatedData.length} ingredients from ${requirementRows.length} formula requirement line(s)`
    );
    return aggregatedData;
  } catch (error) {
    console.error("aggregateIngredientsForPlan error:", error);
    throw error;
  }
}

interface FormulaRequirementLine {
  materialId: string;
  quantityPerBatch: number;
  perBatchRequired: number;
  batchCount: number;
  totalRequired: number;
  unitOfMeasure: string;
  isPercentage: boolean;
}

/**
 * Expand one plan item's approved batch formula into per-ingredient requirement
 * lines: `per batch × batches = total required`.
 */
function computeFormulaRequirements(item: any): FormulaRequirementLine[] {
  const productName = item.bom?.productName ?? "Batch formula";
  const expectedYield = Number(item.bom?.expectedYield ?? 0);
  const targetQuantity = Number(item.targetQuantity ?? 0);

  if (!(expectedYield > 0)) {
    throw new Error(
      `"${productName}" has no batch yield. Set the expected yield on the approved batch formula.`
    );
  }
  if (!(targetQuantity > 0)) {
    throw new Error(`"${productName}" needs a positive planned quantity.`);
  }

  const batchCount = targetQuantity / expectedYield;
  const lines: FormulaRequirementLine[] = [];

  for (const ingredient of item.bom?.ingredients ?? []) {
    let perBatchRequired: number;
    let totalRequired: number;

    if (ingredient.isPercentage) {
      const total = percentageIngredientPacks(
        ingredient.quantity,
        targetQuantity,
        item.bom.finishedSku,
        ingredient.material
      );
      if (total === null) {
        throw new Error(
          `Cannot calculate ${ingredient.material?.name ?? "ingredient"}: percentage ingredients need a weight per pack on both the finished product and the ingredient`
        );
      }
      totalRequired = total;
      perBatchRequired = total / batchCount;
    } else {
      perBatchRequired = Number(ingredient.quantity);
      totalRequired = perBatchRequired * batchCount;
    }

    if (!Number.isFinite(perBatchRequired) || !Number.isFinite(totalRequired)) {
      throw new Error(
        `Cannot calculate ${ingredient.material?.name ?? "ingredient"} for "${productName}"`
      );
    }

    lines.push({
      materialId: ingredient.materialId,
      quantityPerBatch: Number(ingredient.quantity),
      perBatchRequired: Number(perBatchRequired.toFixed(4)),
      batchCount: Number(batchCount.toFixed(4)),
      totalRequired: Number(totalRequired.toFixed(4)),
      unitOfMeasure: ingredient.unitOfMeasure || ingredient.material?.unitOfMeasure || "",
      isPercentage: Boolean(ingredient.isPercentage),
    });
  }

  return lines;
}

/**
 * Full requirement calculation for the UI, formula by formula plus the
 * consolidated list that feeds the Ingredient Station work order.
 */
export async function getPlanIngredientRequirements(planId: string) {
  const plan = await prisma.productionPlan.findUnique({
    where: { id: planId },
    include: {
      items: {
        include: {
          bom: {
            include: {
              finishedSku: { select: { id: true, name: true, sku: true, unitOfMeasure: true } },
              ingredients: {
                include: {
                  material: {
                    select: {
                      id: true,
                      name: true,
                      sku: true,
                      packSize: true,
                      packUnit: true,
                      unitOfMeasure: true,
                    },
                  },
                },
              },
            },
          },
          ingredientRequirements: {
            include: {
              material: {
                select: {
                  id: true,
                  name: true,
                  sku: true,
                  packSize: true,
                  packUnit: true,
                  unitOfMeasure: true,
                },
              },
            },
            orderBy: { material: { name: "asc" } },
          },
          batchLot: {
            select: { id: true, batchNumber: true, lotCode: true, setNumber: true, status: true },
          },
        },
        orderBy: { sequence: "asc" },
      },
    },
  });

  if (!plan) throw new Error(`Production plan not found: ${planId}`);

  const round = (value: number) => Number(Number(value ?? 0).toFixed(4));

  const formulas = plan.items.map((item: any) => {
    const expectedYield = Number(item.bom?.expectedYield ?? 0);
    const targetQuantity = Number(item.targetQuantity ?? 0);

    // Prefer the persisted snapshot; fall back to deriving it for plans that
    // predate this feature (read-only, never rewrites the consolidated cache).
    const persisted: any[] = item.ingredientRequirements ?? [];
    const batchCount =
      expectedYield > 0 ? targetQuantity / expectedYield : Number(persisted[0]?.batchCount ?? 0);
    const rows = persisted.length
      ? persisted.map((row: any) => ({
          materialId: row.materialId,
          name: row.material?.name ?? "Ingredient",
          sku: row.material?.sku ?? "—",
          unitOfMeasure: row.unitOfMeasure,
          quantityPerBatch: Number(row.quantityPerBatch),
          perBatchRequired: Number(row.perBatchRequired),
          batchCount: Number(row.batchCount),
          totalRequired: Number(row.totalRequired),
          isPercentage: row.isPercentage,
          packWeightKg: packWeightFrom(row.material),
        }))
      : computeFormulaRequirements(item).map((row) => {
          const ingredient = item.bom?.ingredients?.find(
            (line: any) => line.materialId === row.materialId
          );
          return {
            materialId: row.materialId,
            name: ingredient?.material?.name ?? "Ingredient",
            sku: ingredient?.material?.sku ?? "—",
            unitOfMeasure: row.unitOfMeasure,
            quantityPerBatch: row.quantityPerBatch,
            perBatchRequired: row.perBatchRequired,
            batchCount: row.batchCount,
            totalRequired: row.totalRequired,
            isPercentage: row.isPercentage,
            packWeightKg: packWeightFrom(ingredient?.material),
          };
        });

    const ingredients = rows.map((row) => ({
      ...row,
      perBatchWeightKg:
        row.packWeightKg === null ? null : round(row.perBatchRequired * row.packWeightKg),
      totalWeightKg: row.packWeightKg === null ? null : round(row.totalRequired * row.packWeightKg),
    }));

    return {
      planItemId: item.id,
      sequence: item.sequence,
      bomId: item.bomId,
      productName: item.bom?.finishedSku?.name ?? item.bom?.productName ?? "Product",
      sku: item.bom?.finishedSku?.sku ?? "—",
      expectedYield: round(expectedYield),
      yieldUnit: item.bom?.yieldUnit ?? "",
      targetQuantity: round(targetQuantity),
      batchCount: round(batchCount),
      batchCode: item.batchLot?.lotCode ?? item.batchLot?.batchNumber ?? null,
      batchStatus: item.batchLot?.status ?? null,
      batchApprovedAt: item.batchApprovedAt ?? null,
      ingredients,
      totalWeightKg: round(
        ingredients.reduce((sum, line) => sum + Number(line.totalWeightKg ?? 0), 0)
      ),
    };
  });

  const consolidatedMap = new Map<string, any>();
  for (const formula of formulas) {
    for (const line of formula.ingredients) {
      const existing = consolidatedMap.get(line.materialId);
      const source = {
        planItemId: formula.planItemId,
        bomId: formula.bomId,
        productName: formula.productName,
        totalRequired: line.totalRequired,
        unitOfMeasure: line.unitOfMeasure,
      };
      if (existing) {
        existing.totalRequired = round(existing.totalRequired + line.totalRequired);
        existing.totalWeightKg = round(Number(existing.totalWeightKg ?? 0) + Number(line.totalWeightKg ?? 0));
        existing.sources.push(source);
      } else {
        consolidatedMap.set(line.materialId, {
          materialId: line.materialId,
          name: line.name,
          sku: line.sku,
          unitOfMeasure: line.unitOfMeasure,
          totalRequired: line.totalRequired,
          packWeightKg: line.packWeightKg,
          totalWeightKg: line.totalWeightKg,
          sources: [source],
        });
      }
    }
  }

  const consolidated = [...consolidatedMap.values()].sort((a, b) =>
    String(a.name).localeCompare(String(b.name))
  );

  return {
    plan: {
      id: plan.id,
      planNumber: plan.planNumber,
      status: plan.status,
      description: plan.description,
      scheduledFor: plan.scheduledFor,
    },
    formulas,
    consolidated,
    totals: {
      formulas: formulas.length,
      batches: round(formulas.reduce((sum, formula) => sum + formula.batchCount, 0)),
      ingredients: consolidated.length,
      totalWeightKg: round(consolidated.reduce((sum, line) => sum + Number(line.totalWeightKg ?? 0), 0)),
    },
  };
}

/**
 * Get aggregated ingredients for a production plan.
 */
export async function getPlanAggregatedIngredients(planId: string): Promise<AggregatedIngredient[]> {
  try {
    const aggregated = await prisma.planAggregatedIngredient.findMany({
      where: { productionPlanId: planId },
      include: {
        material: { select: { id: true, name: true, sku: true, unitOfMeasure: true } },
      },
      orderBy: { material: { name: "asc" } },
    });

    return aggregated.map((agg) => ({
      materialId: agg.materialId,
      materialName: agg.material.name,
      sku: agg.material.sku,
      unitOfMeasure: agg.unitOfMeasure,
      totalQuantity: Number(agg.totalQuantity),
      itemCount: 1, // TODO: Calculate from plan items
    }));
  } catch (error) {
    console.error("getPlanAggregatedIngredients error:", error);
    throw error;
  }
}

/**
 * Release error with an HTTP status so the route can answer 404/409/400
 * precisely (especially for a duplicate release).
 */
export class PlanReleaseError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "PlanReleaseError";
    this.statusCode = statusCode;
  }
}

/**
 * Deduct the plan's consolidated requirement from one warehouse, taking the
 * earliest-expiring lot first and splitting across lots when one is not enough.
 *
 * This is the single point where ingredient stock leaves the store: the
 * Ingredients Station only confirms what it physically received, so a batch can
 * never be deducted twice. Every slice is written to the ledger and to
 * `PlanIngredientIssue`, which is the plan's lot-level lineage record.
 */
async function consumePlanRequirements(
  tx: any,
  planId: string,
  warehouseId: string,
  userId: string
) {
  const requirements = await tx.planAggregatedIngredient.findMany({
    where: { productionPlanId: planId },
    include: { material: { select: { name: true, standardCost: true } } },
    orderBy: { material: { name: "asc" } },
  });

  const shortages: string[] = [];

  for (const req of requirements) {
    let remaining = Number(req.totalQuantity ?? 0);
    if (!(remaining > 0)) continue;

    const balances = await tx.inventoryTransaction.groupBy({
      by: ["batchLotId"],
      where: { materialId: req.materialId, warehouseId },
      _sum: { quantity: true },
    });

    const candidates = balances
      .map((row: any) => ({
        batchLotId: row.batchLotId as string | null,
        quantity: Number(row._sum.quantity ?? 0),
      }))
      .filter((row: any) => row.quantity > 0);

    const available = candidates.reduce((sum: number, row: any) => sum + row.quantity, 0);

    const lotIds = candidates.map((row: any) => row.batchLotId).filter(Boolean) as string[];
    const lots = lotIds.length
      ? await tx.batchLot.findMany({
          where: { id: { in: lotIds } },
          select: { id: true, expiryDate: true, lotCode: true, batchNumber: true },
        })
      : [];
    const lotById = new Map<string, any>(lots.map((lot: any) => [lot.id, lot]));

    // FEFO: nearest expiry first; lots without an expiry are taken last.
    candidates.sort((a: any, b: any) => {
      const ea = a.batchLotId ? lotById.get(a.batchLotId)?.expiryDate ?? null : null;
      const eb = b.batchLotId ? lotById.get(b.batchLotId)?.expiryDate ?? null : null;
      if (ea && eb) return ea.getTime() - eb.getTime();
      if (ea) return -1;
      if (eb) return 1;
      return 0;
    });

    if (available + 0.0001 < remaining) {
      shortages.push(
        `${req.material?.name ?? "Ingredient"}: needs ${remaining}, only ${available} in the selected warehouse`
      );
      continue;
    }

    const unitCost = Number(req.material?.standardCost ?? 0);
    let taken = 0;
    let firstLotId: string | null = null;

    for (const lot of candidates) {
      if (remaining <= 0.0001) break;
      const take = Math.min(remaining, lot.quantity);
      if (!(take > 0)) continue;

      await postLedgerEntry(tx, {
        eventType: LedgerEventType.PROD_CONSUMPTION,
        materialId: req.materialId,
        batchLotId: lot.batchLotId,
        warehouseId,
        quantity: -take,
        unitOfMeasure: req.unitOfMeasure,
        referenceType: "PLAN_RELEASE",
        referenceId: planId,
        createdById: userId,
        notes: `Released to production (${req.material?.name ?? "ingredient"})`,
      });

      await tx.planIngredientIssue.create({
        data: {
          productionPlanId: planId,
          aggregatedIngredientId: req.id,
          materialId: req.materialId,
          batchLotId: lot.batchLotId,
          quantity: take,
          unitOfMeasure: req.unitOfMeasure,
          unitCost,
          warehouseId,
          issuedById: userId,
        },
      });

      if (!firstLotId) firstLotId = lot.batchLotId;
      remaining -= take;
      taken += take;
    }

    await tx.planAggregatedIngredient.update({
      where: { id: req.id },
      data: {
        issuedQuantity: taken,
        issuedWarehouseId: warehouseId,
        issuedBatchLotId: firstLotId,
        issuedAt: new Date(),
        issuedById: userId,
        status: "RELEASED",
      },
    });
  }

  if (shortages.length > 0) {
    throw new PlanReleaseError(
      `Not enough stock to release: ${shortages.join("; ")}`,
      400
    );
  }
}

/**
 * Centralized ingredient release.
 *
 * One transaction performs the whole release: validate the approved formulas,
 * atomically claim DRAFT → SCHEDULED, generate the requirement snapshot, create
 * the three station work orders and send the station notifications. Any failure
 * rolls everything back, and a repeated call is rejected because the claim only
 * matches a DRAFT plan.
 */
export async function releasePlanIngredients(input: {
  planId: string;
  releasedById: string;
  scheduledFor?: Date | null;
  /** Warehouse the ingredients are released from. Stock leaves the store here. */
  warehouseId?: string | null;
}) {
  if (!input.warehouseId) {
    throw new PlanReleaseError("Select the warehouse the ingredients are released from", 400);
  }
  const releaseWarehouseId: string = input.warehouseId;
  const releasedAt = new Date();

  const outcome = await prisma.$transaction(async (tx) => {
    const plan = await tx.productionPlan.findUnique({
      where: { id: input.planId },
      select: {
        id: true,
        planNumber: true,
        status: true,
        scheduledFor: true,
        items: { select: { id: true, bomId: true } },
      },
    });

    if (!plan) throw new PlanReleaseError("Production plan not found", 404);

    if (plan.status !== "DRAFT") {
      throw new PlanReleaseError(
        plan.status === "SCHEDULED"
          ? "Ingredients for this production order have already been released"
          : `Only draft production orders can release ingredients (current: ${plan.status})`,
        409
      );
    }

    if (plan.items.length === 0) {
      throw new PlanReleaseError(
        "Add at least one batch formula before releasing ingredients",
        400
      );
    }

    // Every formula must still be approved, carry a batch yield and have
    // ingredients before any requirement snapshot is written.
    const boms = await tx.bom.findMany({
      where: { id: { in: plan.items.map((item) => item.bomId) } },
      select: {
        id: true,
        productName: true,
        status: true,
        expectedYield: true,
        _count: { select: { ingredients: true } },
      },
    });
    const notReady = boms.find(
      (bom) =>
        (bom.status !== "ACTIVE" && bom.status !== "APPROVED") ||
        !(Number(bom.expectedYield) > 0) ||
        bom._count.ingredients === 0
    );
    if (notReady) {
      const reason =
        notReady.status !== "ACTIVE" && notReady.status !== "APPROVED"
          ? `is ${notReady.status}`
          : !(Number(notReady.expectedYield) > 0)
            ? "has no batch yield"
            : "has no ingredients";
      throw new PlanReleaseError(
        `Cannot release ingredients: "${notReady.productName}" ${reason}. Approved batch formulas with a yield are required.`,
        400
      );
    }

    const scheduledFor = input.scheduledFor
      ? new Date(input.scheduledFor)
      : plan.scheduledFor ?? new Date();

    // Atomic claim: concurrent or repeated releases can only match DRAFT once.
    const claim = await tx.productionPlan.updateMany({
      where: { id: plan.id, status: "DRAFT" },
      data: {
        status: "SCHEDULED",
        scheduledFor,
        releasedById: input.releasedById,
        releasedAt,
      },
    });
    if (claim.count === 0) {
      throw new PlanReleaseError(
        "Ingredients for this production order have already been released",
        409
      );
    }

    // Generate the formula-level snapshot and consolidated cache inside the
    // same transaction, then create work orders + notifications.
    await aggregateIngredientsForPlan(plan.id, tx);

    const requirementCount = await tx.planIngredientRequirement.count({
      where: { productionPlanId: plan.id },
    });
    if (requirementCount === 0) {
      throw new PlanReleaseError(
        "Cannot release ingredients: no requirements could be calculated from the approved batch formulas",
        400
      );
    }

    // Give every plan item its one authoritative production batch lot. It is
    // active immediately: the chain has a single QA gate, on the way in.
    try {
      await provisionPlanBatches(tx, plan.id, scheduledFor);
    } catch (error: any) {
      throw new PlanReleaseError(
        error?.message ?? "Failed to provision the production batch codes",
        400
      );
    }

    // Release is where stock moves: the requirement is deducted here and the
    // Ingredients Station only confirms what it received.
    await consumePlanRequirements(tx, plan.id, releaseWarehouseId, input.releasedById);

    await notifyStationWorkOrders({
      planId: plan.id,
      tx,
      action:
        "The ingredients for this production order have been released. Receive the requirements and start your station.",
    });

    return {
      planId: plan.id,
      planNumber: plan.planNumber,
      scheduledFor,
      releasedAt,
    };
  }, { timeout: 15000, maxWait: 5000 });

  await logActivity({
    userId: input.releasedById,
    activityType: "APPROVE",
    module: "production",
    description: `Released ingredients for plan ${outcome.planNumber}`,
    entityType: "ProductionPlan",
    entityId: outcome.planId,
  }).catch((error) => console.error("releasePlanIngredients audit log failed:", error));

  // The release is already committed. A summary read failure must not turn a
  // successful release into an error the user would retry (and get a 409).
  let summary = {
    productionOrder: outcome.planNumber,
    productionDate: outcome.scheduledFor,
    products: [] as string[],
    totalBatches: 0,
    ingredientCount: 0,
    totalWeightKg: 0,
  };
  try {
    const requirements = await getPlanIngredientRequirements(outcome.planId);
    summary = {
      productionOrder: outcome.planNumber,
      productionDate: outcome.scheduledFor,
      products: requirements.formulas.map((formula) => formula.productName),
      totalBatches: requirements.totals.batches,
      ingredientCount: requirements.totals.ingredients,
      totalWeightKg: requirements.totals.totalWeightKg,
    };
  } catch (error) {
    console.error("releasePlanIngredients summary failed:", error);
  }

  return { ...outcome, summary };
}

/**
 * Legacy schedule endpoint — now routed through the centralized release so there
 * is only one release path in the system.
 */
export async function scheduleProductionPlan(
  planId: string,
  scheduledFor: Date,
  releasedById: string,
  warehouseId?: string | null
) {
  await releasePlanIngredients({ planId, releasedById, scheduledFor, warehouseId });
  return getProductionPlan(planId);
}

/**
 * Start production (SCHEDULED → IN_PROGRESS).
 */
export async function startProductionPlan(planId: string) {
  try {
    const plan = await prisma.productionPlan.findUnique({
      where: { id: planId },
      select: { id: true, status: true },
    });

    if (!plan) {
      throw new Error(`Production plan not found: ${planId}`);
    }

    if (plan.status !== "SCHEDULED") {
      throw new Error(
        `Can only start SCHEDULED production plans. Current status: ${plan.status}`
      );
    }

    const updated = await prisma.productionPlan.update({
      where: { id: planId },
      data: {
        status: "IN_PROGRESS",
        startedAt: new Date(),
      },
    });

    console.log(`✓ Started production plan`);
    return updated;
  } catch (error) {
    console.error("startProductionPlan error:", error);
    throw error;
  }
}

/**
 * Complete production (IN_PROGRESS → COMPLETED).
 */
export async function completeProductionPlan(planId: string) {
  try {
    const plan = await prisma.productionPlan.findUnique({
      where: { id: planId },
      select: { id: true, status: true },
    });

    if (!plan) {
      throw new Error(`Production plan not found: ${planId}`);
    }

    if (plan.status !== "IN_PROGRESS") {
      throw new Error(
        `Can only complete IN_PROGRESS production plans. Current status: ${plan.status}`
      );
    }

    const updated = await prisma.productionPlan.update({
      where: { id: planId },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });

    console.log(`✓ Completed production plan`);
    return updated;
  } catch (error) {
    console.error("completeProductionPlan error:", error);
    throw error;
  }
}

/**
 * Cancel production plan.
 */
export async function cancelProductionPlan(planId: string) {
  try {
    const plan = await prisma.productionPlan.findUnique({
      where: { id: planId },
      select: { id: true, status: true },
    });

    if (!plan) {
      throw new Error(`Production plan not found: ${planId}`);
    }

    if (plan.status === "COMPLETED") {
      throw new Error("Cannot cancel completed production plan");
    }

    const updated = await prisma.productionPlan.update({
      where: { id: planId },
      data: { status: "CANCELLED" },
    });

    console.log(`✓ Cancelled production plan`);
    return updated;
  } catch (error) {
    console.error("cancelProductionPlan error:", error);
    throw error;
  }
}
