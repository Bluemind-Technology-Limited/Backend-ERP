import "dotenv/config";
import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

let prismaInstance: PrismaClient;

if (process.env.DATABASE_URL) {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  prismaInstance = new PrismaClient({ adapter });
} else {
  // Graceful fallback for build-time or configurations where DATABASE_URL is missing
  prismaInstance = new PrismaClient({} as any);
}

export const prisma = prismaInstance;

