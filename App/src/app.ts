import "dotenv/config";
import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import { prisma } from "./lib/db.js";
import apiRouter from "./routes/index.js";

/**
 * Express app — created here (without app.listen) so the same instance can be
 * used both by the local dev server (src/index.ts) and by Vercel's serverless
 * runtime (api/index.ts).
 */
export const app: Express = express();

// Middleware
app.use(cors());
app.use(express.json());

// Basic root check
app.get("/", (req: Request, res: Response) => {
  res.json({
    status: "ok",
    message: "KIB Group Backend API Server is running!"
  });
});

// Health check — includes DB connectivity probe
app.get("/health", async (_req: Request, res: Response) => {
  let dbStatus = "down";
  try {
    if (prisma) {
      await prisma.$queryRaw`SELECT 1`;
      dbStatus = "up";
    }
  } catch (err) {
    dbStatus = "down";
    console.error("Healthcheck DB connectivity error:", err);
  }
  res.json({ status: "ok", db: dbStatus, timestamp: new Date().toISOString() });
});

// API routes
app.use("/api", apiRouter);
