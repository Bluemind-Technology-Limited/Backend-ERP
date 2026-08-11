import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../lib/db.js";
import { generateNotifications } from "../services/notifications.js";

const router: Router = Router();
router.use(requireAuth);

/**
 * POST /notifications/generate — scans for alerts (expiry, low stock, pending
 * approvals) and inserts Notification rows for the affected roles.
 * Deduped by (userId, type, title) among unread notifications.
 */
router.post("/generate", async (req: Request, res: Response) => {
  try {
    const result = await generateNotifications();
    res.json({ ok: true, created: result.created, alertsScanned: result.alertsCount });
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
