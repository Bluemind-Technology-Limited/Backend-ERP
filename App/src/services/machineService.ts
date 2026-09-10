import { prisma } from "../lib/db.js";

export const machineService = {
  /**
   * Get all machine categories
   */
  async getCategories() {
    console.log("[machineService] getCategories called");
    try {
      const categories = await prisma.machineCategory.findMany({
        where: { isActive: true },
        orderBy: { name: "asc" },
      });
      console.log(`[machineService] getCategories returning ${categories.length} categories`);
      return categories;
    } catch (error) {
      console.error("[machineService] getCategories error:", error);
      throw error;
    }
  },

  /**
   * Get all machine departments
   */
  async getDepartments() {
    console.log("[machineService] getDepartments called");
    try {
      const departments = await prisma.machineDepartment.findMany({
        where: { isActive: true },
        orderBy: { name: "asc" },
      });
      console.log(`[machineService] getDepartments returning ${departments.length} departments`);
      return departments;
    } catch (error) {
      console.error("[machineService] getDepartments error:", error);
      throw error;
    }
  },

  /**
   * Get all machine locations
   */
  async getLocations() {
    console.log("[machineService] getLocations called");
    try {
      const locations = await prisma.machineLocation.findMany({
        where: { isActive: true },
        orderBy: { name: "asc" },
      });
      console.log(`[machineService] getLocations returning ${locations.length} locations`);
      return locations;
    } catch (error) {
      console.error("[machineService] getLocations error:", error);
      throw error;
    }
  },

  /**
   * Get all machines with optional filtering and search
   */
  async getAllMachines(
    filters?: {
      status?: string;
      categoryId?: string;
      departmentId?: string;
      locationId?: string;
      search?: string;
      skip?: number;
      take?: number;
    }
  ) {
    console.log("[machineService] getAllMachines called with filters:", JSON.stringify(filters));
    const { status, categoryId, departmentId, locationId, search, skip = 0, take = 50 } = filters || {};

    const where: any = {};
    if (status) where.status = status;
    if (categoryId) where.categoryId = categoryId;
    if (departmentId) where.departmentId = departmentId;
    if (locationId) where.locationId = locationId;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { code: { contains: search, mode: "insensitive" } },
        { serialNumber: { contains: search, mode: "insensitive" } },
      ];
    }

    console.log("[machineService] Prisma where clause:", JSON.stringify(where));

    try {
      const [machines, total] = await Promise.all([
        prisma.machine.findMany({
          where,
          skip,
          take,
          orderBy: { createdAt: "desc" },
        }),
        prisma.machine.count({ where }),
      ]);

      console.log(`[machineService] getAllMachines returning ${machines.length} machines (total: ${total})`);
      return { machines, total };
    } catch (error) {
      console.error("[machineService] getAllMachines error:", error);
      throw error;
    }
  },

  /**
   * Get single machine by ID with all related data
   */
  async getMachineById(machineId: string) {
    console.log(`[machineService] getMachineById called for ID: ${machineId}`);
    try {
      const machine = await prisma.machine.findUnique({
        where: { id: machineId },
      });
      console.log(`[machineService] getMachineById result:`, machine ? `Found machine ${machine.id}` : "Machine not found");
      return machine;
    } catch (error) {
      console.error(`[machineService] getMachineById error for ID ${machineId}:`, error);
      throw error;
    }
  },

  /**
   * Create a new machine
   */
  async createMachine(data: {
    name: string;
    code: string;
    serialNumber: string;
    categoryId: string;
    departmentId: string;
    locationId?: string;
    status?: string;
  }) {
    console.log("[machineService] createMachine called with data:", JSON.stringify(data, null, 2));
    try {
      const result = await prisma.machine.create({
        data: {
          ...data,
          status: data.status || "ACTIVE",
        },
      });
      console.log(`[machineService] createMachine success: Created machine ${result.id}`);
      return result;
    } catch (error) {
      console.error("[machineService] createMachine error:", error);
      throw error;
    }
  },

  /**
   * Update machine
   */
  async updateMachine(
    machineId: string,
    data: {
      name?: string;
      categoryId?: string;
      departmentId?: string;
      locationId?: string;
      status?: string;
    }
  ) {
    console.log(`[machineService] updateMachine called for ID: ${machineId} with data:`, JSON.stringify(data));
    try {
      const result = await prisma.machine.update({
        where: { id: machineId },
        data,
      });
      console.log(`[machineService] updateMachine success: Updated machine ${machineId}`);
      return result;
    } catch (error) {
      console.error(`[machineService] updateMachine error for ID ${machineId}:`, error);
      throw error;
    }
  },

  /**
   * Delete machine
   */
  async deleteMachine(machineId: string) {
    console.log(`[machineService] deleteMachine called for ID: ${machineId}`);
    try {
      const result = await prisma.machine.delete({
        where: { id: machineId },
      });
      console.log(`[machineService] deleteMachine success: Deleted machine ${machineId}`);
      return result;
    } catch (error) {
      console.error(`[machineService] deleteMachine error for ID ${machineId}:`, error);
      throw error;
    }
  },
};
