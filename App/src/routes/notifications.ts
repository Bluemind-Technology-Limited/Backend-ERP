import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../lib/db.js";
import { getStock } from "../lib/ledger.js";

const router: Router = Router();
router.use(requireAuth);

/**
 * POST /notifications/generate — scans for alerts (expiry, low stock, pending
 * approvals) and inserts Notification rows for the affected roles.
 * Deduped by (userId, type, title) among unread notifications.
 */
router.post("/generate", async (req: Request, res: Response) => {
  try {
    const alerts: Array<{ type: string; title: string; body: string }> = [];

    // 1. Expiry alerts — batch lots ACTIVE and expiring within 30 days (or already expired)
    const thirtyDays = new Date();
    thirtyDays.setDate(thirtyDays.getDate() + 30);
    const expiring = await prisma.batchLot.findMany({
      where: { status: "ACTIVE", expiryDate: { lte: thirtyDays } },
      include: { material: { select: { name: true, sku: true } } },
      orderBy: { expiryDate: "asc" },
    });
    for (const b of expiring.slice(0, 20)) {
      const days = b.expiryDate
        ? Math.ceil((b.expiryDate.getTime() - Date.now()) / 86400000)
        : 0;
      alerts.push({
        type: "EXPIRY",
        title: `Batch ${b.batchNumber} expiring${days < 0 ? " (expired)" : ` in ${days} days`}`,
        body: `${b.material.name} (${b.material.sku}) — expiry ${b.expiryDate?.toISOString().slice(0, 10)}`,
      });
    }

    // 2. Low stock — derived stock <= 0 for any material with ledger activity
    const stock = await getStock(prisma);
    const depleted = stock.filter((s) => Number(s.quantity) <= 0);
    for (const s of depleted.slice(0, 20)) {
      alerts.push({
        type: "LOW_STOCK",
        title: `${s.materialName} is out of stock`,
        body: `${s.sku} · ${s.warehouseName} · on hand ${Number(s.quantity)} ${s.unitOfMeasure}`,
      });
    }

    // 3. Pending approvals
    const [pendingReqs, pendingInspections] = await Promise.all([
      prisma.requisition.count({ where: { status: "PENDING_APPROVAL" } }),
      prisma.inspectionRecord.count({ where: { result: "PENDING" } }),
    ]);
    if (pendingReqs > 0) {
      alerts.push({
        type: "APPROVAL",
        title: `${pendingReqs} requisition(s) awaiting approval`,
        body: "Review and approve pending purchase requisitions in the Procurement module.",
      });
    }
    if (pendingInspections > 0) {
      alerts.push({
        type: "APPROVAL",
        title: `${pendingInspections} batch(es) awaiting QA inspection`,
        body: "Release or reject quarantined batches in the QA Inspections module.",
      });
    }

    // 4. Persist — dedupe against existing unread notifications
    const users = await prisma.user.findMany({ select: { id: true, role: true } });
    let created = 0;
    for (const user of users) {
      for (const alert of alerts) {
        const exists = await prisma.notification.findFirst({
          where: { userId: user.id, type: alert.type, title: alert.title, isRead: false },
        });
        if (exists) continue;
        await prisma.notification.create({
          data: { userId: user.id, type: alert.type, title: alert.title, body: alert.body },
        });
        created++;
      }
    }

    res.json({ ok: true, created, alertsScanned: alerts.length });
  } catch (error: any) {
    console.error("POST /notifications/generate error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});

/**
 * GET /notifications — current user's notifications + unread count.
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: req.user!.id },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      prisma.notification.count({ where: { userId: req.user!.id, isRead: false } }),
    ]);
    res.json({ notifications, unreadCount });
  } catch (error) {
    console.error("GET /notifications error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * POST /notifications/:id/read — mark a single notification as read.
 */
router.post("/:id/read", async (req: Request, res: Response) => {
  try {
    const notification = await prisma.notification.updateMany({
      where: { id: req.params.id, userId: req.user!.id },
      data: { isRead: true },
    });
    res.json({ ok: true, updated: notification.count });
  } catch (error) {
    console.error("POST /notifications/:id/read error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * POST /notifications/read-all — mark all of the current user's notifications as read.
 */
router.post("/read-all", async (req: Request, res: Response) => {
  try {
    const result = await prisma.notification.updateMany({
      where: { userId: req.user!.id, isRead: false },
      data: { isRead: true },
    });
    res.json({ ok: true, updated: result.count });
  } catch (error) {
    console.error("POST /notifications/read-all error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
