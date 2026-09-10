import { prisma } from '../lib/db.js';
import { ProductionIngredientStatus } from '@prisma/client';
import { postLedgerEntry } from '../lib/ledger.js';
import { LedgerEventType } from '@prisma/client';

/**
 * Ingredient Lifecycle Service
 * Manages non-depleting production flow:
 * RESERVED (initial) → RELEASED (picked for production) → CONSUMED (used in production) or RETURNED (unused)
 * 
 * Key principle: ingredients are reserved when order created, only converted to ledger entries
 * (consumption/waste) when order completes. This allows ingredient availability tracking before production starts.
 */

// ============================================================================
// Reserve Ingredients (on Production Order Creation)
// ============================================================================

/**
 * Reserve ingredients for a production order.
 * Called when production order is created (SCHEDULED status).
 * Ingredients start in RESERVED status.
 */
export async function reserveIngredients(productionOrderId: string) {
  const order = await prisma.productionOrder.findUniqueOrThrow({
    where: { id: productionOrderId },
    include: { productionIngredients: true },
  });

  if (order.status !== 'SCHEDULED') {
    throw new Error(`Can only reserve ingredients for SCHEDULED orders, current status: ${order.status}`);
  }

  // Verify all ingredients are in RESERVED status already (should be default from creation)
  const ingredients = await prisma.productionIngredient.findMany({
    where: { productionOrderId },
  });

  const allReserved = ingredients.every((ing) => ing.status === ProductionIngredientStatus.RESERVED);
  if (!allReserved) {
    throw new Error('Some ingredients are not in RESERVED status');
  }

  return {
    productionOrderId,
    ingredientCount: ingredients.length,
    status: 'RESERVED',
  };
}

// ============================================================================
// Release Ingredients (picking from warehouse for production)
// ============================================================================

/**
 * Release (pick) ingredients for production.
 * Transitions from RESERVED → RELEASED when production starts.
 * This marks ingredients as physically removed from warehouse for production use.
 */
export async function releaseIngredients(data: {
  productionOrderId: string;
  releasedById: string;
}) {
  const order = await prisma.productionOrder.findUniqueOrThrow({
    where: { id: data.productionOrderId },
    include: { productionIngredients: true },
  });

  if (order.status !== 'RELEASED') {
    throw new Error(`Can only release ingredients for RELEASED orders, current status: ${order.status}`);
  }

  // Update all ingredients from RESERVED → RELEASED
  const updateResult = await prisma.productionIngredient.updateMany({
    where: {
      productionOrderId: data.productionOrderId,
      status: ProductionIngredientStatus.RESERVED,
    },
    data: {
      status: ProductionIngredientStatus.RELEASED,
      releasedQuantity: 0, // Will be updated as ingredients are consumed
      releasedAt: new Date(),
      releasedById: data.releasedById,
    },
  });

  if (updateResult.count === 0) {
    throw new Error('No ingredients in RESERVED status to release');
  }

  return {
    productionOrderId: data.productionOrderId,
    ingredientsReleased: updateResult.count,
    releasedAt: new Date(),
    releasedById: data.releasedById,
  };
}

// ============================================================================
// Track Released Quantity (as ingredients are consumed during production)
// ============================================================================

/**
 * Update released quantity as ingredients are consumed during production.
 * Ingredient transitions to PARTIALLY_CONSUMED as production uses some of the projected quantity.
 */
export async function updateReleasedQuantity(data: {
  ingredientId: string;
  releasedQuantity: number;
  updatedById: string;
}) {
  const ingredient = await prisma.productionIngredient.findUniqueOrThrow({
    where: { id: data.ingredientId },
    include: { productionOrder: true },
  });

  if (ingredient.status !== ProductionIngredientStatus.RELEASED && ingredient.status !== ProductionIngredientStatus.PARTIALLY_CONSUMED) {
    throw new Error(`Can only update released quantity for RELEASED or PARTIALLY_CONSUMED ingredients, current status: ${ingredient.status}`);
  }

  if (data.releasedQuantity > Number(ingredient.projectedQuantity)) {
    throw new Error(`Released quantity ${data.releasedQuantity} exceeds projected ${ingredient.projectedQuantity}`);
  }

  const newStatus = data.releasedQuantity === Number(ingredient.projectedQuantity)
    ? ProductionIngredientStatus.CONSUMED
    : ProductionIngredientStatus.PARTIALLY_CONSUMED;

  const updated = await prisma.productionIngredient.update({
    where: { id: data.ingredientId },
    data: {
      releasedQuantity: data.releasedQuantity,
      status: newStatus,
    },
    include: {
      material: true,
      productionOrder: true,
    },
  });

  return updated;
}

// ============================================================================
// Return Unused Ingredients (on production order completion)
// ============================================================================

/**
 * Return ingredients not consumed during production.
 * Transition: RELEASED/PARTIALLY_CONSUMED → RETURNED for unused portion.
 * Called at production order completion to track waste and returns.
 */
export async function returnIngredients(data: {
  productionOrderId: string;
  returnedById: string;
}) {
  const order = await prisma.productionOrder.findUniqueOrThrow({
    where: { id: data.productionOrderId },
    include: { productionIngredients: true },
  });

  const releasedIngredients = order.productionIngredients.filter(
    (ing) => ing.status === ProductionIngredientStatus.RELEASED || ing.status === ProductionIngredientStatus.PARTIALLY_CONSUMED
  );

  if (releasedIngredients.length === 0) {
    return {
      productionOrderId: data.productionOrderId,
      ingredientsReturned: 0,
      returnedAt: new Date(),
    };
  }

  // For each ingredient, calculate returned quantity = projected - released
  const results = await Promise.all(
    releasedIngredients.map(async (ing) => {
      const returnedQty = Math.max(0, Number(ing.projectedQuantity) - Number(ing.releasedQuantity));

      if (returnedQty > 0) {
        return prisma.productionIngredient.update({
          where: { id: ing.id },
          data: {
            returnedQuantity: returnedQty,
            status: ProductionIngredientStatus.RETURNED,
          },
        });
      }
      return ing;
    })
  );

  return {
    productionOrderId: data.productionOrderId,
    ingredientsReturned: results.length,
    returnedAt: new Date(),
    returnedById: data.returnedById,
  };
}

// ============================================================================
// Production Completion & Waste Calculation
// ============================================================================

/**
 * Complete production order and process waste/consumption in ledger.
 * Converts ingredient reservations to actual ledger entries:
 *   - CONSUMED → PROD_CONSUMPTION (negative ledger entries)
 *   - RETURNED → WASTE (if returnedQty > 0, posts WASTE ledger entries)
 * 
 * This is where inventory is finally debited. Before this, ingredients are just reserved.
 */
export async function completeProductionAndProcessWaste(data: {
  productionOrderId: string;
  warehouseId: string;
  completedById: string;
}) {
  const order = await prisma.productionOrder.findUniqueOrThrow({
    where: { id: data.productionOrderId },
    include: {
      productionIngredients: { include: { material: true, batchLot: true } },
      bom: true,
    },
  });

  if (order.status !== 'PROCESSING') {
    throw new Error(`Can only complete PROCESSING orders, current status: ${order.status}`);
  }

  // Process each ingredient for ledger
  await prisma.$transaction(async (tx) => {
    for (const ing of order.productionIngredients) {
      // 1. Post PROD_CONSUMPTION for all released quantity
      if (Number(ing.releasedQuantity) > 0) {
        await postLedgerEntry(tx, {
          eventType: LedgerEventType.PROD_CONSUMPTION,
          materialId: ing.materialId,
          batchLotId: ing.batchLotId,
          warehouseId: data.warehouseId,
          quantity: Number(ing.releasedQuantity),
          unitOfMeasure: ing.material?.unitOfMeasure || 'units',
          referenceType: 'PRODUCTION_ORDER',
          referenceId: order.id,
          createdById: data.completedById,
          notes: `Production consumption for order ${order.orderNumber}`,
        });
      }

      // 2. Post WASTE for returned quantity
      if (Number(ing.returnedQuantity) > 0) {
        await postLedgerEntry(tx, {
          eventType: LedgerEventType.WASTE,
          materialId: ing.materialId,
          batchLotId: ing.batchLotId,
          warehouseId: data.warehouseId,
          quantity: Number(ing.returnedQuantity),
          unitOfMeasure: ing.material?.unitOfMeasure || 'units',
          referenceType: 'PRODUCTION_ORDER',
          referenceId: order.id,
          createdById: data.completedById,
          notes: `Production waste/return for order ${order.orderNumber}`,
        });
      }

      // 3. Post PROD_OUTPUT for finished batch
      if (order.finishedBatchId && order.actualYield && order.bom?.finishedSkuId) {
        await postLedgerEntry(tx, {
          eventType: LedgerEventType.PROD_OUTPUT,
          materialId: order.bom.finishedSkuId,
          batchLotId: order.finishedBatchId,
          warehouseId: data.warehouseId,
          quantity: Number(order.actualYield),
          unitOfMeasure: order.bom.yieldUnit || 'units',
          referenceType: 'PRODUCTION_ORDER',
          referenceId: order.id,
          createdById: data.completedById,
          notes: `Production output for order ${order.orderNumber}`,
        });
      }
    }

    // Mark order as COMPLETED
    await tx.productionOrder.update({
      where: { id: data.productionOrderId },
      data: {
        status: 'COMPLETED',
        actualEnd: new Date(),
      },
    });
  });

  return {
    productionOrderId: data.productionOrderId,
    status: 'COMPLETED',
    processedAt: new Date(),
  };
}

// ============================================================================
// Status & Analytics
// ============================================================================

/**
 * Get ingredient lifecycle status for a production order.
 */
export async function getIngredientLifecycleStatus(productionOrderId: string) {
  const ingredients = await prisma.productionIngredient.findMany({
    where: { productionOrderId },
    include: { material: true },
  });

  const status = {
    total: ingredients.length,
    byStatus: {
      [ProductionIngredientStatus.RESERVED]: 0,
      [ProductionIngredientStatus.RELEASED]: 0,
      [ProductionIngredientStatus.CONSUMED]: 0,
      [ProductionIngredientStatus.RETURNED]: 0,
      [ProductionIngredientStatus.PARTIALLY_CONSUMED]: 0,
    },
    quantities: {
      projected: 0,
      released: 0,
      returned: 0,
      waste: 0,
    },
  };

  for (const ing of ingredients) {
    status.byStatus[ing.status]++;
    status.quantities.projected += Number(ing.projectedQuantity);
    status.quantities.released += Number(ing.releasedQuantity);
    status.quantities.returned += Number(ing.returnedQuantity);
    status.quantities.waste += Number(ing.returnedQuantity); // Waste = returned quantity
  }

  return status;
}

/**
 * Calculate waste percentage and efficiency metrics for a production order.
 */
export async function calculateWasteMetrics(productionOrderId: string) {
  const ingredients = await prisma.productionIngredient.findMany({
    where: { productionOrderId },
  });

  let totalProjected = 0;
  let totalReleased = 0;
  let totalReturned = 0;

  for (const ing of ingredients) {
    totalProjected += Number(ing.projectedQuantity);
    totalReleased += Number(ing.releasedQuantity);
    totalReturned += Number(ing.returnedQuantity);
  }

  const totalWaste = totalReturned;
  const totalConsumption = totalReleased;
  const wastePercentage = totalProjected > 0 ? (totalWaste / totalProjected) * 100 : 0;
  const consumptionEfficiency = totalProjected > 0 ? (totalConsumption / totalProjected) * 100 : 0;

  return {
    productionOrderId,
    totalProjected,
    totalReleased,
    totalReturned,
    totalWaste,
    totalConsumption,
    wastePercentage: Math.round(wastePercentage * 100) / 100,
    consumptionEfficiency: Math.round(consumptionEfficiency * 100) / 100,
  };
}
