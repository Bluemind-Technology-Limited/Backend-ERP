import { Router, type Request, type Response } from "express";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { prisma } from "../lib/db.js";
import { logActivity } from "../services/userActivityLogger.js";

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
 * PUT /auth/users/:id — update a user (admin only).
 * Can update firstName, lastName, and role. Email cannot be changed.
 */
router.put("/users/:id", requireAuth, requirePermission("admin", "update"), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { firstName, lastName, role } = req.body as {
      firstName?: string;
      lastName?: string;
      role?: string;
    };

    if (!firstName || !lastName) {
      return res.status(400).json({ error: "firstName and lastName are required" });
    }

    const fullName = `${firstName} ${lastName}`.trim();

    const profile = await prisma.user.update({
      where: { id },
      data: {
        fullName,
        role: role as never,
      },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
    });

    res.json({ user: profile });
  } catch (error: any) {
    console.error("PUT /auth/users/:id error:", error);
    if (error.code === "P2025") {
      return res.status(404).json({ error: "User not found" });
    }
    res.status(500).json({ error: error?.message || "Database error" });
  }
});

/**
 * DELETE /auth/users/:id — delete a user (admin only).
 * Removes from Supabase Auth and app database.
 */
router.delete("/users/:id", requireAuth, requirePermission("admin", "delete"), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
      return res.status(500).json({ error: "Supabase admin credentials not configured" });
    }

    // 1. Delete from Supabase Auth (service-role)
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: deleteAuthErr } = await admin.auth.admin.deleteUser(id);
    if (deleteAuthErr) {
      console.warn("Warning: failed to delete Supabase Auth user:", deleteAuthErr.message);
      // Continue to delete from Prisma anyway
    }

    // 2. Delete from app database
    await prisma.user.delete({
      where: { id },
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error("DELETE /auth/users/:id error:", error);
    if (error.code === "P2025") {
      return res.status(404).json({ error: "User not found" });
    }
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
        hasSeenTour: true,
        createdAt: true,
      },
    });
    res.json({ profile });
  } catch (error) {
    console.error("GET /auth/profile error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * PATCH /auth/profile — update current user profile.
 * Only the fields a user owns are editable: display name, phone, tour flag.
 * Email/role stay under admin control (PUT /auth/users/:id).
 */
router.patch("/profile", requireAuth, async (req: Request, res: Response) => {
  try {
    const { fullName, phoneNumber, hasSeenTour } = req.body ?? {};

    if (fullName !== undefined) {
      if (typeof fullName !== "string" || !fullName.trim()) {
        return res.status(400).json({ error: "Full name cannot be empty" });
      }
      if (fullName.trim().length > 120) {
        return res.status(400).json({ error: "Full name is too long (max 120 characters)" });
      }
    }
    if (phoneNumber !== undefined && phoneNumber !== null) {
      if (typeof phoneNumber !== "string") {
        return res.status(400).json({ error: "Phone number must be text" });
      }
      if (phoneNumber.trim().length > 32) {
        return res.status(400).json({ error: "Phone number is too long" });
      }
    }

    const profile = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        ...(fullName !== undefined ? { fullName: fullName.trim() } : {}),
        ...(phoneNumber !== undefined ? { phoneNumber: phoneNumber?.trim() || null } : {}),
        ...(hasSeenTour !== undefined ? { hasSeenTour } : {}),
      },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        role: true,
        phoneNumber: true,
        isActive: true,
        hasSeenTour: true,
        createdAt: true,
      },
    });

    res.json({ profile });
  } catch (error) {
    console.error("PATCH /auth/profile error:", error);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * POST /auth/change-password — change the signed-in user's own password.
 *
 * The current password is verified against Supabase's password grant before
 * the service-role client applies the change, so knowing the temporary or
 * existing password is required.
 */
router.post("/change-password", requireAuth, async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};

    if (typeof currentPassword !== "string" || !currentPassword) {
      return res.status(400).json({ error: "Enter your current password" });
    }
    if (typeof newPassword !== "string" || newPassword.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }
    if (newPassword.length > 72) {
      return res.status(400).json({ error: "New password is too long (max 72 characters)" });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: "New password must be different from the current one" });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return res.status(503).json({ error: "Password changes are not configured on this server" });
    }

    const verified = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email: req.user!.email, password: currentPassword }),
    });
    if (!verified.ok) {
      return res.status(400).json({ error: "Current password is incorrect" });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error } = await admin.auth.admin.updateUserById(req.user!.id, { password: newPassword });
    if (error) {
      return res.status(400).json({ error: error.message });
    }

    await logActivity({
      userId: req.user!.id,
      activityType: "UPDATE",
      module: "admin",
      description: "Changed their account password",
      entityType: "User",
      entityId: req.user!.id,
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error("POST /auth/change-password error:", error);
    res.status(500).json({ error: error?.message || "Could not change the password" });
  }
});

export default router;
