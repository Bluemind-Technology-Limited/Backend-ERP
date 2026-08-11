import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { prisma } from "../lib/db.js";
import { MaterialType, RecordStatus } from "@prisma/client";

const router: Router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Warehouses
// ---------------------------------------------------------------------------

router.get("/warehouses", requirePermission("master_data", "read"), async (_req: Request, res: Response) => {
  try {
    const warehouses = await prisma.warehouse.findMany({
      orderBy: { createdAt: "asc" },
      include: {
        zones: { include: { bins: true }, orderBy: { name: "asc" } },
      },
    });
    res.json({ warehouses });
  } catch (error) {
    console.error("GET /master-data/warehouses error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.post("/warehouses", requirePermission("master_data", "create"), async (req: Request, res: Response) => {
  try {
    const { name, code, address, status } = req.body;
    if (!name || !code) {
      return res.status(400).json({ error: "name and code are required" });
    }
    const warehouse = await prisma.warehouse.create({
      data: { name, code, address, status: status ?? "ACTIVE" },
    });
    res.status(201).json({ warehouse });
  } catch (error: any) {
    if (error?.code === "P2002") return res.status(409).json({ error: `Warehouse code "${req.body.code}" already exists` });
    console.error("POST /master-data/warehouses error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.patch("/warehouses/:id", requirePermission("master_data", "update"), async (req: Request, res: Response) => {
  try {
    const { name, address, status } = req.body;
    const warehouse = await prisma.warehouse.update({
      where: { id: req.params.id },
      data: { name, address, status },
    });
    res.json({ warehouse });
  } catch (error) {
    console.error("PATCH /master-data/warehouses/:id error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.delete("/warehouses/:id", requirePermission("master_data", "delete"), async (req: Request, res: Response) => {
  try {
    await prisma.warehouse.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (error: any) {
    if (error?.code === "P2003") return res.status(409).json({ error: "Cannot delete: warehouse has zones/bins or transactions" });
    console.error("DELETE /master-data/warehouses/:id error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

router.post("/zones", requirePermission("master_data", "create"), async (req: Request, res: Response) => {
  try {
    const { warehouseId, name, code } = req.body;
    if (!warehouseId || !name || !code) {
      return res.status(400).json({ error: "warehouseId, name and code are required" });
    }
    const zone = await prisma.zone.create({
      data: { warehouseId, name, code },
    });
    res.status(201).json({ zone });
  } catch (error) {
    console.error("POST /master-data/zones error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.patch("/zones/:id", requirePermission("master_data", "update"), async (req: Request, res: Response) => {
  try {
    const { name, code, status } = req.body;
    const zone = await prisma.zone.update({
      where: { id: req.params.id },
      data: { name, code, status },
    });
    res.json({ zone });
  } catch (error) {
    console.error("PATCH /master-data/zones/:id error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.delete("/zones/:id", requirePermission("master_data", "delete"), async (req: Request, res: Response) => {
  try {
    await prisma.zone.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (error) {
    console.error("DELETE /master-data/zones/:id error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// ---------------------------------------------------------------------------
// Bins
// ---------------------------------------------------------------------------

router.post("/bins", requirePermission("master_data", "create"), async (req: Request, res: Response) => {
  try {
    const { zoneId, warehouseId, name, code } = req.body;
    if (!zoneId || !warehouseId || !name || !code) {
      return res.status(400).json({ error: "zoneId, warehouseId, name and code are required" });
    }
    const bin = await prisma.warehouseBin.create({
      data: { zoneId, warehouseId, name, code },
    });
    res.status(201).json({ bin });
  } catch (error) {
    console.error("POST /master-data/bins error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.patch("/bins/:id", requirePermission("master_data", "update"), async (req: Request, res: Response) => {
  try {
    const { name, code, status } = req.body;
    const bin = await prisma.warehouseBin.update({
      where: { id: req.params.id },
      data: { name, code, status },
    });
    res.json({ bin });
  } catch (error) {
    console.error("PATCH /master-data/bins/:id error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.delete("/bins/:id", requirePermission("master_data", "delete"), async (req: Request, res: Response) => {
  try {
    await prisma.warehouseBin.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (error) {
    console.error("DELETE /master-data/bins/:id error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// ---------------------------------------------------------------------------
// Materials (Material Master)
// ---------------------------------------------------------------------------

router.get("/materials", requirePermission("master_data", "read"), async (req: Request, res: Response) => {
  try {
    const { type, status, q, supplierId } = req.query;
    const materials = await prisma.material.findMany({
      where: {
        ...(type ? { type: type as MaterialType } : {}),
        ...(status ? { status: status as RecordStatus } : {}),
        ...(supplierId
          ? { suppliers: { some: { supplierId: supplierId as string } } }
          : {}),
        ...(q
          ? {
              OR: [
                { name: { contains: q as string, mode: "insensitive" } },
                { sku: { contains: q as string, mode: "insensitive" } },
                { barcode: { contains: q as string, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: {
        suppliers: { include: { supplier: { select: { id: true, name: true } } } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ materials });
  } catch (error) {
    console.error("GET /master-data/materials error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.post("/materials", requirePermission("master_data", "create"), async (req: Request, res: Response) => {
  try {
    const { name, sku, type, category, unitOfMeasure, barcode, shelfLifeDays, requiresLot, attachments, supplierIds } = req.body;
    if (!name || !sku || !type || !unitOfMeasure) {
      return res.status(400).json({ error: "name, sku, type and unitOfMeasure are required" });
    }
    const material = await prisma.material.create({
      data: {
        name,
        sku,
        type,
        category: category ?? null,
        unitOfMeasure,
        barcode: barcode ?? null,
        shelfLifeDays: shelfLifeDays ? Number(shelfLifeDays) : null,
        requiresLot: requiresLot ?? true,
        attachments: attachments ?? [],
        suppliers: Array.isArray(supplierIds) && supplierIds.length
          ? { create: supplierIds.map((sid: string) => ({ supplierId: sid })) }
          : undefined,
      },
    });
    res.status(201).json({ material });
  } catch (error: any) {
    if (error?.code === "P2002") return res.status(409).json({ error: `SKU "${req.body.sku}" already exists` });
    console.error("POST /master-data/materials error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.patch("/materials/:id", requirePermission("master_data", "update"), async (req: Request, res: Response) => {
  try {
    const { name, category, unitOfMeasure, barcode, shelfLifeDays, requiresLot, attachments, status, supplierIds } = req.body;
    const material = await prisma.material.update({
      where: { id: req.params.id },
      data: {
        name,
        category,
        unitOfMeasure,
        barcode,
        shelfLifeDays: shelfLifeDays !== undefined ? Number(shelfLifeDays) : undefined,
        requiresLot,
        attachments,
        status,
        ...(Array.isArray(supplierIds)
          ? {
              suppliers: {
                deleteMany: {},
                create: supplierIds.map((sid: string) => ({ supplierId: sid })),
              },
            }
          : {}),
      },
    });
    res.json({ material });
  } catch (error) {
    console.error("PATCH /master-data/materials/:id error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// ---------------------------------------------------------------------------
// Suppliers (Supplier Directory)
// ---------------------------------------------------------------------------

router.get("/suppliers", requirePermission("master_data", "read"), async (req: Request, res: Response) => {
  try {
    const { q, status } = req.query;
    const suppliers = await prisma.supplier.findMany({
      where: {
        ...(status ? { status: status as RecordStatus } : {}),
        ...(q
          ? {
              OR: [
                { name: { contains: q as string, mode: "insensitive" } },
                { contactPerson: { contains: q as string, mode: "insensitive" } },
                { email: { contains: q as string, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ suppliers });
  } catch (error) {
    console.error("GET /master-data/suppliers error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.post("/suppliers", requirePermission("master_data", "create"), async (req: Request, res: Response) => {
  try {
    const { name, contactPerson, email, phone, address, taxId } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const supplier = await prisma.supplier.create({
      data: { name, contactPerson, email, phone, address, taxId },
    });
    res.status(201).json({ supplier });
  } catch (error) {
    console.error("POST /master-data/suppliers error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.patch("/suppliers/:id", requirePermission("master_data", "update"), async (req: Request, res: Response) => {
  try {
    const { name, contactPerson, email, phone, address, taxId, status } = req.body;
    const supplier = await prisma.supplier.update({
      where: { id: req.params.id },
      data: { name, contactPerson, email, phone, address, taxId, status },
    });
    res.json({ supplier });
  } catch (error) {
    console.error("PATCH /master-data/suppliers/:id error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
