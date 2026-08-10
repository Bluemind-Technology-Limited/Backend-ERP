import type { NextFunction, Request, Response } from "express";
import type { UserRole } from "../generated/prisma/client";
import { prisma } from "../lib/db";

/**
 * Restricts a route to one of the given app roles.
 * MUST run after `requireAuth` (which populates req.user with the Prisma user).
 */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized: Not authenticated" });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden: Insufficient role" });
    }
    next();
  };
}

/**
 * Restricts a route to users holding a given permission in a module.
 * Reads the app-level `RolePermission` matrix (separation of duties).
 * MUST run after `requireAuth`.
 */
export function requirePermission(module: string, action: "create" | "read" | "update" | "delete" | "approve") {
  const fieldMap = {
    create: "canCreate",
    read: "canRead",
    update: "canUpdate",
    delete: "canDelete",
    approve: "canApprove",
  } as const;

  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized: Not authenticated" });
    }
    try {
      const permission = await prisma.rolePermission.findUnique({
        where: { role_module: { role: req.user.role, module } },
      });
      const allowed = permission?.[fieldMap[action]] ?? false;
      if (!allowed) {
        return res.status(403).json({ error: `Forbidden: Missing ${action} permission on ${module}` });
      }
      next();
    } catch (error) {
      console.error("requirePermission db error:", error);
      return res.status(500).json({ error: "Database error" });
    }
  };
}
