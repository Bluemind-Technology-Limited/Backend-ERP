import { Router, type Request, type Response } from "express";
import { qstashClient } from "../lib/qstash.js";
import { prisma } from "../lib/db.js";
import { getStock } from "../lib/ledger.js";
import { generateStockEmailHTML } from "../services/email-templates.js";
import crypto from "crypto";

const router: Router = Router();

/**
 * GET /api/stock-email/preview
 * Preview the daily stock email in the browser (for testing/design review).
 * Shows a sample email with mock data.
 */
router.get("/preview", async (req: Request, res: Response) => {
  try {
    // Get actual stock data for realistic preview
    const stock = await getStock(prisma);
    const materials = await prisma.material.findMany({
      where: { status: "ACTIVE" },
      select: {
        id: true,
        name: true,
        sku: true,
        unitOfMeasure: true,
        minQuantity: true,
      },
      take: 20, // Limit to 20 for preview
    });

    // Aggregate stock by material
    const stockByMaterial = new Map<
      string,
      {
        quantity: number;
        materialName: string;
        sku: string;
        unitOfMeasure: string;
        minimumQuantity: number;
      }
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

    // Update minimums
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

    // Build items
    const allItems = [];
    const alertItems = [];

    for (const [materialId, data] of stockByMaterial.entries()) {
      const item = {
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

    // Sort
    allItems.sort((a, b) => {
      if (a.isAlert !== b.isAlert) return a.isAlert ? -1 : 1;
      if (a.isAlert) {
        const shortageA = a.minimumQuantity - a.quantity;
        const shortageB = b.minimumQuantity - b.quantity;
        return shortageB - shortageA;
      }
      return 0;
    });

    alertItems.sort(
      (a, b) => (b.minimumQuantity - b.quantity) - (a.minimumQuantity - a.quantity)
    );

    // Generate HTML
    const html = generateStockEmailHTML(allItems, alertItems);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (error: any) {
    console.error("Stock email preview error:", error);
    res.status(500).json({ error: error?.message || "Failed to generate preview" });
  }
});

/**
 * POST /api/stock-email/trigger
 * GitHub Workflow endpoint that triggers the daily stock email.
 * Validates GitHub webhook signature and queues the email job on QStash.
 */
router.post("/trigger", async (req: Request, res: Response) => {
  try {
    // Validate GitHub webhook signature (optional but recommended)
    const signature = req.headers["x-hub-signature-256"] as string;
    const githubSecret = process.env.GITHUB_WEBHOOK_SECRET;

    if (githubSecret && signature) {
      const hmac = crypto.createHmac("sha256", githubSecret);
      const digest = "sha256=" + hmac.update(JSON.stringify(req.body)).digest("hex");

      if (signature !== digest) {
        return res.status(401).json({ error: "Invalid GitHub webhook signature" });
      }
    }

    console.log("→ Stock email trigger received from GitHub Workflow");

    // Queue the email job on QStash with retry policy
    const jobId = await qstashClient.publishJSON({
      api: {
        name: "stock-email",
        baseUrl: process.env.API_BASE_URL || "http://localhost:3002",
      },
      topic: "stock-email",
      body: {
        timestamp: new Date().toISOString(),
        source: "github-workflow",
      },
      retries: 3,
      delay: "0s", // Process immediately
    });

    res.json({
      success: true,
      message: "Stock email job queued successfully",
      jobId,
      scheduledTime: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Stock email trigger error:", error);
    res.status(500).json({ error: error?.message || "Failed to queue stock email job" });
  }
});

export default router;
