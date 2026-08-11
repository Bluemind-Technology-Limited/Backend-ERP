import { Router, type Request, type Response } from "express";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { prisma } from "../lib/db.js";

const router: Router = Router();

/**
 * GET /auth/me — returns the authenticated user (from JWT via requireAuth).
 */
router.get("/me", requireAuth, (req: Request, res: Response) => {
  // req.user was loaded by requireAuth
  res.json({ user: req.user });
});

/**
 * GET /auth/users — list all application users (admin only).
 */
router.get("/users", requireAuth, requirePermission("admin", "read"), async (req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ users });
  } catch (error) {
    console.error("GET /auth/users error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * POST /auth/users — create a Supabase Auth user AND the matching app profile
 * (admin only). Returns the generated temporary password once.
 */
router.post("/users", requireAuth, requirePermission("admin", "create"), async (req: Request, res: Response) => {
  try {
    const { firstName, lastName, email, role } = req.body as {
      firstName?: string;
      lastName?: string;
      email?: string;
      role?: string;
    };
    if (!firstName || !lastName || !email || !role) {
      return res.status(400).json({ error: "firstName, lastName, email and role are required" });
    }
    const fullName = `${firstName} ${lastName}`.trim();

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
      return res.status(500).json({ error: "Supabase admin credentials not configured" });
    }

    // 1. Generate a temporary password (KIB-XXXXXX)
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let tempPass = "KIB-";
    for (let i = 0; i < 6; i++) tempPass += chars[Math.floor(Math.random() * chars.length)];

    // 2. Create the Supabase Auth user (service-role)
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password: tempPass,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (createErr) {
      return res.status(400).json({ error: createErr.message });
    }

    // 3. Insert the app profile, keyed on the Auth user id (`sub`)
    const profile = await prisma.user.create({
      data: {
        id: created.user.id,
        email,
        username: email.split("@")[0],
        passwordHash: "managed-by-supabase-auth",
        fullName,
        role: role as never,
      },
      select: { id: true, email: true, username: true, fullName: true, role: true, isActive: true, createdAt: true },
    });

    res.status(201).json({ user: profile, tempPass });
  } catch (error: any) {
    console.error("POST /auth/users error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});

/**
 * GET /auth/profile — demonstrates the guide pattern:
 * req.user.id IS the Supabase Auth user id (`sub`), so we can query 1:1.
 */
router.get("/profile", requireAuth, async (req: Request, res: Response) => {
  try {
    const profile = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        role: true,
        phoneNumber: true,
        isActive: true,
        createdAt: true,
      },
    });
    res.json({ profile });
  } catch (error) {
    console.error("GET /auth/profile error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
