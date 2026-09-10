import { prisma } from "../lib/db.js";

export const staffAssignmentService = {
  /**
   * Assign staff to machine
   */
  async assignStaffToMachine(data: { machineId: string; userId: string; role: string }) {
    // Check if already assigned
    const existing = await prisma.staffAssignment.findFirst({
      where: {
        machineId: data.machineId,
        userId: data.userId,
        isActive: true,
      },
    });

    if (existing) {
      throw new Error("Staff member already assigned to this machine");
    }

    return prisma.staffAssignment.create({
      data: {
        ...data,
        assignedDate: new Date(),
        isActive: true,
      },
      include: {
        user: { select: { id: true, fullName: true, email: true, role: true } },
        machine: { select: { id: true, name: true, code: true } },
      },
    });
  },

  /**
   * Get staff assigned to machine
   */
  async getMachineStaff(machineId: string, activeOnly: boolean = true) {
    return prisma.staffAssignment.findMany({
      where: {
        machineId,
        ...(activeOnly && { isActive: true }),
      },
      include: {
        user: { select: { id: true, fullName: true, email: true, role: true } },
      },
      orderBy: { assignedDate: "desc" },
    });
  },

  /**
   * Get machines assigned to user
   */
  async getUserMachines(userId: string, activeOnly: boolean = true) {
    return prisma.staffAssignment.findMany({
      where: {
        userId,
        ...(activeOnly && { isActive: true }),
      },
      include: {
        machine: { select: { id: true, name: true, code: true, department: true, status: true } },
      },
      orderBy: { assignedDate: "desc" },
    });
  },

  /**
   * Get single assignment
   */
  async getAssignmentById(assignmentId: string) {
    return prisma.staffAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        user: true,
        machine: true,
      },
    });
  },

  /**
   * Unassign staff from machine
   */
  async unassignStaff(assignmentId: string) {
    return prisma.staffAssignment.update({
      where: { id: assignmentId },
      data: {
        isActive: false,
        unassignedDate: new Date(),
      },
      include: {
        user: { select: { id: true, fullName: true } },
        machine: { select: { id: true, name: true, code: true } },
      },
    });
  },

  /**
   * Get staff by role and status
   */
  async getStaffByRole(machineId: string, role: string) {
    return prisma.staffAssignment.findMany({
      where: {
        machineId,
        role,
        isActive: true,
      },
      include: {
        user: { select: { id: true, fullName: true, email: true, role: true } },
      },
    });
  },

  /**
   * Get operators for a machine
   */
  async getMachineOperators(machineId: string) {
    return this.getStaffByRole(machineId, "OPERATOR");
  },

  /**
   * Get technicians for a machine
   */
  async getMachineTechnicians(machineId: string) {
    return this.getStaffByRole(machineId, "TECHNICIAN");
  },

  /**
   * Get workload (machines) for user
   */
  async getUserWorkload(userId: string) {
    const assignments = await prisma.staffAssignment.findMany({
      where: {
        userId,
        isActive: true,
      },
      include: {
        machine: { select: { id: true, name: true, code: true, status: true } },
      },
    });

    const byRole = assignments.reduce(
      (acc, a) => {
        if (!acc[a.role]) acc[a.role] = [];
        acc[a.role].push(a.machine);
        return acc;
      },
      {} as Record<string, any[]>
    );

    return {
      userId,
      totalAssignments: assignments.length,
      byRole,
    };
  },

  /**
   * Get staff coverage summary for machine
   */
  async getStaffCoverageSummary(machineId: string) {
    const staff = await prisma.staffAssignment.findMany({
      where: {
        machineId,
        isActive: true,
      },
      include: {
        user: { select: { id: true, fullName: true, role: true } },
      },
    });

    const byRole = staff.reduce(
      (acc, s) => {
        if (!acc[s.role]) acc[s.role] = [];
        acc[s.role].push({ id: s.user.id, name: s.user.fullName });
        return acc;
      },
      {} as Record<string, any[]>
    );

    return {
      machineId,
      totalStaff: staff.length,
      byRole,
    };
  },

  /**
   * Reassign staff to different role on same machine
   */
  async reassignStaffRole(assignmentId: string, newRole: string) {
    return prisma.staffAssignment.update({
      where: { id: assignmentId },
      data: { role: newRole },
      include: {
        user: { select: { id: true, fullName: true } },
        machine: { select: { id: true, name: true, code: true } },
      },
    });
  },
};
