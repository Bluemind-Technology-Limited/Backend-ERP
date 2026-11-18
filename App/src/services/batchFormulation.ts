import { prisma } from "../lib/db.js";
import { parsePackLabel } from "../lib/uom.js";

export interface CreateBatchFormulationInput {
  productName: string;
  description?: string;
  expectedYield: number;
  yieldUnit: string;
  finishedSkuId: string;
  ingredients: Array<{
    materialId: string;
    quantity: number;
    /** Deprecated — the material's pack label is authoritative. */
    unitOfMeasure?: string;
    isPercentage?: boolean;
  }>;
  createdById: string;
}

export interface UpdateBatchFormulationInput {
  productName?: string;
  description?: string;
  expectedYield?: number;
  yieldUnit?: string;
  status?: string;
  updatedById: string;
}

/**
 * Create a new batch formulation (BOM).
 * All BOMs start in DRAFT status.
 */
export async function createBatchFormulation(input: CreateBatchFormulationInput) {
  try {
    // Verify finished SKU exists
    const finishedSku = await prisma.material.findUnique({
      where: { id: input.finishedSkuId },
      select: { id: true, name: true, sku: true, unitOfMeasure: true },
    });

    if (!finishedSku) {
      throw new Error(`Finished SKU not found: ${input.finishedSkuId}`);
    }

    if (!Number.isFinite(Number(input.expectedYield)) || Number(input.expectedYield) <= 0) {
      throw new Error("Expected yield must be greater than zero");
    }

    // Verify all ingredient materials exist
    const ingredientIds = input.ingredients.map((ing) => ing.materialId);
    for (const ing of input.ingredients) {
      const qty = Number(ing.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new Error("Every ingredient needs a quantity greater than zero");
      }
      if (ing.isPercentage && qty > 100) {
        throw new Error("Percentage ingredients cannot exceed 100%");
      }
    }
    const ingredientMaterials = await prisma.material.findMany({
      where: { id: { in: ingredientIds } },
      select: { id: true, name: true, unitOfMeasure: true },
    });

    if (ingredientMaterials.length !== ingredientIds.length) {
      throw new Error("One or more ingredient materials not found");
    }
    // A formula line is a count of the material's packs, so the material must
    // have a pack unit of measure ("25 KG"). Free-text units like "kg" are not
    // acceptable: they cannot be deducted against pack stock.
    const missingPack = ingredientMaterials.find((m) => !parsePackLabel(m.unitOfMeasure));
    if (missingPack) {
      throw new Error(
        `"${missingPack.name}" has no pack unit of measure. Set its pack size and unit in Master Data → Materials before adding it to a formulation.`
      );
    }
    const ingredientUom = new Map(ingredientMaterials.map((m) => [m.id, m.unitOfMeasure]));

    // Create BOM with ingredients
    const bom = await prisma.bom.create({
      data: {
        productName: input.productName,
        description: input.description,
        expectedYield: input.expectedYield,
        yieldUnit: finishedSku.unitOfMeasure,
        finishedSkuId: input.finishedSkuId,
        status: "DRAFT",
        ingredients: {
          create: input.ingredients.map((ing) => ({
            materialId: ing.materialId,
            quantity: ing.quantity,
            unitOfMeasure: ingredientUom.get(ing.materialId)!,
            isPercentage: ing.isPercentage ?? false,
          })),
        },
      },
      include: {
        ingredients: {
          include: {
            material: {
              select: {
                id: true,
                name: true,
                sku: true,
                unitOfMeasure: true,
              },
            },
          },
        },
        approvedBy: { select: { id: true, fullName: true, email: true } },
      },
    });

    console.log(
      `✓ Created batch formulation: ${bom.productName} (${finishedSku.sku})`
    );
    return bom;
  } catch (error) {
    console.error("createBatchFormulation error:", error);
    throw error;
  }
}

/**
 * Get all batch formulations with optional filters.
 */
export async function getBatchFormulations(filters?: {
  status?: string;
  finishedSkuId?: string;
  search?: string;
}) {
  try {
    const where: any = {};

    if (filters?.status) {
      where.status = filters.status;
    }

    if (filters?.finishedSkuId) {
      where.finishedSkuId = filters.finishedSkuId;
    }

    if (filters?.search) {
      where.OR = [
        { productName: { contains: filters.search, mode: "insensitive" } },
        { description: { contains: filters.search, mode: "insensitive" } },
      ];
    }

    const boms = await prisma.bom.findMany({
      where,
      include: {
        ingredients: {
          include: {
            material: {
              select: {
                id: true,
                name: true,
                sku: true,
                unitOfMeasure: true,
                minQuantity: true,
              },
            },
          },
        },
        finishedSku: { select: { id: true, name: true, sku: true } },
        approvedBy: { select: { id: true, fullName: true, email: true } },
        updatedBy: { select: { id: true, fullName: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return boms;
  } catch (error) {
    console.error("getBatchFormulations error:", error);
    throw error;
  }
}

/**
 * Get single batch formulation with full details.
 */
export async function getBatchFormulation(bomId: string) {
  try {
    const bom = await prisma.bom.findUnique({
      where: { id: bomId },
      include: {
        ingredients: {
          include: {
            material: {
              select: {
                id: true,
                name: true,
                sku: true,
                unitOfMeasure: true,
                minQuantity: true,
                status: true,
              },
            },
          },
        },
        finishedSku: {
          select: {
            id: true,
            name: true,
            sku: true,
            unitOfMeasure: true,
            type: true,
          },
        },
        approvedBy: { select: { id: true, fullName: true, email: true } },
        updatedBy: { select: { id: true, fullName: true } },
        productionOrders: {
          select: {
            id: true,
            orderNumber: true,
            status: true,
            targetQuantity: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: 10,
        },
      },
    });

    if (!bom) {
      throw new Error(`Batch formulation not found: ${bomId}`);
    }

    return bom;
  } catch (error) {
    console.error("getBatchFormulation error:", error);
    throw error;
  }
}

/**
 * Update batch formulation.
 * Only DRAFT formulations can be updated.
 */
export async function updateBatchFormulation(
  bomId: string,
  input: UpdateBatchFormulationInput
) {
  try {
    // Verify BOM exists and is DRAFT
    const existing = await prisma.bom.findUnique({
      where: { id: bomId },
      select: { id: true, status: true },
    });

    if (!existing) {
      throw new Error(`Batch formulation not found: ${bomId}`);
    }

    if (existing.status !== "DRAFT") {
      throw new Error(
        `Cannot update batch formulation with status ${existing.status}. Only DRAFT formulations can be updated.`
      );
    }

    if (
      input.expectedYield !== undefined &&
      (!Number.isFinite(Number(input.expectedYield)) || Number(input.expectedYield) <= 0)
    ) {
      throw new Error("Expected yield must be greater than zero");
    }

    const bom = await prisma.bom.update({
      where: { id: bomId },
      data: {
        productName: input.productName,
        description: input.description,
        expectedYield: input.expectedYield,
        updatedById: input.updatedById,
      },
      include: {
        ingredients: {
          include: {
            material: {
              select: { id: true, name: true, sku: true, unitOfMeasure: true },
            },
          },
        },
        finishedSku: { select: { id: true, name: true, sku: true } },
      },
    });

    console.log(`✓ Updated batch formulation: ${bom.productName}`);
    return bom;
  } catch (error) {
    console.error("updateBatchFormulation error:", error);
    throw error;
  }
}

/**
 * Add ingredient to batch formulation.
 * Only DRAFT formulations can have ingredients added.
 */
export async function addIngredient(
  bomId: string,
  materialId: string,
  quantity: number,
  isPercentage: boolean = false
) {
  try {
    const bom = await prisma.bom.findUnique({
      where: { id: bomId },
      select: { id: true, status: true, productName: true },
    });

    if (!bom) {
      throw new Error(`Batch formulation not found: ${bomId}`);
    }

    if (bom.status !== "DRAFT") {
      throw new Error(
        `Cannot add ingredients to ${bom.status} formulation. Only DRAFT formulations can be modified.`
      );
    }

    const material = await prisma.material.findUnique({
      where: { id: materialId },
      select: { name: true, unitOfMeasure: true },
    });
    if (!material) throw new Error(`Material not found: ${materialId}`);
    if (!parsePackLabel(material.unitOfMeasure)) {
      throw new Error(
        `"${material.name}" has no pack unit of measure. Set its pack size and unit in Master Data → Materials first.`
      );
    }

    if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
      throw new Error("Ingredient quantity must be greater than zero");
    }
    if (isPercentage && Number(quantity) > 100) {
      throw new Error("Percentage ingredients cannot exceed 100%");
    }

    const ingredient = await prisma.bomIngredient.create({
      data: {
        bomId,
        materialId,
        quantity,
        unitOfMeasure: material.unitOfMeasure,
        isPercentage,
      },
      include: {
        material: { select: { id: true, name: true, sku: true } },
      },
    });

    console.log(
      `✓ Added ingredient to ${bom.productName}: ${ingredient.material.name}`
    );
    return ingredient;
  } catch (error) {
    console.error("addIngredient error:", error);
    throw error;
  }
}

/**
 * Remove ingredient from batch formulation.
 * Only DRAFT formulations can have ingredients removed.
 */
export async function removeIngredient(ingredientId: string) {
  try {
    const ingredient = await prisma.bomIngredient.findUnique({
      where: { id: ingredientId },
      include: {
        bom: { select: { id: true, status: true, productName: true } },
        material: { select: { id: true, name: true } },
      },
    });

    if (!ingredient) {
      throw new Error(`Ingredient not found: ${ingredientId}`);
    }

    if (ingredient.bom.status !== "DRAFT") {
      throw new Error(
        `Cannot remove ingredients from ${ingredient.bom.status} formulation.`
      );
    }

    await prisma.bomIngredient.delete({ where: { id: ingredientId } });

    console.log(
      `✓ Removed ingredient from ${ingredient.bom.productName}: ${ingredient.material.name}`
    );
    return { ok: true };
  } catch (error) {
    console.error("removeIngredient error:", error);
    throw error;
  }
}

/**
 * Approve batch formulation.
 * Marks formulation as ACTIVE and records approver + approval timestamp.
 */
export async function approveBatchFormulation(
  bomId: string,
  approvedById: string
) {
  try {
    const existing = await prisma.bom.findUnique({
      where: { id: bomId },
      select: { id: true, status: true, productName: true },
    });

    if (!existing) {
      throw new Error(`Batch formulation not found: ${bomId}`);
    }

    if (existing.status !== "DRAFT") {
      throw new Error(
        `Cannot approve formulation with status ${existing.status}. Only DRAFT formulations can be approved.`
      );
    }

    const bom = await prisma.bom.update({
      where: { id: bomId },
      data: {
        status: "ACTIVE",
        approvedAt: new Date(),
        approvedById,
      },
      include: {
        ingredients: {
          include: {
            material: { select: { id: true, name: true, sku: true } },
          },
        },
        finishedSku: { select: { id: true, name: true, sku: true } },
        approvedBy: { select: { id: true, fullName: true, email: true } },
      },
    });

    console.log(`✓ Approved batch formulation: ${bom.productName}`);
    return bom;
  } catch (error) {
    console.error("approveBatchFormulation error:", error);
    throw error;
  }
}

/**
 * Archive batch formulation.
 * Marks formulation as ARCHIVED. Cannot be used for new production orders.
 */
export async function archiveBatchFormulation(bomId: string) {
  try {
    const existing = await prisma.bom.findUnique({
      where: { id: bomId },
      select: { id: true, status: true, productName: true },
    });

    if (!existing) {
      throw new Error(`Batch formulation not found: ${bomId}`);
    }

    if (existing.status === "ARCHIVED") {
      throw new Error("Batch formulation is already archived");
    }

    const bom = await prisma.bom.update({
      where: { id: bomId },
      data: { status: "ARCHIVED" },
    });

    console.log(`✓ Archived batch formulation: ${bom.productName}`);
    return bom;
  } catch (error) {
    console.error("archiveBatchFormulation error:", error);
    throw error;
  }
}

/**
 * Duplicate a batch formulation.
 * Creates a new DRAFT copy of an existing formulation (useful for variations).
 */
export async function duplicateBatchFormulation(
  bomId: string,
  newProductName: string,
  createdById: string
) {
  try {
    const original = await prisma.bom.findUnique({
      where: { id: bomId },
      include: {
        ingredients: { include: { material: { select: { unitOfMeasure: true } } } },
        finishedSku: { select: { unitOfMeasure: true } },
      },
    });

    if (!original) {
      throw new Error(`Batch formulation not found: ${bomId}`);
    }

    const duplicate = await prisma.bom.create({
      data: {
        productName: newProductName,
        description: `Copy of: ${original.productName}`,
        expectedYield: original.expectedYield,
        yieldUnit: original.finishedSku?.unitOfMeasure ?? original.yieldUnit,
        finishedSkuId: original.finishedSkuId,
        status: "DRAFT",
        ingredients: {
          create: original.ingredients.map((ing) => ({
            materialId: ing.materialId,
            quantity: ing.quantity,
            // Always the material's pack label, never the copied text.
            unitOfMeasure: ing.material?.unitOfMeasure ?? ing.unitOfMeasure,
            isPercentage: ing.isPercentage,
          })),
        },
      },
      include: {
        ingredients: {
          include: {
            material: { select: { id: true, name: true, sku: true } },
          },
        },
      },
    });

    console.log(`✓ Duplicated batch formulation: ${newProductName}`);
    return duplicate;
  } catch (error) {
    console.error("duplicateBatchFormulation error:", error);
    throw error;
  }
}
