import "dotenv/config";
import dns from "node:dns";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg, { type Pool } from "pg";

// Prefer IPv4 when the resolver returns both families; the Supabase pooler is
// reachable over IPv4 and some networks fail slowly on IPv6 first.
dns.setDefaultResultOrder("ipv4first");

/**
 * Prisma client backed by a `pg` pool.
 *
 * The pool is cached on `globalThis` outside production so `tsx watch`
 * restarts don't leak connections to the Supabase pooler. Connection timeouts
 * and keepalive make transient pooler drops fail fast and recover instead of
 * hanging a request indefinitely.
 */

type PrismaGlobal = {
  prisma?: PrismaClient;
  pgPool?: Pool;
};

const globalForPrisma = globalThis as unknown as PrismaGlobal;

let prismaInstance: PrismaClient;

if (process.env.DATABASE_URL) {
  const pool =
    globalForPrisma.pgPool ??
    new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 2, // Limit pool size per serverless function instance
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 300_000, // keep pooled connections alive; avoids repeated flaky DNS lookups
      keepAlive: true,
    });

  // Without a handler, an idle client error can crash the process.
  pool.on("error", (error) => {
    console.error("Unexpected pg pool error:", error);
  });

  const adapter = new PrismaPg(pool);
  prismaInstance =
    globalForPrisma.prisma ??
    new PrismaClient({
      adapter,
      // Multi-step writes (a receipt creates lots, ledger rows and QA records)
      // take several round-trips; the Supabase pooler can be slow enough to
      // blow through Prisma's 5s interactive-transaction default.
      transactionOptions: { maxWait: 15_000, timeout: 60_000 },
    });

  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.pgPool = pool;
  }
} else {
  // Graceful fallback for build-time or configurations where DATABASE_URL is missing
  prismaInstance = globalForPrisma.prisma ?? new PrismaClient({} as any);
}

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prismaInstance;
}

export const prisma = prismaInstance;
