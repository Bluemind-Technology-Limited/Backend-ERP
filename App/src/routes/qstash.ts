import { Router } from "express";
import { requireQStashSignature } from "../middleware/qstash.js";
import { generateNotifications } from "../services/notifications.js";

const router: Router = Router();

/**
 * POST /api/qstash/notifications-cron
 * Endpoint triggered periodically by QStash to generate alerts/notifications.
 * Protected by Upstash signature verification.
 */
router.post("/notifications-cron", requireQStashSignature, async (req, res) => {
  try {
    const result = await generateNotifications();
    res.json({
      success: true,
      message: "Notifications generated successfully via QStash cron job",
      created: result.created,
      alertsScanned: result.alertsCount,
    });
  } catch (error: any) {
    console.error("QStash notifications-cron error:", error);
    res.status(500).json({ error: error?.message || "Internal server error" });
  }
});

export default router;
