import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/db";
import { verifySupabaseToken } from "../lib/verifyToken";

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
    const user = await prisma.user.findUnique({ where: { id: supabaseUserId } });
    if (!user || !user.isActive) {
      return res.status(403).json({ error: "Forbidden: User not found or inactive" });
    }

    req.user = user;
    req.tokenClaims = decoded as unknown as Record<string, unknown>;
    next();
  } catch (error) {
    console.error("requireAuth db error:", error);
    return res.status(500).json({ error: "Database error" });
  }
}
