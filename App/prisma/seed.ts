import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

let prisma: PrismaClient;

if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
  });
  const adapter = new PrismaPg(pool);
  prisma = new PrismaClient({ adapter });
} else {
  prisma = new PrismaClient({} as any);
}

async function main() {
  console.log("Starting seed...");

  // Seed Categories
  const categories = await Promise.all([
    prisma.machineCategory.upsert({
      where: { code: "BOTTLING_LINE" },
      update: {},
      create: { name: "Bottling Line", code: "BOTTLING_LINE" },
    }),
    prisma.machineCategory.upsert({
      where: { code: "CARTONING_MACHINE" },
      update: {},
      create: { name: "Cartoning Machine", code: "CARTONING_MACHINE" },
    }),
    prisma.machineCategory.upsert({
      where: { code: "DATE_CODER" },
      update: {},
      create: { name: "Date Coder", code: "DATE_CODER" },
    }),
    prisma.machineCategory.upsert({
      where: { code: "SCALE" },
      update: {},
      create: { name: "Scale", code: "SCALE" },
    }),
    prisma.machineCategory.upsert({
      where: { code: "PACKAGING_LINE" },
      update: {},
      create: { name: "Packaging Line", code: "PACKAGING_LINE" },
    }),
  ]);
  console.log(`✓ Seeded ${categories.length} categories`);

  // Seed Departments
  const departments = await Promise.all([
    prisma.machineDepartment.upsert({
      where: { code: "PACKAGING" },
      update: {},
      create: { name: "Packaging", code: "PACKAGING" },
    }),
    prisma.machineDepartment.upsert({
      where: { code: "GRINDING" },
      update: {},
      create: { name: "Grinding", code: "GRINDING" },
    }),
    prisma.machineDepartment.upsert({
      where: { code: "QUALITY" },
      update: {},
      create: { name: "Quality", code: "QUALITY" },
    }),
    prisma.machineDepartment.upsert({
      where: { code: "WAREHOUSE" },
      update: {},
      create: { name: "Warehouse", code: "WAREHOUSE" },
    }),
    prisma.machineDepartment.upsert({
      where: { code: "ADMINISTRATION" },
      update: {},
      create: { name: "Administration", code: "ADMINISTRATION" },
    }),
  ]);
  console.log(`✓ Seeded ${departments.length} departments`);

  // Seed Locations
  const locations = await Promise.all([
    prisma.machineLocation.upsert({
      where: { code: "BLD_A_FL1" },
      update: {},
      create: { name: "Building A - Floor 1", code: "BLD_A_FL1" },
    }),
    prisma.machineLocation.upsert({
      where: { code: "BLD_A_FL2" },
      update: {},
      create: { name: "Building A - Floor 2", code: "BLD_A_FL2" },
    }),
    prisma.machineLocation.upsert({
      where: { code: "BLD_B_GND" },
      update: {},
      create: { name: "Building B - Ground", code: "BLD_B_GND" },
    }),
    prisma.machineLocation.upsert({
      where: { code: "WAREHOUSE" },
      update: {},
      create: { name: "Warehouse", code: "WAREHOUSE" },
    }),
  ]);
  console.log(`✓ Seeded ${locations.length} locations`);

  console.log("✓ Seed complete!");
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
