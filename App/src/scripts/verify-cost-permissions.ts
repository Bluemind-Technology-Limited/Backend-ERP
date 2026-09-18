/**
 * Verify cost_management permissions are correctly seeded
 * Run with: pnpm tsx src/scripts/verify-cost-permissions.ts
 */
import "dotenv/config";
import { prisma } from "../lib/db.js";

async function main() {
  console.log("\n📊 Verifying Cost Management Permissions\n");
  console.log("=".repeat(80));

  const roles = [
    "SUPER_ADMIN",
    "EXECUTIVE_ADMIN",
    "STORE_OFFICER",
    "PRODUCTION_MANAGER",
    "PRODUCTION_SUPERVISOR",
    "PROCUREMENT_OFFICER",
    "QC",
    "HEAD_OF_QC",
    "GRINDING_SUPERVISOR",
    "OPERATOR",
    "TECHNICIAN",
  ];

  console.log("\n🔐 Cost Management Permissions by Role:\n");

  for (const role of roles) {
    const permission = await prisma.rolePermission.findUnique({
      where: { role_module: { role: role as any, module: "cost_management" } },
    });

    if (permission) {
      const perms = [];
      if (permission.canCreate) perms.push("CREATE");
      if (permission.canRead) perms.push("READ");
      if (permission.canUpdate) perms.push("UPDATE");
      if (permission.canApprove) perms.push("APPROVE");

      const permStr = perms.length > 0 ? perms.join(" + ") : "NONE";
      console.log(`${role.padEnd(25)} → ${permStr}`);
    } else {
      console.log(`${role.padEnd(25)} → ⚠️  NOT FOUND`);
    }
  }

  // Cost modification capability summary
  console.log("\n📋 Summary:\n");

  const canModify = await prisma.rolePermission.findMany({
    where: {
      module: "cost_management",
      canUpdate: true,
    },
    select: { role: true },
  });

  const canApprove = await prisma.rolePermission.findMany({
    where: {
      module: "cost_management",
      canApprove: true,
    },
    select: { role: true },
  });

  console.log(`✅ Roles that can MODIFY costs: ${canModify.map((p) => p.role).join(", ") || "NONE"}`);
  console.log(`✅ Roles that can APPROVE costs: ${canApprove.map((p) => p.role).join(", ") || "NONE"}`);

  console.log("\n" + "=".repeat(80) + "\n");

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
