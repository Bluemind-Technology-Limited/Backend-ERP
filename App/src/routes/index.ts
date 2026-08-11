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

const router: Router = Router();

router.use("/auth", authRouter);
router.use("/master-data", masterDataRouter);
router.use("/procurement", procurementRouter);
router.use("/grn", grnRouter);
router.use("/inventory", inventoryRouter);
router.use("/production", productionRouter);
router.use("/qa", qaRouter);
router.use("/notifications", notificationsRouter);
router.use("/reports", reportsRouter);
router.use("/qstash", qstashRouter);

export default router;
