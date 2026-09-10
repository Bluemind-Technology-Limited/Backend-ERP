import { Router } from "express";
import { requireQStashSignature } from "../middleware/qstash.js";
import { generateNotifications, checkMinimumQuantities } from "../services/notifications.js";
import { sendDailyStockEmail } from "../services/stock-email-service.js";

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

/**
 * POST /api/qstash/check-minimums
 * Daily trigger to check all materials against minimum quantities.
 * Creates LOW_STOCK_ALERT notifications for materials below minimum.
 * Protected by Upstash signature verification.
 */
router.post("/check-minimums", requireQStashSignature, async (req, res) => {
  try {
    console.log("→ QStash triggered minimum quantity check");
    const result = await checkMinimumQuantities();
    res.json({
      success: true,
      message: "Minimum quantity check completed successfully",
      alertCount: result.alertCount,
      materialCount: result.materialCount,
      userCount: result.userCount,
      status: result.status,
    });
  } catch (error: any) {
    console.error("QStash check-minimums error:", error);
    res.status(500).json({ error: error?.message || "Internal server error" });
  }
});

/**
 * POST /api/qstash/stock-email
 * Sends daily stock level report to all team members with alerts.
 * Triggered by GitHub Workflow at 5 AM UTC via QStash.
 * Protected by Upstash signature verification.
 */
router.post("/stock-email", requireQStashSignature, async (req, res) => {
  try {
    console.log("→ QStash triggered daily stock email");
    const result = await sendDailyStockEmail();
    res.json({
      success: result.success,
      message: "Stock email sent successfully",
      emailsSent: result.emailsSent,
      totalUsers: result.totalUsers,
      alerts: result.alerts,
      materials: result.materials,
      timestamp: result.timestamp,
    });
  } catch (error: any) {
    console.error("QStash stock-email error:", error);
    res.status(500).json({ error: error?.message || "Internal server error" });
  }
});

export default router;
