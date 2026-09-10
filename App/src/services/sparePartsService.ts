import { prisma } from "../lib/db.js";

export const sparePartsService = {
  /**
   * Add spare part for machine
   */
  async addSparePart(data: {
    machineId: string;
    partName: string;
    partNumber: string;
    description?: string;
    supplier?: string;
    stockLevel: number;
    minStockLevel: number;
    costPerUnit: number;
  }) {
    return prisma.sparePart.create({
      data,
      include: { machine: true },
    });
  },

  /**
   * Get spare parts for machine
   */
  async getMachineSpareParts(machineId: string, filters?: { onlyLowStock?: boolean }) {
    const where: any = { machineId };

    if (filters?.onlyLowStock) {
      // SQLite/PostgreSQL: compare stockLevel with minStockLevel
      // We'll fetch all and filter in JS for now
    }

    const parts = await prisma.sparePart.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    if (filters?.onlyLowStock) {
      return parts.filter((p) => p.stockLevel <= p.minStockLevel);
    }

    return parts;
  },

  /**
   * Get single spare part
   */
  async getSparePartById(partId: string) {
    return prisma.sparePart.findUnique({
      where: { id: partId },
      include: { machine: true },
    });
  },

  /**
   * Update spare part
   */
  async updateSparePart(
    partId: string,
    data: {
      partName?: string;
      description?: string;
      supplier?: string;
      minStockLevel?: number;
      costPerUnit?: number;
    }
  ) {
    return prisma.sparePart.update({
      where: { id: partId },
      data,
      include: { machine: true },
    });
  },

  /**
   * Update stock level
   */
  async updateStockLevel(partId: string, newLevel: number) {
    return prisma.sparePart.update({
      where: { id: partId },
      data: {
        stockLevel: newLevel,
        lastRestockDate: newLevel > 0 ? new Date() : undefined,
      },
    });
  },

  /**
   * Increment stock (restock)
   */
  async restockPart(partId: string, quantity: number) {
    const part = await prisma.sparePart.findUnique({ where: { id: partId } });
    if (!part) throw new Error("Part not found");

    return prisma.sparePart.update({
      where: { id: partId },
      data: {
        stockLevel: part.stockLevel + quantity,
        lastRestockDate: new Date(),
      },
    });
  },

  /**
   * Decrement stock (usage)
   */
  async usePart(partId: string, quantity: number) {
    const part = await prisma.sparePart.findUnique({ where: { id: partId } });
    if (!part) throw new Error("Part not found");
    if (part.stockLevel < quantity) throw new Error("Insufficient stock");

    return prisma.sparePart.update({
      where: { id: partId },
      data: { stockLevel: part.stockLevel - quantity },
    });
  },

  /**
   * Get low stock spare parts across all machines
   */
  async getLowStockParts() {
    const parts = await prisma.sparePart.findMany({
      include: { machine: { select: { id: true, name: true, code: true, department: true } } },
    });

    return parts.filter((p) => p.stockLevel <= p.minStockLevel);
  },

  /**
   * Get spare parts inventory value by machine
   */
  async getMachinePartsInventoryValue(machineId: string) {
    const parts = await prisma.sparePart.findMany({
      where: { machineId },
    });

    const totalValue = parts.reduce((sum, p) => sum + p.stockLevel * Number(p.costPerUnit), 0);

    return {
      machineId,
      partCount: parts.length,
      totalValue,
      averageValue: parts.length > 0 ? totalValue / parts.length : 0,
      parts: parts.map((p) => ({
        id: p.id,
        name: p.partName,
        stockLevel: p.stockLevel,
        value: p.stockLevel * Number(p.costPerUnit),
      })),
    };
  },

  /**
   * Delete spare part
   */
  async deleteSparePart(partId: string) {
    return prisma.sparePart.delete({
      where: { id: partId },
    });
  },

  /**
   * Get all spare parts inventory summary
   */
  async getInventorySummary() {
    const parts = await prisma.sparePart.findMany({
      include: { machine: { select: { id: true, name: true, code: true, department: true } } },
    });

    const totalValue = parts.reduce((sum, p) => sum + p.stockLevel * Number(p.costPerUnit), 0);
    const lowStockCount = parts.filter((p) => p.stockLevel <= p.minStockLevel).length;

    return {
      totalParts: parts.length,
      totalValue,
      lowStockCount,
      averageStockPerPart: parts.length > 0 ? parts.reduce((sum, p) => sum + p.stockLevel, 0) / parts.length : 0,
    };
  },
};
