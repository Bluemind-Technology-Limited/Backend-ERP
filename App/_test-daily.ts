import "dotenv/config";
import express from "express";
import jwt from "jsonwebtoken";
import { prisma } from "./src/lib/db.js";
import apiRouter from "./src/routes/index.js";

const PORT = 4599;
const log = (m: string) => console.log(m);
const assert = (c: unknown, m: string) => { if (!c) throw new Error(`ASSERT FAILED: ${m}`); log(`  ok  ${m}`); };

async function main() {
  const finished = await prisma.material.findFirstOrThrow({ where: { type: "FINISHED" }, select: { id: true, name: true } });
  const ingredient = await prisma.material.findFirstOrThrow({
    where: { type: { not: "FINISHED" }, traceabilityCode: { not: null } },
    select: { id: true, name: true, unitOfMeasure: true, standardCost: true },
  });
  const warehouse = await prisma.warehouse.findFirstOrThrow({ select: { id: true } });

  const prodRoles = await prisma.rolePermission.findMany({
    where: { module: "production", canRead: true, canCreate: true, canUpdate: true },
    select: { role: true },
  });
  let role: any = null;
  for (const r of prodRoles) {
    const inv = await prisma.rolePermission.findFirst({
      where: { role: r.role, module: "inventory", canUpdate: true },
      select: { role: true },
    });
    if (inv) {
      role = r.role;
      break;
    }
  }
  if (!role) throw new Error("No role can both run production and issue stock");
  const user = await prisma.user.findFirstOrThrow({ where: { role, isActive: true }, select: { id: true, role: true } });
  const token = jwt.sign({ sub: user.id, role: user.role }, process.env.SUPABASE_JWT_SECRET as string, { algorithm: "HS256", expiresIn: "10m" });

  const bom = await prisma.bom.create({
    data: {
      productName: `DAILY ${Date.now()}`,
      expectedYield: 100,
      yieldUnit: "kg",
      finishedSkuId: finished.id,
      status: "ACTIVE",
      ingredients: { create: [{ materialId: ingredient.id, quantity: 20, unitOfMeasure: ingredient.unitOfMeasure }] },
    },
  });

  const app = express();
  app.use(express.json());
  app.use("/api", apiRouter);
  const server = app.listen(PORT);
  await new Promise((r) => setTimeout(r, 300));

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data: any = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
  };

  let planId: string | null = null;
  const createdLotIds: string[] = [];

  try {
    const date = "2026-10-15";

    log("1) Create a plan with one product");
    const planRes = await call("POST", "/api/production/production-plans", {
      description: "daily record test",
      items: [{ bomId: bom.id, targetQuantity: 100 }],
    });
    assert(planRes.status === 201, `plan created (${planRes.status}) ${planRes.data?.error ?? ""}`);
    planId = planRes.data.productionPlan.id;

    // Plans start as DRAFT; ingredients can only be issued once scheduled.
    const scheduled = await call("POST", `/api/production/production-plans/${planId}/schedule`, {
      scheduledFor: "2026-10-15T08:00:00.000Z",
    });
    assert(scheduled.status === 200, `plan scheduled (${scheduled.status}) ${scheduled.data?.error ?? ""}`);

    const plan = await prisma.productionPlan.findUniqueOrThrow({
      where: { id: planId },
      include: { items: true, aggregatedIngredients: true },
    });
    const itemId = plan.items[0].id;
    const agg = plan.aggregatedIngredients[0];

    log("2) Notifications were written for the station roles");
    const notifications = await prisma.notification.count({ where: { referenceId: planId } });
    assert(notifications > 0, `${notifications} station notification(s)`);

    log("3) Issue ingredients (creates issue lines with cost)");
    const issueRes = await call("POST", `/api/production-line/plans/${planId}/issue`, {
      warehouseId: warehouse.id,
      lines: [{ aggregatedIngredientId: agg.id, quantity: 40 }],
    });
    assert(issueRes.status === 201, `issued (${issueRes.status}) ${issueRes.data?.error ?? ""}`);

    const issues = await prisma.planIngredientIssue.findMany({ where: { productionPlanId: planId } });
    assert(issues.length === 1, `1 issue line (${issues.length})`);
    assert(Number(issues[0].quantity) === 40, "issue quantity stored");

    log("4) Record grinding with a remainder + receipt breakdown");
    const grindingRes = await call("POST", `/api/production-line/plans/${planId}/items/${itemId}/grinding`, {
      inputQuantity: 100,
      achievedQuantity: 90,
      productionDate: date,
      remainders: [{ materialId: ingredient.id, quantity: 10, warehouseId: warehouse.id }],
      inputs: [
        { materialId: ingredient.id, quantity: 20 },
        { materialId: ingredient.id, quantity: 20 },
        { materialId: ingredient.id, quantity: 20 },
        { materialId: ingredient.id, quantity: 20 },
        { materialId: ingredient.id, quantity: 20 },
      ],
    });
    assert(grindingRes.status === 201, `grinding recorded (${grindingRes.status}) ${grindingRes.data?.error ?? ""}`);

    log("5) Record finishing");
    const finishingRes = await call("POST", `/api/production-line/plans/${planId}/items/${itemId}/finishing`, {
      achievedQuantity: 80,
      remainderQuantity: 10,
      warehouseId: warehouse.id,
      batchNumber: `FB-${Date.now().toString().slice(-6)}`,
      productionDate: date,
    });
    assert(finishingRes.status === 201, `finishing recorded (${finishingRes.status}) ${finishingRes.data?.error ?? ""}`);

    log("6) Daily records aggregate the day");
    const daily = await call("GET", `/api/production-line/daily-records?from=2026-10-01&to=2026-10-31`);
    assert(daily.status === 200, `daily endpoint (${daily.status})`);
    const day = (daily.data.days ?? []).find((d: any) => d.date === date);
    assert(!!day, `day ${date} present`);
    assert(day.achieved.outputQty === 80, `output qty = ${day.achieved.outputQty}`);
    assert(day.achieved.grindingQty === 90, `grinding qty = ${day.achieved.grindingQty}`);
    assert(day.achieved.lines.length === 2, `2 stage records (${day.achieved.lines.length})`);
    assert(day.achieved.ingredients.length === 1 && day.achieved.ingredients[0].quantity === 40, "ingredient line (40)");
    assert(day.achieved.materials.length === 1 && day.achieved.materials[0].quantity === 100, `ground material 100 (${day.achieved.materials[0]?.quantity})`);
    assert(day.achieved.materials[0].lots.length === 5, `5 receipt lots (${day.achieved.materials[0].lots.length})`);
    assert(day.complete === false, "day has a remainder");
    assert(day.wip.lines.length >= 1, `wip lines (${day.wip.lines.length})`);
    assert(day.wip.quantity === 10, `wip qty = ${day.wip.quantity}`);
  } finally {
    log("\nCleanup");
    if (planId) {
      const plan = await prisma.productionPlan.findUnique({
        where: { id: planId },
        include: { items: true, stageRecords: true },
      });
      const lotIds = (plan?.stageRecords ?? []).map((r) => r.finishedBatchLotId).filter(Boolean) as string[];
      createdLotIds.push(...lotIds);

      await prisma.planIngredientIssue.deleteMany({ where: { productionPlanId: planId } });
      await prisma.productionStageRecord.deleteMany({ where: { productionPlanId: planId } });
      await prisma.planAggregatedIngredient.deleteMany({ where: { productionPlanId: planId } });
      await prisma.productionPlanItem.deleteMany({ where: { productionPlanId: planId } });
      await prisma.productionPlan.delete({ where: { id: planId } }).catch(() => {});
      await prisma.notification.deleteMany({ where: { referenceId: planId } });
      await prisma.inventoryTransaction.deleteMany({ where: { referenceId: planId } });
      await prisma.inspectionRecord.deleteMany({ where: { referenceId: { in: (plan?.items ?? []).map((i) => i.id) } } });
    }
    for (const id of createdLotIds) {
      await prisma.batchLot.delete({ where: { id } }).catch(() => {});
    }
    await prisma.bomIngredient.deleteMany({ where: { bomId: bom.id } });
    await prisma.bom.delete({ where: { id: bom.id } }).catch(() => {});
    log(`  plans left: ${planId ? await prisma.productionPlan.count({ where: { id: planId } }) : 0}`);
    server.close();
  }
}

main().then(() => { console.log("\nALL CHECKS PASSED"); process.exit(0); })
  .catch((e) => { console.error("\nFAILED:", e?.message); process.exit(1); });
