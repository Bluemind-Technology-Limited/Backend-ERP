/**
 * Seed demo users: creates Supabase Auth accounts AND the matching app profile
 * (Prisma `users` row keyed 1:1 on the Supabase Auth user id).
 *
 * Run with: pnpm tsx src/scripts/seed-demo-users.ts
 * Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL in .env
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { prisma } from "../lib/db.js";

const DEMO_USERS = [
  { email: "admin@kib.group", password: "demopass123", fullName: "Alex Johnson", role: "SUPER_ADMIN" },
  { email: "executive@kib.group", password: "demopass123", fullName: "Executive Admin", role: "EXECUTIVE_ADMIN" },
  { email: "store@kib.group", password: "demopass123", fullName: "Store Officer", role: "STORE_OFFICER" },
  { email: "production@kib.group", password: "demopass123", fullName: "Sarah Connor", role: "PRODUCTION_MANAGER" },
  { email: "procurement@kib.group", password: "demopass123", fullName: "Procurement Officer", role: "PROCUREMENT_OFFICER" },
  { email: "qa@kib.group", password: "demopass123", fullName: "QA Inspector", role: "QA_INSPECTOR" },
] as const;

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env");
  }
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  for (const demo of DEMO_USERS) {
    // 1. Create (or fetch) the Supabase Auth user
    let supabaseId: string;
    const { data: existing, error: lookupErr } = await admin.auth.admin.listUsers();
    if (lookupErr) throw lookupErr;
    const found = existing.users.find((u) => u.email === demo.email);
    if (found) {
      supabaseId = found.id;
    } else {
      const { data: created, error } = await admin.auth.admin.createUser({
        email: demo.email,
        password: demo.password,
        email_confirm: true,
        user_metadata: { full_name: demo.fullName },
      });
      if (error) throw error;
      supabaseId = created.user.id;
    }

    // 2. Upsert the app profile in Prisma, keyed on the same id (the JWT `sub`)
    await prisma.user.upsert({
      where: { id: supabaseId },
      update: { fullName: demo.fullName, role: demo.role },
      create: {
        id: supabaseId,
        email: demo.email,
        username: demo.email.split("@")[0],
        passwordHash: "managed-by-supabase-auth",
        fullName: demo.fullName,
        role: demo.role,
      },
    });
    console.log(`Seeded ${demo.email} (${demo.role})`);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log("Done.");
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
