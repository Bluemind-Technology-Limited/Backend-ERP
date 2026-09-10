import { prisma } from "../lib/db.js";

export const performanceService = {
  /**
   * Record machine performance
   */
  async recordPerformance(data: {
    machineId: string;
    recordDate: Date;
    targetOutput: number;
    actualOutput: number;
    downtime: number; // in minutes
    notes?: string;
  }) {
    // Calculate efficiency percentage
    const efficiency = data.targetOutput > 0 ? (data.actualOutput / data.targetOutput) * 100 : 0;

    return prisma.performance.create({
      data: {
        ...data,
        efficiencyPercentage: Math.min(efficiency, 100), // Cap at 100%
      },
      include: { machine: true },
    });
  },

  /**
   * Get performance records for machine
   */
  async getMachinePerformances(
    machineId: string,
    filters?: {
      startDate?: Date;
      endDate?: Date;
      skip?: number;
      take?: number;
    }
  ) {
    const { startDate, endDate, skip = 0, take = 50 } = filters || {};

    const where: any = { machineId };
    if (startDate || endDate) {
      where.recordDate = {};
      if (startDate) where.recordDate.gte = startDate;
      if (endDate) where.recordDate.lte = endDate;
    }

    const [performances, total] = await Promise.all([
      prisma.performance.findMany({
        where,
        skip,
        take,
        orderBy: { recordDate: "desc" },
      }),
      prisma.performance.count({ where }),
    ]);

    return { performances, total };
  },

  /**
   * Get performance metrics summary for date range
   */
  async getPerformanceSummary(machineId: string, startDate: Date, endDate: Date) {
    const performances = await prisma.performance.findMany({
      where: {
        machineId,
        recordDate: {
          gte: startDate,
          lte: endDate,
        },
      },
    });

    if (performances.length === 0) {
      return {
        machineId,
        recordCount: 0,
        averageEfficiency: 0,
        totalDowntime: 0,
        averageOutput: 0,
        highestEfficiency: 0,
        lowestEfficiency: 0,
      };
    }

    const efficiencies = performances.map((p) => Number(p.efficiencyPercentage));
    const outputs = performances.map((p) => Number(p.actualOutput));

    return {
      machineId,
      recordCount: performances.length,
      averageEfficiency: Math.round((efficiencies.reduce((a, b) => a + b, 0) / efficiencies.length) * 100) / 100,
      totalDowntime: performances.reduce((sum, p) => sum + p.downtime, 0),
      averageOutput: Math.round((outputs.reduce((a, b) => a + b, 0) / outputs.length) * 100) / 100,
      highestEfficiency: Math.max(...efficiencies),
      lowestEfficiency: Math.min(...efficiencies),
    };
  },

  /**
   * Get all machines performance comparison for date range
   */
  async getMultiMachinePerformance(machineIds: string[], startDate: Date, endDate: Date) {
    const performances = await prisma.performance.findMany({
      where: {
        machineId: { in: machineIds },
        recordDate: {
          gte: startDate,
          lte: endDate,
        },
      },
      include: { machine: { select: { id: true, name: true, code: true } } },
    });

    const grouped = performances.reduce(
      (acc, p) => {
        const machineId = p.machineId;
        if (!acc[machineId]) {
          acc[machineId] = {
            machine: p.machine,
            performances: [],
          };
        }
        acc[machineId].performances.push(p);
        return acc;
      },
      {} as Record<
        string,
        {
          machine: any;
          performances: typeof performances;
        }
      >
    );

    return Object.entries(grouped).map(([machineId, { machine, performances }]) => {
      const efficiencies = performances.map((p) => Number(p.efficiencyPercentage));
      return {
        machineId,
        machine,
        recordCount: performances.length,
        averageEfficiency: Math.round((efficiencies.reduce((a, b) => a + b, 0) / efficiencies.length) * 100) / 100,
        totalDowntime: performances.reduce((sum, p) => sum + p.downtime, 0),
      };
    });
  },

  /**
   * Delete old performance records (data cleanup)
   */
  async cleanupOldPerformanceRecords(olderThanDays: number = 365) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    return prisma.performance.deleteMany({
      where: {
        recordDate: { lt: cutoffDate },
      },
    });
  },
};
