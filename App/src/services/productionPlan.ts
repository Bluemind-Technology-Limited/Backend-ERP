import { prisma } from "../lib/db.js";

export interface CreateProductionPlanInput {
  description?: string;
  scheduledFor?: Date;
  createdById: string;
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
 */
export async function createProductionPlan(input: CreateProductionPlanInput) {
  try {
    const planNumber = `PLAN-${Date.now().toString().slice(-8)}`;

    const plan = await prisma.productionPlan.create({
      data: {
        planNumber,
        description: input.description,
        status: "DRAFT",
        scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
        createdById: input.createdById,
      },
      include: {
        items: {
          include: {
            bom: {
              select: { id: true, productName: true, finishedSku: { select: { sku: true } } },
            },
          },
        },
        createdBy: { select: { id: true, fullName: true, email: true } },
      },
    });

    console.log(`✓ Created production plan: ${plan.planNumber}`);
    return plan;
  } catch (error) {
    console.error("createProductionPlan error:", error);
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
                finishedSku: { select: { id: true, sku: true, name: true } },
              },
            },
          },
          orderBy: { sequence: "asc" },
        },
        aggregatedIngredients: {
          include: {
            material: { select: { id: true, name: true, sku: true, unitOfMeasure: true } },
          },
        },
        createdBy: { select: { id: true, fullName: true } },
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
export async function aggregateIngredientsForPlan(planId: string) {
  try {
    const plan = await prisma.productionPlan.findUnique({
      where: { id: planId },
      include: {
        items: {
          include: {
            bom: {
              include: {
                ingredients: {
                  include: { material: { select: { id: true, unitOfMeasure: true } } },
                },
              },
            },
          },
        },
      },
    });

    if (!plan) {
      throw new Error(`Production plan not found: ${planId}`);
    }

    // Delete existing aggregated ingredients
    await prisma.planAggregatedIngredient.deleteMany({
      where: { productionPlanId: planId },
    });

    // Calculate aggregated ingredients
    const ingredientMap = new Map<
      string,
      { quantity: number; unitOfMeasure: string; itemCount: number }
    >();

    for (const item of plan.items) {
      const scale = Number(item.targetQuantity) / Number(item.bom.expectedYield ?? 1);

      for (const ingredient of item.bom.ingredients) {
        const key = ingredient.materialId;
        const projectedQty = ingredient.isPercentage
          ? (Number(ingredient.quantity) / 100) * scale * Number(item.bom.expectedYield ?? 1)
          : Number(ingredient.quantity) * scale;

        if (ingredientMap.has(key)) {
          const existing = ingredientMap.get(key)!;
          existing.quantity += projectedQty;
          existing.itemCount += 1;
        } else {
          ingredientMap.set(key, {
            quantity: projectedQty,
            unitOfMeasure: ingredient.unitOfMeasure,
            itemCount: 1,
          });
        }
      }
    }

    // Create aggregated ingredient records
    const aggregatedData: any[] = [];
    for (const [materialId, data] of ingredientMap.entries()) {
      aggregatedData.push({
        id: `agg-${planId}-${materialId}`,
        productionPlanId: planId,
        materialId,
        totalQuantity: data.quantity,
        unitOfMeasure: data.unitOfMeasure,
        status: "PENDING",
      });
    }

    if (aggregatedData.length > 0) {
      await prisma.planAggregatedIngredient.createMany({
        data: aggregatedData,
        skipDuplicates: true,
      });
    }

    console.log(`✓ Aggregated ${aggregatedData.length} ingredients for production plan`);
    return aggregatedData;
  } catch (error) {
    console.error("aggregateIngredientsForPlan error:", error);
    throw error;
  }
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
 * Schedule production plan (DRAFT → SCHEDULED).
 */
export async function scheduleProductionPlan(planId: string, scheduledFor: Date) {
  try {
    const plan = await prisma.productionPlan.findUnique({
      where: { id: planId },
      select: { id: true, status: true, items: { select: { id: true } } },
    });

    if (!plan) {
      throw new Error(`Production plan not found: ${planId}`);
    }

    if (plan.status !== "DRAFT") {
      throw new Error(
        `Cannot schedule production plan with status ${plan.status}. Only DRAFT plans can be scheduled.`
      );
    }

    if (plan.items.length === 0) {
      throw new Error("Cannot schedule empty production plan. Add at least one formulation.");
    }

    const updated = await prisma.productionPlan.update({
      where: { id: planId },
      data: {
        status: "SCHEDULED",
        scheduledFor: new Date(scheduledFor),
      },
      include: {
        items: { include: { bom: { select: { productName: true } } } },
      },
    });

    console.log(`✓ Scheduled production plan with ${updated.items.length} formulations`);
    return updated;
  } catch (error) {
    console.error("scheduleProductionPlan error:", error);
    throw error;
  }
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
