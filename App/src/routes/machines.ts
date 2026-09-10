import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { machineService } from "../services/machineService.js";

const router: Router = Router();

// Middleware: All routes require auth
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Master Data Dropdowns
// ---------------------------------------------------------------------------

/**
 * GET /machines/categories — Get all active machine categories
 */
router.get("/categories", async (req: Request, res: Response) => {
  console.log("[machines.router] GET /categories called");
  console.log("[machines.router] User ID:", req.user?.id);
  
  try {
    const categories = await machineService.getCategories();
    console.log("[machines.router] GET /categories success: returning", categories.length, "categories");
    res.json(categories);
  } catch (error: any) {
    console.error("[machines.router] GET /categories error:", error);
    res.status(500).json({ error: "Failed to fetch categories", details: error.message });
  }
});

/**
 * GET /machines/departments — Get all active machine departments
 */
router.get("/departments", async (req: Request, res: Response) => {
  console.log("[machines.router] GET /departments called");
  console.log("[machines.router] User ID:", req.user?.id);
  
  try {
    const departments = await machineService.getDepartments();
    console.log("[machines.router] GET /departments success: returning", departments.length, "departments");
    res.json(departments);
  } catch (error: any) {
    console.error("[machines.router] GET /departments error:", error);
    res.status(500).json({ error: "Failed to fetch departments", details: error.message });
  }
});

/**
 * GET /machines/locations — Get all active machine locations
 */
router.get("/locations", async (req: Request, res: Response) => {
  console.log("[machines.router] GET /locations called");
  console.log("[machines.router] User ID:", req.user?.id);
  
  try {
    const locations = await machineService.getLocations();
    console.log("[machines.router] GET /locations success: returning", locations.length, "locations");
    res.json(locations);
  } catch (error: any) {
    console.error("[machines.router] GET /locations error:", error);
    res.status(500).json({ error: "Failed to fetch locations", details: error.message });
  }
});

// ---------------------------------------------------------------------------
// Machines (Master Register)
// ---------------------------------------------------------------------------

/**
 * GET /machines — List all machines with filters
 */
router.get("/", requirePermission("machines", "read"), async (req: Request, res: Response) => {
  console.log("[machines.router] GET / called");
  console.log("[machines.router] User ID:", req.user?.id);
  console.log("[machines.router] Query params:", JSON.stringify(req.query));
  
  try {
    const { status, categoryId, departmentId, locationId, search, skip, take } = req.query;

    const filters = {
      status: (status as string) || undefined,
      categoryId: (categoryId as string) || undefined,
      departmentId: (departmentId as string) || undefined,
      locationId: (locationId as string) || undefined,
      search: (search as string) || undefined,
      skip: parseInt(skip as string) || 0,
      take: parseInt(take as string) || 50,
    };

    console.log("[machines.router] Calling machineService.getAllMachines with filters:", JSON.stringify(filters));
    const result = await machineService.getAllMachines(filters);

    console.log("[machines.router] GET / success: returning", result.machines.length, "machines");
    res.json(result);
  } catch (error: any) {
    console.error("[machines.router] GET / error:", error);
    res.status(500).json({ error: "Failed to fetch machines", details: error.message });
  }
});

/**
 * GET /machines/:id — Get machine details
 */
router.get("/:id", requirePermission("machines", "read"), async (req: Request, res: Response) => {
  console.log(`[machines.router] GET /:id called with ID: ${req.params.id}`);
  console.log("[machines.router] User ID:", req.user?.id);
  
  try {
    const machine = await machineService.getMachineById(req.params.id);
    if (!machine) {
      console.log(`[machines.router] GET /:id - Machine ${req.params.id} not found`);
      return res.status(404).json({ error: "Machine not found" });
    }
    console.log(`[machines.router] GET /:id success: Found machine ${req.params.id}`);
    res.json(machine);
  } catch (error: any) {
    console.error(`[machines.router] GET /:id error:`, error);
    res.status(500).json({ error: "Failed to fetch machine", details: error.message });
  }
});

/**
 * POST /machines — Create new machine
 */
router.post("/", requirePermission("machines", "create"), async (req: Request, res: Response) => {
  console.log("[machines.router] POST / called (create machine)");
  console.log("[machines.router] User ID:", req.user?.id);
  console.log("[machines.router] Request body:", JSON.stringify(req.body, null, 2));
  
  try {
    const {
      name,
      code,
      serialNumber,
      categoryId,
      departmentId,
      locationId,
      status,
    } = req.body;

    if (!name || !code || !serialNumber || !categoryId || !departmentId) {
      console.log("[machines.router] POST / validation failed: missing required fields");
      return res.status(400).json({
        error: "name, code, serialNumber, categoryId, and departmentId are required",
      });
    }

    console.log("[machines.router] POST / calling machineService.createMachine");
    const machine = await machineService.createMachine({
      name,
      code,
      serialNumber,
      categoryId,
      departmentId,
      locationId,
      status,
    });

    console.log("[machines.router] POST / success: Created machine", machine.id);
    res.status(201).json(machine);
  } catch (error: any) {
    console.error("[machines.router] POST / error:", error);
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Machine code or serial number already exists" });
    }
    res.status(500).json({ error: "Failed to create machine", details: error.message });
  }
});

/**
 * PATCH /machines/:id — Update machine
 */
router.patch("/:id", requirePermission("machines", "update"), async (req: Request, res: Response) => {
  console.log(`[machines.router] PATCH /:id called with ID: ${req.params.id}`);
  console.log("[machines.router] User ID:", req.user?.id);
  console.log("[machines.router] Request body:", JSON.stringify(req.body, null, 2));
  
  try {
    const { name, categoryId, departmentId, locationId, status } = req.body;

    console.log(`[machines.router] PATCH /:id calling machineService.updateMachine`);
    const machine = await machineService.updateMachine(req.params.id, {
      name,
      categoryId,
      departmentId,
      locationId,
      status,
    });

    console.log(`[machines.router] PATCH /:id success: Updated machine ${req.params.id}`);
    res.json(machine);
  } catch (error: any) {
    console.error(`[machines.router] PATCH /:id error:`, error);
    res.status(500).json({ error: "Failed to update machine", details: error.message });
  }
});

/**
 * DELETE /machines/:id — Delete machine
 */
router.delete("/:id", requirePermission("machines", "delete"), async (req: Request, res: Response) => {
  console.log(`[machines.router] DELETE /:id called with ID: ${req.params.id}`);
  console.log("[machines.router] User ID:", req.user?.id);
  
  try {
    console.log(`[machines.router] DELETE /:id calling machineService.deleteMachine`);
    await machineService.deleteMachine(req.params.id);
    console.log(`[machines.router] DELETE /:id success: Deleted machine ${req.params.id}`);
    res.json({ ok: true, message: "Machine deleted" });
  } catch (error: any) {
    console.error(`[machines.router] DELETE /:id error:`, error);
    res.status(500).json({ error: "Failed to delete machine", details: error.message });
  }
});

export default router;
