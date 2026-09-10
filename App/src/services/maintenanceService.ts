import { prisma } from "../lib/db.js";
import type { MaintenanceType, MaintenanceStatus } from "@prisma/client";

export const maintenanceService = {
  /**
   * Create maintenance schedule
   */
  async createMaintenance(data: {
    machineId: string;
    type: MaintenanceType;
    scheduledDate: Date;
    description?: string;
    techniciansAssigned?: string; // comma-separated technician IDs
    estimatedDuration?: number;
    costEstimate?: number;
  }) {
    return prisma.maintenance.create({
      data: {
        ...data,
        status: "SCHEDULED",
      },
      include: { machine: true },
    });
  },

  /**
   * Get maintenance records for machine
   */
  async getMachineMaintenances(
    machineId: string,
    filters?: {
      status?: MaintenanceStatus;
      type?: MaintenanceType;
      skip?: number;
      take?: number;
    }
  ) {
    const { status, type, skip = 0, take = 50 } = filters || {};

    const where: any = { machineId };
    if (status) where.status = status;
    if (type) where.type = type;

    const [maintenances, total] = await Promise.all([
      prisma.maintenance.findMany({
        where,
        orderBy: { scheduledDate: "desc" },
        skip,
        take,
      }),
      prisma.maintenance.count({ where }),
    ]);

    return { maintenances, total };
  },

  /**
   * Get single maintenance record
   */
  async getMaintenanceById(maintenanceId: string) {
    return prisma.maintenance.findUnique({
      where: { id: maintenanceId },
      include: { machine: true },
    });
  },

  /**
   * Start maintenance
   */
  async startMaintenance(maintenanceId: string) {
    return prisma.maintenance.update({
      where: { id: maintenanceId },
      data: { status: "IN_PROGRESS" },
      include: { machine: true },
    });
  },

  /**
   * Complete maintenance
   */
  async completeMaintenance(
    maintenanceId: string,
    data?: {
      actualDuration?: number;
      actualCost?: number;
      notes?: string;
    }
  ) {
    return prisma.maintenance.update({
      where: { id: maintenanceId },
      data: {
        status: "COMPLETED",
        completedDate: new Date(),
        ...data,
      },
      include: { machine: true },
    });
  },

  /**
   * Cancel maintenance
   */
  async cancelMaintenance(maintenanceId: string) {
    return prisma.maintenance.update({
      where: { id: maintenanceId },
      data: { status: "CANCELLED" },
      include: { machine: true },
    });
  },

  /**
   * Get upcoming maintenance (next 30 days)
   */
  async getUpcomingMaintenance(days: number = 30) {
    const today = new Date();
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + days);

    return prisma.maintenance.findMany({
      where: {
        status: { in: ["SCHEDULED"] },
        scheduledDate: {
          gte: today,
          lte: futureDate,
        },
      },
      include: {
        machine: { select: { id: true, name: true, code: true, department: true } },
      },
      orderBy: { scheduledDate: "asc" },
    });
  },

  /**
   * Get overdue maintenance
   */
  async getOverdueMaintenance() {
    const today = new Date();

    return prisma.maintenance.findMany({
      where: {
        status: { in: ["SCHEDULED", "IN_PROGRESS"] },
        scheduledDate: { lt: today },
      },
      include: {
        machine: { select: { id: true, name: true, code: true, department: true } },
      },
      orderBy: { scheduledDate: "asc" },
    });
  },

  /**
   * Get maintenance statistics for machine
   */
  async getMaintenanceStats(machineId: string, days: number = 90) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const maintenances = await prisma.maintenance.findMany({
      where: {
        machineId,
        createdAt: { gte: startDate },
      },
    });

    const completed = maintenances.filter((m) => m.status === "COMPLETED");
    const preventive = maintenances.filter((m) => m.type === "PREVENTIVE");
    const corrective = maintenances.filter((m) => m.type === "CORRECTIVE");
    const totalCost = completed.reduce((sum, m) => sum + Number(m.actualCost || 0), 0);

    return {
      machineId,
      totalMaintenance: maintenances.length,
      completedMaintenance: completed.length,
      preventiveMaintenance: preventive.length,
      correctiveMaintenance: corrective.length,
      totalCost,
      averageCost: completed.length > 0 ? totalCost / completed.length : 0,
    };
  },

  /**
   * Get all pending maintenance
   */
  async getPendingMaintenance() {
    return prisma.maintenance.findMany({
      where: {
        status: { in: ["SCHEDULED", "IN_PROGRESS"] },
      },
      include: {
        machine: { select: { id: true, name: true, code: true, department: true } },
      },
      orderBy: { scheduledDate: "asc" },
    });
  },
};
