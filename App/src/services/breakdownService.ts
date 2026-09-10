import { prisma } from "../lib/db.js";
import type { BreakdownStatus } from "@prisma/client";

export const breakdownService = {
  /**
   * Report a machine breakdown
   */
  async reportBreakdown(data: {
    machineId: string;
    reportedById: string;
    description: string;
    issueCategory?: string;
    severity?: string;
  }) {
    return prisma.breakdown.create({
      data: {
        ...data,
        reportedAt: new Date(),
        status: "REPORTED",
        severity: data.severity || "MEDIUM",
      },
      include: {
        machine: true,
        reportedBy: { select: { id: true, fullName: true, email: true } },
      },
    });
  },

  /**
   * Get breakdowns for a machine
   */
  async getMachineBreakdowns(
    machineId: string,
    filters?: {
      status?: BreakdownStatus;
      severity?: string;
      skip?: number;
      take?: number;
    }
  ) {
    const { status, severity, skip = 0, take = 50 } = filters || {};

    const where: any = { machineId };
    if (status) where.status = status;
    if (severity) where.severity = severity;

    const [breakdowns, total] = await Promise.all([
      prisma.breakdown.findMany({
        where,
        include: {
          reportedBy: { select: { id: true, fullName: true, email: true } },
          resolvedBy: { select: { id: true, fullName: true, email: true } },
        },
        orderBy: { reportedAt: "desc" },
        skip,
        take,
      }),
      prisma.breakdown.count({ where }),
    ]);

    return { breakdowns, total };
  },

  /**
   * Get single breakdown
   */
  async getBreakdownById(breakdownId: string) {
    return prisma.breakdown.findUnique({
      where: { id: breakdownId },
      include: {
        machine: true,
        reportedBy: true,
        resolvedBy: true,
      },
    });
  },

  /**
   * Acknowledge breakdown (mark as acknowledged)
   */
  async acknowledgeBreakdown(breakdownId: string) {
    return prisma.breakdown.update({
      where: { id: breakdownId },
      data: { status: "ACKNOWLEDGED" },
      include: {
        machine: true,
        reportedBy: true,
      },
    });
  },

  /**
   * Start resolving breakdown
   */
  async startResolution(breakdownId: string) {
    return prisma.breakdown.update({
      where: { id: breakdownId },
      data: { status: "IN_PROGRESS" },
      include: { machine: true },
    });
  },

  /**
   * Resolve breakdown
   */
  async resolveBreakdown(
    breakdownId: string,
    data: {
      resolvedById: string;
      resolutionNotes?: string;
      downtimeDuration?: number;
    }
  ) {
    return prisma.breakdown.update({
      where: { id: breakdownId },
      data: {
        status: "RESOLVED",
        resolvedAt: new Date(),
        ...data,
      },
      include: {
        machine: true,
        reportedBy: true,
        resolvedBy: true,
      },
    });
  },

  /**
   * Close breakdown
   */
  async closeBreakdown(breakdownId: string) {
    return prisma.breakdown.update({
      where: { id: breakdownId },
      data: { status: "CLOSED" },
      include: { machine: true },
    });
  },

  /**
   * Get unresolved breakdowns for a machine
   */
  async getUnresolvedBreakdowns(machineId: string) {
    return prisma.breakdown.findMany({
      where: {
        machineId,
        status: { in: ["REPORTED", "ACKNOWLEDGED", "IN_PROGRESS"] },
      },
      include: {
        reportedBy: { select: { id: true, fullName: true } },
      },
      orderBy: { reportedAt: "asc" },
    });
  },

  /**
   * Get breakdown statistics
   */
  async getBreakdownStats(machineId: string, days: number = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const breakdowns = await prisma.breakdown.findMany({
      where: {
        machineId,
        reportedAt: { gte: startDate },
      },
    });

    const resolved = breakdowns.filter((b) => b.status === "RESOLVED" || b.status === "CLOSED");
    const critical = breakdowns.filter((b) => b.severity === "CRITICAL");
    const totalDowntime = breakdowns.reduce((sum, b) => sum + (b.downtimeDuration || 0), 0);

    return {
      machineId,
      totalBreakdowns: breakdowns.length,
      resolvedBreakdowns: resolved.length,
      unresolvedBreakdowns: breakdowns.length - resolved.length,
      criticalBreakdowns: critical.length,
      averageDowntime: resolved.length > 0 ? totalDowntime / resolved.length : 0,
      totalDowntime,
    };
  },

  /**
   * Get critical breakdowns across all machines
   */
  async getCriticalBreakdowns() {
    return prisma.breakdown.findMany({
      where: {
        severity: "CRITICAL",
        status: { in: ["REPORTED", "ACKNOWLEDGED", "IN_PROGRESS"] },
      },
      include: {
        machine: { select: { id: true, name: true, code: true } },
        reportedBy: { select: { id: true, fullName: true } },
      },
      orderBy: { reportedAt: "asc" },
    });
  },
};
