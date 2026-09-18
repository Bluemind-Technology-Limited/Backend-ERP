/**
 * Add a Supabase Auth user to the database
 * Run with: pnpm tsx src/scripts/add-user.ts YOUR_EMAIL YOUR_FULL_NAME YOUR_ROLE
 *
 * Example: pnpm tsx src/scripts/add-user.ts myemail@example.com "John Doe" SUPER_ADMIN
 * Roles: SUPER_ADMIN, EXECUTIVE_ADMIN, STORE_OFFICER, PRODUCTION_MANAGER, PRODUCTION_SUPERVISOR, GRINDING_SUPERVISOR, PROCUREMENT_OFFICER, QC, HEAD_OF_QC, OPERATOR, TECHNICIAN
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { prisma } from "../lib/db.js";

const [email, fullName, role] = process.argv.slice(2);

async function main() {
  if (!email || !fullName || !role) {
    console.error("Usage: pnpm tsx src/scripts/add-user.ts EMAIL FULLNAME ROLE");
    console.error("Example: pnpm tsx src/scripts/add-user.ts user@example.com 'John Doe' SUPER_ADMIN");
    process.exit(1);
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env");
  }

  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`\n📝 Adding user: ${email}`);

  // Get the Supabase Auth user ID
  const { data: authUsers } = await admin.auth.admin.listUsers();
  const user = authUsers?.users.find((u) => u.email === email);

  if (!user) {
    console.error(`❌ User not found in Supabase Auth: ${email}`);
    console.error("First, sign up this user in the app or create them in Supabase");
    process.exit(1);
  }

  const supabaseId = user.id;
  console.log(`✅ Found Supabase Auth user: ${supabaseId}`);

  // Add to database
  try {
    const dbUser = await prisma.user.upsert({
      where: { id: supabaseId },
      update: {
        fullName,
        role: role as any,
      },
      create: {
        id: supabaseId,
        email,
        username: email.split("@")[0],
        passwordHash: "managed-by-supabase-auth",
        fullName,
        role: role as any,
      },
    });

    console.log(`✅ User added to database:`);
    console.log(`   ID: ${dbUser.id}`);
    console.log(`   Email: ${dbUser.email}`);
    console.log(`   Name: ${dbUser.fullName}`);
    console.log(`   Role: ${dbUser.role}`);
    console.log(`\n✨ You can now sign in with ${email}!\n`);
  } catch (err: any) {
    console.error(`❌ Error adding user: ${err.message}`);
    process.exit(1);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
