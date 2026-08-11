import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

import pg from "pg";

let prismaInstance: PrismaClient;

if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2, // Limit pool size per serverless function instance
  });
  const adapter = new PrismaPg(pool);
  prismaInstance = new PrismaClient({ adapter });
} else {
  // Graceful fallback for build-time or configurations where DATABASE_URL is missing
  prismaInstance = new PrismaClient({} as any);
}

export const prisma = prismaInstance;

