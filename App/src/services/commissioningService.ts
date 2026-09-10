import { prisma } from "../lib/db.js";

export const commissioningService = {
  /**
   * Create commissioning log
   */
  async createCommissioning(data: {
    machineId: string;
    commissionedById: string;
    commissioningDate: Date;
    installationStatus: string;
    testResults?: string;
    notes?: string;
  }) {
    return prisma.commissioning.create({
      data,
      include: {
        machine: true,
        commissionedBy: { select: { id: true, fullName: true, email: true } },
      },
    });
  },

  /**
   * Get commissioning logs for a machine
   */
  async getMachineCommissionings(machineId: string, take: number = 10) {
    return prisma.commissioning.findMany({
      where: { machineId },
      include: {
        commissionedBy: { select: { id: true, fullName: true, email: true } },
      },
      orderBy: { commissioningDate: "desc" },
      take,
    });
  },

  /**
   * Get specific commissioning record
   */
  async getCommissioningById(commissioningId: string) {
    return prisma.commissioning.findUnique({
      where: { id: commissioningId },
      include: {
        machine: true,
        commissionedBy: true,
      },
    });
  },

  /**
   * Update commissioning record
   */
  async updateCommissioning(
    commissioningId: string,
    data: {
      installationStatus?: string;
      testResults?: string;
      notes?: string;
    }
  ) {
    return prisma.commissioning.update({
      where: { id: commissioningId },
      data,
      include: {
        machine: true,
        commissionedBy: true,
      },
    });
  },

  /**
   * Get latest commissioning for machine
   */
  async getLatestCommissioning(machineId: string) {
    return prisma.commissioning.findFirst({
      where: { machineId },
      orderBy: { commissioningDate: "desc" },
      include: { commissionedBy: true },
    });
  },

  /**
   * Get commissioning count by status
   */
  async getCommissioningStatusSummary(machineId: string) {
    const commissionings = await prisma.commissioning.findMany({
      where: { machineId },
      select: { installationStatus: true },
    });

    const summary = commissionings.reduce(
      (acc, c) => {
        acc[c.installationStatus] = (acc[c.installationStatus] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    return summary;
  },
};
