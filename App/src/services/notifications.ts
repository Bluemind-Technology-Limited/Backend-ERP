import { prisma } from "../lib/db.js";
import { getStock } from "../lib/ledger.js";

/**
 * Scan for expiry dates, low stock, and pending approvals,
 * and create corresponding notifications for active users.
 */
export async function generateNotifications() {
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

  return { created, alertsCount: alerts.length };
}

/**
 * Check all materials against minimum quantities.
 * Create LOW_STOCK_ALERT notifications when stock falls below minQuantity.
 * Called daily via QStash scheduler.
 */
export async function checkMinimumQuantities() {
  try {
    const stock = await getStock(prisma);
    
    // Filter materials below minimum quantity
    const lowStockMaterials = stock.filter(item => 
      item.minQuantity && item.quantity < item.minQuantity
    );

    if (lowStockMaterials.length === 0) {
      console.log("✓ No low-stock materials detected");
      return { alertCount: 0, materialsChecked: stock.length, status: "success" };
    }

    // Get all active users
    const activeUsers = await prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, email: true, fullName: true },
    });

    // Create notification for each user per low-stock material
    const notificationsCreated: string[] = [];
    const now = new Date();

    for (const material of lowStockMaterials) {
      for (const user of activeUsers) {
        // Check if notification already exists for today (avoid duplicates)
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const tomorrowStart = new Date(todayStart);
        tomorrowStart.setDate(tomorrowStart.getDate() + 1);

        const existingNotification = await prisma.notification.findFirst({
          where: {
            userId: user.id,
            referenceId: material.materialId,
            notificationType: "LOW_STOCK_ALERT",
            createdAt: {
              gte: todayStart,
              lt: tomorrowStart,
            },
          },
        });

        if (existingNotification) {
          console.log(`→ Alert exists for ${user.email} / ${material.materialName}`);
          continue;
        }

        const variance = Number(material.minQuantity!) - material.quantity;
        const notification = await prisma.notification.create({
          data: {
            userId: user.id,
            title: `Low Stock Alert: ${material.materialName}`,
            body: `${material.materialName} (${material.sku}) is at ${material.quantity} ${material.unitOfMeasure} — below minimum of ${material.minQuantity} ${material.unitOfMeasure}. Variance: -${variance} ${material.unitOfMeasure}`,
            type: "LOW_STOCK",
            notificationType: "LOW_STOCK_ALERT",
            referenceId: material.materialId,
            isActionable: true,
            isRead: false,
          },
        });

        notificationsCreated.push(notification.id);
        console.log(`✓ Created LOW_STOCK_ALERT for ${user.fullName} — ${material.materialName}`);
      }
    }

    console.log(`✓ Minimum quantity check complete: ${notificationsCreated.length} alerts created`);
    return {
      alertCount: notificationsCreated.length,
      materialCount: lowStockMaterials.length,
      userCount: activeUsers.length,
      status: "success",
    };
  } catch (error) {
    console.error("❌ checkMinimumQuantities error:", error);
    throw error;
  }
}

/**
 * Generate daily stock digest email data.
 * Returns all low-stock alerts for the day grouped by user.
 */
export async function generateDailyDigest() {
  try {
    const stock = await getStock(prisma);

    // Filter materials below minimum
    const lowStockMaterials = stock.filter(item =>
      item.minQuantity && item.quantity < item.minQuantity
    );

    const activeUsers = await prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, email: true, fullName: true },
    });

    // Group low-stock items by user for email digest
    const digestByUser = new Map<
      string,
      {
        email: string;
        fullName: string;
        alerts: Array<{
          materialName: string;
          sku: string;
          currentQty: number;
          minQty: number;
          variance: number;
          unit: string;
          warehouse: string;
        }>;
      }
    >();

    for (const user of activeUsers) {
      digestByUser.set(user.id, {
        email: user.email,
        fullName: user.fullName,
        alerts: [],
      });
    }

    for (const material of lowStockMaterials) {
      const variance = Number(material.minQuantity!) - material.quantity;
      for (const user of activeUsers) {
        const userDigest = digestByUser.get(user.id)!;
        userDigest.alerts.push({
          materialName: material.materialName,
          sku: material.sku,
          currentQty: material.quantity,
          minQty: Number(material.minQuantity!),
          variance,
          unit: material.unitOfMeasure,
          warehouse: material.warehouseName,
        });
      }
    }

    console.log(`✓ Daily digest generated for ${digestByUser.size} users`);
    return Object.fromEntries(digestByUser);
  } catch (error) {
    console.error("❌ generateDailyDigest error:", error);
    throw error;
  }
}
