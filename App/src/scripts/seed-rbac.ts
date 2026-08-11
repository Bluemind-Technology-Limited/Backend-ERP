/**
 * Seed the RBAC permission matrix (`role_permissions`).
 * Enforces separation of duties per the target spec (5 roles + super admin).
 *
 * Run with: pnpm tsx src/scripts/seed-rbac.ts
 */
import "dotenv/config";
import { prisma } from "../lib/db.js";
import type { UserRole } from "../generated/prisma/client.js";

type Matrix = Partial<Record<"create" | "read" | "update" | "delete" | "approve", boolean>>;

const MODULES = ["master_data", "procurement", "inventory", "production", "qa", "reports", "admin"] as const;

const MATRIX: Record<UserRole, Record<(typeof MODULES)[number], Matrix>> = {
  SUPER_ADMIN: {
    master_data: { create: true, read: true, update: true, delete: true, approve: true },
    procurement: { create: true, read: true, update: true, delete: true, approve: true },
    inventory: { create: true, read: true, update: true, delete: true, approve: true },
    production: { create: true, read: true, update: true, delete: true, approve: true },
    qa: { create: true, read: true, update: true, delete: true, approve: true },
    reports: { create: false, read: true, update: false, delete: false, approve: false },
    admin: { create: true, read: true, update: true, delete: true, approve: true },
  },
  EXECUTIVE_ADMIN: {
    master_data: { read: true },
    procurement: { read: true },
    inventory: { read: true, approve: true }, // approves high-value stock adjustments
    production: { read: true },
    qa: { read: true },
    reports: { read: true, create: true },
    admin: { read: true },
  },
  STORE_OFFICER: {
    master_data: { read: true },
    procurement: { create: true, read: true, update: true }, // requisitions
    inventory: { create: true, read: true, update: true, delete: false }, // GRN, transfers, issues
    production: { read: true },
    qa: {},
    reports: {},
    admin: {},
  },
  PRODUCTION_MANAGER: {
    master_data: { read: true },
    procurement: { read: true },
    inventory: { read: true },
    production: { create: true, read: true, update: true, approve: true }, // BOMs, orders, scheduling
    qa: {},
    reports: { read: true },
    admin: {},
  },
  PROCUREMENT_OFFICER: {
    master_data: { create: true, read: true, update: true }, // suppliers
    procurement: { create: true, read: true, update: true, approve: true }, // requisition -> PO
    inventory: { read: true },
    production: {},
    qa: {},
    reports: {},
    admin: {},
  },
  QA_INSPECTOR: {
    master_data: { read: true },
    procurement: { read: true }, // GRN inspection
    inventory: { read: true, update: true }, // block/release batches
    production: { read: true },
    qa: { create: true, read: true, update: true, approve: true }, // inspections, block/release
    reports: {},
    admin: {},
  },
};

async function main() {
  for (const role of Object.keys(MATRIX) as UserRole[]) {
    for (const module of MODULES) {
      const perms = MATRIX[role][module];
      await prisma.rolePermission.upsert({
        where: { role_module: { role, module } },
        update: {
          canCreate: perms.create ?? false,
          canRead: perms.read ?? false,
          canUpdate: perms.update ?? false,
          canDelete: perms.delete ?? false,
          canApprove: perms.approve ?? false,
        },
        create: {
          role,
          module,
          canCreate: perms.create ?? false,
          canRead: perms.read ?? false,
          canUpdate: perms.update ?? false,
          canDelete: perms.delete ?? false,
          canApprove: perms.approve ?? false,
        },
      });
    }
  }
  console.log("RBAC matrix seeded.");
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
