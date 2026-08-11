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
