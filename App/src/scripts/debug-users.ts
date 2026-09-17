/**
 * Debug script to list all users and their IDs
 * Run with: pnpm tsx src/scripts/debug-users.ts
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { prisma } from "../lib/db.js";

async function main() {
  console.log("\n📊 Debugging User IDs\n");
  console.log("=" .repeat(80));

  // Get Supabase Auth users
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log("\n🔐 SUPABASE AUTH USERS:");
  const { data: authUsers } = await admin.auth.admin.listUsers();
  authUsers?.users.forEach((u) => {
    console.log(`  ID: ${u.id}`);
    console.log(`  Email: ${u.email}`);
    console.log(`  Created: ${u.created_at}`);
    console.log("");
  });

  // Get Prisma app users
  console.log("\n💾 DATABASE APP USERS (prisma.user):");
  const dbUsers = await prisma.user.findMany({
    select: { id: true, email: true, fullName: true, role: true, isActive: true },
  });
  dbUsers.forEach((u) => {
    console.log(`  ID: ${u.id}`);
    console.log(`  Email: ${u.email}`);
    console.log(`  Name: ${u.fullName}`);
    console.log(`  Role: ${u.role}`);
    console.log(`  Active: ${u.isActive}`);
    console.log("");
  });

  // Check for mismatches
  console.log("\n⚠️  ID MISMATCHES:");
  const authIds = new Set(authUsers?.users.map((u) => u.id) || []);
  const dbIds = new Set(dbUsers.map((u) => u.id));

  const inAuthNotDb = [...authIds].filter((id) => !dbIds.has(id));
  const inDbNotAuth = [...dbIds].filter((id) => !authIds.has(id));

  if (inAuthNotDb.length > 0) {
    console.log(`\n❌ In Supabase Auth but NOT in Database (${inAuthNotDb.length}):`);
    inAuthNotDb.forEach((id) => {
      const user = authUsers?.users.find((u) => u.id === id);
      console.log(`   - ${user?.email} (${id})`);
    });
  }

  if (inDbNotAuth.length > 0) {
    console.log(`\n❌ In Database but NOT in Supabase Auth (${inDbNotAuth.length}):`);
    inDbNotAuth.forEach((id) => {
      const user = dbUsers.find((u) => u.id === id);
      console.log(`   - ${user?.email} (${id})`);
    });
  }

  if (inAuthNotDb.length === 0 && inDbNotAuth.length === 0) {
    console.log("\n✅ All IDs match! Sync is correct.");
  }

  console.log("\n" + "=".repeat(80) + "\n");

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
