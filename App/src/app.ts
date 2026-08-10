import "dotenv/config";
import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import { prisma } from "./lib/db";
import apiRouter from "./routes";

/**
 * Express app — created here (without app.listen) so the same instance can be
 * used both by the local dev server (src/index.ts) and by Vercel's serverless
 * runtime (api/index.ts).
 */
export const app: Express = express();

// Middleware
app.use(cors());
app.use(express.json());

// Health check — includes DB connectivity probe
app.get("/health", async (_req: Request, res: Response) => {
  let dbStatus = "down";
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbStatus = "up";
  } catch {
    dbStatus = "down";
  }
  res.json({ status: "ok", db: dbStatus, timestamp: new Date().toISOString() });
});

// API routes
app.use("/api", apiRouter);
