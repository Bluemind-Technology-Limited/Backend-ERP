import { Router } from "express";
import authRouter from "./auth.js";
import masterDataRouter from "./master-data.js";
import procurementRouter from "./procurement.js";
import grnRouter from "./grn.js";
import inventoryRouter from "./inventory.js";
import productionRouter from "./production.js";
import qaRouter from "./qa.js";
import notificationsRouter from "./notifications.js";
import reportsRouter from "./reports.js";
import qstashRouter from "./qstash.js";
import auditsRouter from "./audits.js";
import stockEmailRouter from "./stock-email.js";
import supervisorProductionRouter from "./supervisorProduction.js";
import qualityApprovalRouter from "./qualityApproval.js";
import machinesRouter from "./machines.js";

const router: Router = Router();

router.use("/auth", authRouter);
router.use("/master-data", masterDataRouter);
router.use("/procurement", procurementRouter);
router.use("/grn", grnRouter);
router.use("/inventory", inventoryRouter);
router.use("/production", productionRouter);
router.use("/supervisor", supervisorProductionRouter);
router.use("/qa", qaRouter);
router.use("/quality", qualityApprovalRouter);
router.use("/machines", machinesRouter);
router.use("/notifications", notificationsRouter);
router.use("/reports", reportsRouter);
router.use("/qstash", qstashRouter);
router.use("/audits", auditsRouter);
router.use("/stock-email", stockEmailRouter);

export default router;
