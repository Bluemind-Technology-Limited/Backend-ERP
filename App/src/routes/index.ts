import { Router } from "express";
import authRouter from "./auth";
import masterDataRouter from "./master-data";
import procurementRouter from "./procurement";
import grnRouter from "./grn";
import inventoryRouter from "./inventory";
import productionRouter from "./production";
import qaRouter from "./qa";
import notificationsRouter from "./notifications";
import reportsRouter from "./reports";

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

export default router;
