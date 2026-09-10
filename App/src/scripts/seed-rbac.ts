/**
 * Seed the RBAC permission matrix (`role_permissions`).
 * Enforces separation of duties per the target spec (5 roles + super admin).
 *
 * Run with: pnpm tsx src/scripts/seed-rbac.ts
 */
import "dotenv/config";
import { prisma } from "../lib/db.js";
import type { UserRole } from "@prisma/client";

type Matrix = Partial<Record<"create" | "read" | "update" | "delete" | "approve", boolean>>;

const MODULES = ["master_data", "procurement", "inventory", "production", "qa", "machines", "reports", "admin"] as const;

const MATRIX: Record<UserRole, Record<(typeof MODULES)[number], Matrix>> = {
  SUPER_ADMIN: {
    master_data: { create: true, read: true, update: true, delete: true, approve: true },
    procurement: { create: true, read: true, update: true, delete: true, approve: true },
    inventory: { create: true, read: true, update: true, delete: true, approve: true },
    production: { create: true, read: true, update: true, delete: true, approve: true },
    qa: { create: true, read: true, update: true, delete: true, approve: true },
    machines: { create: true, read: true, update: true, delete: true, approve: true },
    reports: { create: false, read: true, update: false, delete: false, approve: false },
    admin: { create: true, read: true, update: true, delete: true, approve: true },
  },
  EXECUTIVE_ADMIN: {
    master_data: { read: true },
    procurement: { read: true },
    inventory: { read: true, approve: true }, // approves high-value stock adjustments
    production: { read: true },
    qa: { read: true },
    machines: { read: true }, // dashboards, KPIs
    reports: { read: true, create: true },
    admin: { read: true },
  },
  STORE_OFFICER: {
    master_data: { read: true },
    procurement: { create: true, read: true, update: true, delete: true }, // requisitions, can delete draft/closed POs and GRNs
    inventory: { create: true, read: true, update: true, delete: false }, // GRN, transfers, issues
    production: { read: true },
    qa: {},
    machines: { read: true }, // view machines register
    reports: {},
    admin: {},
  },
  PRODUCTION_MANAGER: {
    master_data: { read: true },
    procurement: { read: true, approve: true }, // Can approve requisitions
    inventory: { read: true },
    production: { create: true, read: true, update: true, approve: true }, // BOMs, orders, scheduling
    qa: {},
    machines: { read: true, create: true, update: true }, // register machines, assign staff
    reports: { read: true },
    admin: {},
  },
  PRODUCTION_SUPERVISOR: {
    master_data: { read: true },
    procurement: { read: true },
    inventory: { read: true },
    production: { create: true, read: true, update: true }, // allocates batches, starts/completes production, creates reconciliation
    qa: { read: true },
    machines: { read: true, create: true }, // view machines, log performance
    reports: { read: true },
    admin: {},
  },
  PROCUREMENT_OFFICER: {
    master_data: { create: true, read: true, update: true }, // suppliers
    procurement: { create: true, read: true, update: true, delete: true, approve: true }, // requisition -> PO, can delete draft/closed POs
    inventory: { read: true },
    production: {},
    qa: {},
    machines: { read: true },
    reports: {},
    admin: {},
  },
  QA_INSPECTOR: {
    master_data: { read: true },
    procurement: { read: true, delete: true }, // GRN inspection, can delete GRNs
    inventory: { read: true, update: true }, // block/release batches
    production: { read: true },
    qa: { create: true, read: true, update: true, approve: true }, // inspections, block/release
    machines: { read: true },
    reports: {},
    admin: {},
  },
  OPERATOR: {
    master_data: {},
    procurement: {},
    inventory: {},
    production: { read: true },
    qa: {},
    machines: { read: true, create: true }, // view machines, log breakdowns, record performance
    reports: {},
    admin: {},
  },
  TECHNICIAN: {
    master_data: {},
    procurement: {},
    inventory: {},
    production: { read: true },
    qa: {},
    machines: { read: true, create: true, update: true }, // manage maintenance, spare parts, resolve breakdowns
    reports: { read: true },
    admin: {},
  },
};

async function main() {
  for (const role of Object.keys(MATRIX) as UserRole[]) {
    // Skip roles that don't exist in database yet (will be added after migration)
    if (!["OPERATOR", "TECHNICIAN"].includes(role)) {
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
  }
  console.log("RBAC matrix seeded (existing roles). New roles OPERATOR & TECHNICIAN pending migration deployment.");
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
