import { Resend } from "resend";
import { prisma } from "../lib/db.js";
import { getStock } from "../lib/ledger.js";
import { generateStockEmailHTML, type StockItem } from "./email-templates.js";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendDailyStockEmail() {
  try {
    console.log("→ Starting daily stock email service...");

    // 1. Fetch all active users (excluding super admin, get team members)
    const users = await prisma.user.findMany({
      where: {
        isActive: true,
        role: {
          in: [
            "STORE_OFFICER",
            "PRODUCTION_MANAGER",
            "PROCUREMENT_OFFICER",
            "EXECUTIVE_ADMIN",
            "QA_INSPECTOR",
          ],
        },
      },
      select: { id: true, email: true, fullName: true },
    });

    if (users.length === 0) {
      console.warn("No active users found to send stock email to");
      return {
        success: false,
        emailsSent: 0,
        alerts: 0,
        message: "No active users found",
      };
    }

    console.log(`  Users to notify: ${users.length}`);

    // 2. Get current stock levels
    const stock = await getStock(prisma);

    // 3. Fetch all materials with minimum quantities
    const materials = await prisma.material.findMany({
      where: { status: "ACTIVE" },
      select: {
        id: true,
        name: true,
        sku: true,
        unitOfMeasure: true,
        minQuantity: true,
      },
    });

    // 4. Aggregate stock by material and identify alerts
    const stockByMaterial = new Map<
      string,
      { quantity: number; materialName: string; sku: string; unitOfMeasure: string; minimumQuantity: number }
    >();

    for (const s of stock) {
      const existing = stockByMaterial.get(s.materialId) ?? {
        quantity: 0,
        materialName: s.materialName,
        sku: s.sku,
        unitOfMeasure: s.unitOfMeasure,
        minimumQuantity: 0,
      };
      existing.quantity += Number(s.quantity);
      stockByMaterial.set(s.materialId, existing);
    }

    // Update minimums from materials table
    for (const mat of materials) {
      const existing = stockByMaterial.get(mat.id);
      if (existing) {
        existing.minimumQuantity = Number(mat.minQuantity || 0);
      } else {
        stockByMaterial.set(mat.id, {
          quantity: 0,
          materialName: mat.name,
          sku: mat.sku,
          unitOfMeasure: mat.unitOfMeasure,
          minimumQuantity: Number(mat.minQuantity || 0),
        });
      }
    }

    // 5. Build report items
    const allItems: StockItem[] = [];
    const alertItems: StockItem[] = [];

    for (const [materialId, data] of stockByMaterial.entries()) {
      const item: StockItem = {
        materialId,
        materialName: data.materialName,
        sku: data.sku,
        quantity: data.quantity,
        minimumQuantity: data.minimumQuantity,
        unitOfMeasure: data.unitOfMeasure,
        isAlert: data.quantity < data.minimumQuantity,
      };

      allItems.push(item);
      if (item.isAlert) {
        alertItems.push(item);
      }
    }

    // Sort by alert status, then by shortage amount
    allItems.sort((a, b) => {
      if (a.isAlert !== b.isAlert) return a.isAlert ? -1 : 1;
      if (a.isAlert) {
        const shortageA = a.minimumQuantity - a.quantity;
        const shortageB = b.minimumQuantity - b.quantity;
        return shortageB - shortageA;
      }
      return 0;
    });

    alertItems.sort((a, b) => (b.minimumQuantity - b.quantity) - (a.minimumQuantity - a.quantity));

    console.log(`  Total materials: ${allItems.length}, Alerts: ${alertItems.length}`);

    // 6. Generate HTML email
    const emailHTML = generateStockEmailHTML(allItems, alertItems);

    // 7. Send email to all users
    const emailPromises = users.map((user) =>
      resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || "noreply@kibgroup.com",
        to: user.email,
        subject: `Daily Stock Report - ${alertItems.length} Alert(s) 📦`,
        html: emailHTML,
        replyTo: "inventory@kibgroup.com",
      })
    );

    const results = await Promise.allSettled(emailPromises);

    // Count successes and failures
    const successCount = results.filter((r) => r.status === "fulfilled").length;
    const failureCount = results.filter((r) => r.status === "rejected").length;

    if (failureCount > 0) {
      console.error(`Email send failures: ${failureCount}/${results.length}`);
      results.forEach((result, idx) => {
        if (result.status === "rejected") {
          console.error(`  User ${users[idx].email}: ${result.reason}`);
        }
      });
    }

    console.log(`✓ Stock email sent to ${successCount}/${users.length} users`);
    console.log(`  Alerts: ${alertItems.length}, Normal: ${allItems.length - alertItems.length}`);

    return {
      success: successCount > 0,
      emailsSent: successCount,
      totalUsers: users.length,
      alerts: alertItems.length,
      materials: allItems.length,
      timestamp: new Date().toISOString(),
    };
  } catch (error: any) {
    console.error("Stock email service error:", error);
    throw error;
  }
}
