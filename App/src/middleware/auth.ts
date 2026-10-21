import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/db.js";
import { verifySupabaseToken } from "../lib/verifyToken.js";

/**
 * Loads the app user for a verified token.
 *
 * Supabase's pooler can briefly drop connections / fail DNS while waking up,
 * so retry transient connectivity errors a couple of times before surfacing
 * a database error.
 */
const TRANSIENT_DB_CODES = new Set(["P1001", "P1002", "P2010", "P2024"]);

async function findUserById(userId: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await prisma.user.findUnique({ where: { id: userId } });
    } catch (error: any) {
      lastError = error;
      const transient = TRANSIENT_DB_CODES.has(error?.code);
      if (!transient || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

/**
 * Verifies the Supabase-issued JWT offline (ES256 via JWKS, or HS256 via
 * project JWT secret), then loads the matching application user (keyed 1:1 on
 * `auth.users` id / `sub`).
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: Missing token" });
  }

  const token = authHeader.split(" ")[1];

  let decoded;
  try {
    decoded = await verifySupabaseToken(token);
  } catch {
    return res.status(403).json({ error: "Forbidden: Invalid token" });
  }

  const supabaseUserId = decoded.sub;
  if (!supabaseUserId) {
    return res.status(403).json({ error: "Forbidden: Token has no subject" });
  }

  try {
    const user = await findUserById(supabaseUserId);
    if (!user || !user.isActive) {
      return res.status(403).json({ error: "Forbidden: User not found or inactive" });
    }

    req.user = user;
    req.tokenClaims = decoded as unknown as Record<string, unknown>;
    next();
  } catch (error: any) {
    console.error(
      "requireAuth db error:",
      error?.cause?.code ?? error?.code ?? error?.name,
      error?.message
    );
    return res.status(503).json({ error: "Database temporarily unavailable" });
  }
}
