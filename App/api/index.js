// src/app.ts
import "dotenv/config";
import express from "express";
import cors from "cors";

// src/lib/db.ts
import "dotenv/config";

// src/generated/prisma/client.ts
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// src/generated/prisma/internal/class.ts
import * as runtime from "@prisma/client/runtime/client";
var config = {
  "previewFeatures": [],
  "clientVersion": "7.9.1",
  "engineVersion": "e922089b7d7502aff4249d5da3420f6fa55fc6ad",
  "activeProvider": "postgresql",
  "inlineSchema": '// KIB ERP \u2014 Prisma schema (PostgreSQL / Supabase)\n// Event-driven inventory ledger, RBAC, procurement, production & QA.\n// Docs: ../../architecture/KIB-ERP-target-architecture.md\n\ngenerator client {\n  provider = "prisma-client"\n  output   = "../src/generated/prisma"\n  runtime  = "nodejs"\n}\n\ndatasource db {\n  provider = "postgresql"\n}\n\n// ---------------------------------------------------------------------------\n// Enums\n// ---------------------------------------------------------------------------\n\nenum UserRole {\n  SUPER_ADMIN // full access, manages admins & high-value approvals\n  EXECUTIVE_ADMIN // dashboards, KPIs, approves high-value adjustments\n  STORE_OFFICER // requisitions, GRN receiving, issues to production, transfers\n  PRODUCTION_MANAGER // BOMs, production orders, machines/staff allocation\n  PROCUREMENT_OFFICER // suppliers, requisition -> purchase orders\n  QA_INSPECTOR // block/release batches, lab tests, GRN approval\n}\n\nenum MaterialType {\n  RAW\n  PACKAGING\n  FINISHED\n}\n\nenum BatchStatus {\n  ACTIVE\n  QUARANTINE\n  REJECTED\n  EXPIRED\n}\n\nenum LedgerEventType {\n  PO_RECEIPT // positive\n  PROD_CONSUMPTION // negative\n  PROD_OUTPUT // positive\n  WASTE // negative\n  ADJUSTMENT // +/- (gated)\n  TRANSFER_IN // positive\n  TRANSFER_OUT // negative\n}\n\nenum RequisitionStatus {\n  DRAFT\n  PENDING_APPROVAL\n  APPROVED\n  REJECTED\n}\n\nenum PurchaseOrderStatus {\n  DRAFT\n  SENT\n  PARTIAL\n  RECEIVED\n  CLOSED\n}\n\nenum GoodsReceiptStatus {\n  PENDING_QA\n  APPROVED\n  REJECTED\n}\n\nenum ProductionOrderStatus {\n  SCHEDULED\n  PROCESSING\n  COMPLETED\n  WASTED\n}\n\nenum BomStatus {\n  DRAFT\n  ACTIVE\n  APPROVED\n  ARCHIVED\n}\n\nenum InspectionResult {\n  PENDING\n  PASSED\n  FAILED\n}\n\nenum RecordStatus {\n  ACTIVE\n  INACTIVE\n}\n\n// ---------------------------------------------------------------------------\n// 1. Auth & RBAC\n// ---------------------------------------------------------------------------\n\nmodel User {\n  // id = Supabase Auth user id (JWT `sub`). The `users` table is the app\n  // profile layer keyed 1:1 to Supabase `auth.users`. Created post-signup\n  // (see seed script / auth webhook), never auto-generated here.\n  id           String   @id\n  email        String   @unique\n  username     String   @unique\n  passwordHash String   @map("password_hash")\n  fullName     String   @map("full_name")\n  role         UserRole\n  phoneNumber  String?  @map("phone_number")\n  isActive     Boolean  @default(true) @map("is_active")\n  createdAt    DateTime @default(now()) @map("created_at")\n  updatedAt    DateTime @updatedAt @map("updated_at")\n\n  requisitions        Requisition[]\n  purchaseOrders      PurchaseOrder[]\n  goodsReceipts       GoodsReceipt[]\n  productionOrders    ProductionOrder[]\n  inspections         InspectionRecord[]\n  createdTransactions InventoryTransaction[] @relation("transaction_creator")\n  approvedAdjustments InventoryTransaction[] @relation("adjustment_approver")\n  notifications       Notification[]\n\n  @@map("users")\n}\n\nmodel RolePermission {\n  id         String   @id @default(uuid())\n  role       UserRole\n  module     String // e.g. "inventory", "procurement", "production", "qa", "reports"\n  canCreate  Boolean  @default(false) @map("can_create")\n  canRead    Boolean  @default(true) @map("can_read")\n  canUpdate  Boolean  @default(false) @map("can_update")\n  canDelete  Boolean  @default(false) @map("can_delete")\n  canApprove Boolean  @default(false) @map("can_approve")\n  createdAt  DateTime @default(now()) @map("created_at")\n\n  @@unique([role, module])\n  @@map("role_permissions")\n}\n\n// ---------------------------------------------------------------------------\n// 2. Master Data\n// ---------------------------------------------------------------------------\n\nmodel Material {\n  id            String       @id @default(uuid())\n  name          String\n  sku           String       @unique\n  type          MaterialType\n  category      String?\n  unitOfMeasure String       @map("unit_of_measure") // kg, liters, units\n  barcode       String?\n  shelfLifeDays Int?         @map("shelf_life_days") // expiry parameters\n  requiresLot   Boolean      @default(true) @map("requires_lot")\n  attachments   Json? // [{name, url, kind: NAFDAC|MSDS|COA}]\n  status        RecordStatus @default(ACTIVE)\n  createdAt     DateTime     @default(now()) @map("created_at")\n  updatedAt     DateTime     @updatedAt @map("updated_at")\n\n  batches           BatchLot[]\n  transactions      InventoryTransaction[]\n  bomIngredients    BomIngredient[]\n  bomOutputs        BomVersion[] // finished product variants of this SKU\n  requisitionItems  RequisitionItem[]\n  poItems           PurchaseOrderItem[]\n  grnItems          GoodsReceiptItem[]\n  inspectionRecords InspectionRecord[]\n  suppliers         MaterialSupplier[]\n\n  @@map("materials")\n}\n\nmodel Warehouse {\n  id        String       @id @default(uuid())\n  name      String\n  code      String       @unique\n  address   String?\n  status    RecordStatus @default(ACTIVE)\n  createdAt DateTime     @default(now()) @map("created_at")\n\n  zones        Zone[]\n  bins         WarehouseBin[]\n  transactions InventoryTransaction[]\n\n  @@map("warehouses")\n}\n\nmodel Zone {\n  id          String       @id @default(uuid())\n  warehouseId String       @map("warehouse_id")\n  name        String\n  code        String\n  status      RecordStatus @default(ACTIVE)\n\n  warehouse Warehouse      @relation(fields: [warehouseId], references: [id], onDelete: Cascade)\n  bins      WarehouseBin[]\n\n  @@unique([warehouseId, code])\n  @@map("zones")\n}\n\nmodel WarehouseBin {\n  id          String       @id @default(uuid())\n  zoneId      String       @map("zone_id")\n  warehouseId String       @map("warehouse_id")\n  name        String\n  code        String\n  status      RecordStatus @default(ACTIVE)\n\n  zone         Zone                   @relation(fields: [zoneId], references: [id])\n  warehouse    Warehouse              @relation(fields: [warehouseId], references: [id])\n  transactions InventoryTransaction[]\n\n  @@unique([zoneId, code])\n  @@map("warehouse_bins")\n}\n\nmodel Supplier {\n  id            String       @id @default(uuid())\n  name          String\n  contactPerson String?      @map("contact_person")\n  email         String?\n  phone         String?\n  address       String?\n  taxId         String?      @map("tax_id")\n  status        RecordStatus @default(ACTIVE)\n  createdAt     DateTime     @default(now()) @map("created_at")\n  updatedAt     DateTime     @updatedAt @map("updated_at")\n\n  purchaseOrders PurchaseOrder[]\n  materials      MaterialSupplier[]\n\n  @@map("suppliers")\n}\n\n// Many-to-many: which suppliers can source a given material.\nmodel MaterialSupplier {\n  materialId String   @map("material_id")\n  supplierId String   @map("supplier_id")\n  material   Material @relation(fields: [materialId], references: [id], onDelete: Cascade)\n  supplier   Supplier @relation(fields: [supplierId], references: [id], onDelete: Cascade)\n\n  @@id([materialId, supplierId])\n  @@map("material_suppliers")\n}\n\n// ---------------------------------------------------------------------------\n// 3. Inventory Ledger (event-sourced)\n// ---------------------------------------------------------------------------\n\nmodel BatchLot {\n  id                String      @id @default(uuid())\n  batchNumber       String      @map("batch_number")\n  materialId        String      @map("material_id")\n  manufacturingDate DateTime?   @map("manufacturing_date")\n  expiryDate        DateTime?   @map("expiry_date")\n  status            BatchStatus @default(ACTIVE)\n  notes             String?\n  createdAt         DateTime    @default(now()) @map("created_at")\n\n  material         Material               @relation(fields: [materialId], references: [id])\n  transactions     InventoryTransaction[]\n  productionOrders ProductionOrder[]      @relation("finished_batch")\n  grnItems         GoodsReceiptItem[]\n  inspections      InspectionRecord[]\n\n  @@unique([materialId, batchNumber])\n  @@map("batch_lots")\n}\n\n// THE LEDGER \u2014 every stock movement is an immutable entry.\n// "Current stock" is the SUM of transactions per material/batch/bin. Never a mutable column.\nmodel InventoryTransaction {\n  id            String          @id @default(uuid())\n  eventType     LedgerEventType @map("event_type")\n  materialId    String          @map("material_id")\n  batchLotId    String?         @map("batch_lot_id")\n  warehouseId   String          @map("warehouse_id")\n  binId         String?         @map("bin_id")\n  quantity      Decimal         @db.Decimal(15, 4) // signed: + in, - out\n  unitOfMeasure String          @map("unit_of_measure")\n  referenceType String?         @map("reference_type") // PO, GRN, PROD_ORDER, ADJUSTMENT\n  referenceId   String?         @map("reference_id")\n  createdById   String          @map("created_by_id")\n  approvedById  String?         @map("approved_by_id") // for gated adjustments\n  notes         String?\n  createdAt     DateTime        @default(now()) @map("created_at")\n\n  material   Material      @relation(fields: [materialId], references: [id])\n  batchLot   BatchLot?     @relation(fields: [batchLotId], references: [id])\n  warehouse  Warehouse     @relation(fields: [warehouseId], references: [id])\n  bin        WarehouseBin? @relation(fields: [binId], references: [id])\n  createdBy  User          @relation("transaction_creator", fields: [createdById], references: [id])\n  approvedBy User?         @relation("adjustment_approver", fields: [approvedById], references: [id])\n\n  @@index([materialId, batchLotId, warehouseId])\n  @@index([createdAt])\n  @@map("inventory_transactions")\n}\n\n// ---------------------------------------------------------------------------\n// 4. Procurement (Requisition -> PO -> GRN)\n// ---------------------------------------------------------------------------\n\nmodel Requisition {\n  id            String            @id @default(uuid())\n  number        String            @unique\n  requestedById String            @map("requested_by_id")\n  status        RequisitionStatus @default(DRAFT)\n  notes         String?\n  createdAt     DateTime          @default(now()) @map("created_at")\n  updatedAt     DateTime          @updatedAt @map("updated_at")\n\n  requestedBy    User              @relation(fields: [requestedById], references: [id])\n  items          RequisitionItem[]\n  purchaseOrders PurchaseOrder[]\n\n  @@map("requisitions")\n}\n\nmodel RequisitionItem {\n  id            String  @id @default(uuid())\n  requisitionId String  @map("requisition_id")\n  materialId    String  @map("material_id")\n  quantity      Decimal @db.Decimal(15, 4)\n  unitOfMeasure String  @map("unit_of_measure")\n\n  requisition Requisition @relation(fields: [requisitionId], references: [id], onDelete: Cascade)\n  material    Material    @relation(fields: [materialId], references: [id])\n\n  @@map("requisition_items")\n}\n\nmodel PurchaseOrder {\n  id               String              @id @default(uuid())\n  number           String              @unique\n  supplierId       String              @map("supplier_id")\n  requisitionId    String?             @map("requisition_id")\n  createdById      String              @map("created_by_id")\n  status           PurchaseOrderStatus @default(DRAFT)\n  orderDate        DateTime?           @default(now()) @map("order_date")\n  expectedDelivery DateTime?           @map("expected_delivery")\n  notes            String?\n  createdAt        DateTime            @default(now()) @map("created_at")\n  updatedAt        DateTime            @updatedAt @map("updated_at")\n\n  supplier      Supplier            @relation(fields: [supplierId], references: [id])\n  requisition   Requisition?        @relation(fields: [requisitionId], references: [id])\n  createdBy     User                @relation(fields: [createdById], references: [id])\n  items         PurchaseOrderItem[]\n  goodsReceipts GoodsReceipt[]\n\n  @@map("purchase_orders")\n}\n\nmodel PurchaseOrderItem {\n  id            String  @id @default(uuid())\n  poId          String  @map("po_id")\n  materialId    String  @map("material_id")\n  quantity      Decimal @db.Decimal(15, 4)\n  unitCost      Decimal @map("unit_cost") @db.Decimal(15, 4)\n  receivedQty   Decimal @default(0) @map("received_qty") @db.Decimal(15, 4)\n  unitOfMeasure String  @map("unit_of_measure")\n\n  po       PurchaseOrder @relation(fields: [poId], references: [id], onDelete: Cascade)\n  material Material      @relation(fields: [materialId], references: [id])\n\n  @@map("purchase_order_items")\n}\n\nmodel GoodsReceipt {\n  id           String             @id @default(uuid())\n  number       String             @unique\n  poId         String             @map("po_id")\n  receivedById String             @map("received_by_id")\n  status       GoodsReceiptStatus @default(PENDING_QA)\n  receivedAt   DateTime           @default(now()) @map("received_at")\n  notes        String?\n  createdAt    DateTime           @default(now()) @map("created_at")\n\n  po         PurchaseOrder      @relation(fields: [poId], references: [id])\n  receivedBy User               @relation(fields: [receivedById], references: [id])\n  items      GoodsReceiptItem[]\n\n  @@map("goods_receipts")\n}\n\nmodel GoodsReceiptItem {\n  id            String  @id @default(uuid())\n  grnId         String  @map("grn_id")\n  materialId    String  @map("material_id")\n  batchLotId    String  @map("batch_lot_id")\n  quantity      Decimal @db.Decimal(15, 4)\n  unitOfMeasure String  @map("unit_of_measure")\n\n  grn      GoodsReceipt @relation(fields: [grnId], references: [id], onDelete: Cascade)\n  material Material     @relation(fields: [materialId], references: [id])\n  batchLot BatchLot     @relation(fields: [batchLotId], references: [id])\n\n  @@map("goods_receipt_items")\n}\n\n// ---------------------------------------------------------------------------\n// 5. Production Engineering & Execution\n// ---------------------------------------------------------------------------\n\nmodel Bom {\n  id          String   @id @default(uuid())\n  productName String   @map("product_name")\n  description String?\n  createdAt   DateTime @default(now()) @map("created_at")\n  updatedAt   DateTime @updatedAt @map("updated_at")\n\n  versions BomVersion[]\n\n  @@map("boms")\n}\n\nmodel BomVersion {\n  id            String    @id @default(uuid())\n  bomId         String    @map("bom_id")\n  version       Int\n  description   String?\n  expectedYield Decimal   @map("expected_yield") @db.Decimal(15, 4)\n  yieldUnit     String    @map("yield_unit")\n  finishedSkuId String    @map("finished_sku_id") // the FINISHED material produced\n  status        BomStatus @default(DRAFT)\n  createdAt     DateTime  @default(now()) @map("created_at")\n\n  bom              Bom               @relation(fields: [bomId], references: [id], onDelete: Cascade)\n  finishedSku      Material          @relation(fields: [finishedSkuId], references: [id])\n  ingredients      BomIngredient[]\n  productionOrders ProductionOrder[]\n\n  @@unique([bomId, version])\n  @@map("bom_versions")\n}\n\nmodel BomIngredient {\n  id            String  @id @default(uuid())\n  bomVersionId  String  @map("bom_version_id")\n  materialId    String  @map("material_id")\n  quantity      Decimal @db.Decimal(15, 4)\n  unitOfMeasure String  @map("unit_of_measure")\n  isPercentage  Boolean @default(false) @map("is_percentage") // % vs absolute weight\n\n  bomVersion BomVersion @relation(fields: [bomVersionId], references: [id], onDelete: Cascade)\n  material   Material   @relation(fields: [materialId], references: [id])\n\n  @@map("bom_ingredients")\n}\n\nmodel Machine {\n  id     String       @id @default(uuid())\n  name   String\n  code   String       @unique\n  status RecordStatus @default(ACTIVE)\n\n  productionOrders ProductionOrder[]\n\n  @@map("machines")\n}\n\nmodel Shift {\n  id        String @id @default(uuid())\n  name      String\n  startTime String @map("start_time")\n  endTime   String @map("end_time")\n\n  productionOrders ProductionOrder[]\n\n  @@map("shifts")\n}\n\nmodel ProductionOrder {\n  id              String                @id @default(uuid())\n  orderNumber     String                @unique\n  bomVersionId    String                @map("bom_version_id")\n  targetQuantity  Decimal               @map("target_quantity") @db.Decimal(15, 4)\n  actualYield     Decimal?              @map("actual_yield") @db.Decimal(15, 4)\n  status          ProductionOrderStatus @default(SCHEDULED)\n  scheduledStart  DateTime?             @map("scheduled_start")\n  actualEnd       DateTime?             @map("actual_end")\n  machineId       String?               @map("machine_id")\n  shiftId         String?               @map("shift_id")\n  createdById     String                @map("created_by_id")\n  finishedBatchId String?               @map("finished_batch_id")\n  createdAt       DateTime              @default(now()) @map("created_at")\n  updatedAt       DateTime              @updatedAt @map("updated_at")\n\n  bomVersion    BomVersion @relation(fields: [bomVersionId], references: [id])\n  machine       Machine?   @relation(fields: [machineId], references: [id])\n  shift         Shift?     @relation(fields: [shiftId], references: [id])\n  createdBy     User       @relation(fields: [createdById], references: [id])\n  finishedBatch BatchLot?  @relation("finished_batch", fields: [finishedBatchId], references: [id])\n\n  @@map("production_orders")\n}\n\n// ---------------------------------------------------------------------------\n// 6. QA\n// ---------------------------------------------------------------------------\n\nmodel InspectionRecord {\n  id             String           @id @default(uuid())\n  inspectionType String           @map("inspection_type") // GRN | FINISHED_BATCH\n  materialId     String           @map("material_id")\n  batchLotId     String?          @map("batch_lot_id")\n  referenceId    String?          @map("reference_id") // GRN or Production Order\n  result         InspectionResult @default(PENDING)\n  notes          String?\n  inspectedById  String?          @map("inspected_by_id")\n  inspectedAt    DateTime?        @map("inspected_at")\n  createdAt      DateTime         @default(now()) @map("created_at")\n\n  material  Material  @relation(fields: [materialId], references: [id])\n  batchLot  BatchLot? @relation(fields: [batchLotId], references: [id])\n  inspector User?     @relation(fields: [inspectedById], references: [id])\n\n  @@map("inspection_records")\n}\n\n// ---------------------------------------------------------------------------\n// 7. Notifications / Alerts\n// ---------------------------------------------------------------------------\n\nmodel Notification {\n  id        String   @id @default(uuid())\n  userId    String   @map("user_id")\n  title     String\n  body      String?\n  type      String // EXPIRY | LOW_STOCK | APPROVAL | SYSTEM\n  isRead    Boolean  @default(false) @map("is_read")\n  createdAt DateTime @default(now()) @map("created_at")\n\n  user User @relation(fields: [userId], references: [id])\n\n  @@map("notifications")\n}\n',
  "runtimeDataModel": {
    "models": {},
    "enums": {},
    "types": {}
  },
  "parameterizationSchema": {
    "strings": [],
    "graph": ""
  }
};
config.runtimeDataModel = JSON.parse('{"models":{"User":{"fields":[{"name":"id","kind":"scalar","type":"String"},{"name":"email","kind":"scalar","type":"String"},{"name":"username","kind":"scalar","type":"String"},{"name":"passwordHash","kind":"scalar","type":"String","dbName":"password_hash"},{"name":"fullName","kind":"scalar","type":"String","dbName":"full_name"},{"name":"role","kind":"enum","type":"UserRole"},{"name":"phoneNumber","kind":"scalar","type":"String","dbName":"phone_number"},{"name":"isActive","kind":"scalar","type":"Boolean","dbName":"is_active"},{"name":"createdAt","kind":"scalar","type":"DateTime","dbName":"created_at"},{"name":"updatedAt","kind":"scalar","type":"DateTime","dbName":"updated_at"},{"name":"requisitions","kind":"object","type":"Requisition","relationName":"RequisitionToUser"},{"name":"purchaseOrders","kind":"object","type":"PurchaseOrder","relationName":"PurchaseOrderToUser"},{"name":"goodsReceipts","kind":"object","type":"GoodsReceipt","relationName":"GoodsReceiptToUser"},{"name":"productionOrders","kind":"object","type":"ProductionOrder","relationName":"ProductionOrderToUser"},{"name":"inspections","kind":"object","type":"InspectionRecord","relationName":"InspectionRecordToUser"},{"name":"createdTransactions","kind":"object","type":"InventoryTransaction","relationName":"transaction_creator"},{"name":"approvedAdjustments","kind":"object","type":"InventoryTransaction","relationName":"adjustment_approver"},{"name":"notifications","kind":"object","type":"Notification","relationName":"NotificationToUser"}],"dbName":"users"},"RolePermission":{"fields":[{"name":"id","kind":"scalar","type":"String"},{"name":"role","kind":"enum","type":"UserRole"},{"name":"module","kind":"scalar","type":"String"},{"name":"canCreate","kind":"scalar","type":"Boolean","dbName":"can_create"},{"name":"canRead","kind":"scalar","type":"Boolean","dbName":"can_read"},{"name":"canUpdate","kind":"scalar","type":"Boolean","dbName":"can_update"},{"name":"canDelete","kind":"scalar","type":"Boolean","dbName":"can_delete"},{"name":"canApprove","kind":"scalar","type":"Boolean","dbName":"can_approve"},{"name":"createdAt","kind":"scalar","type":"DateTime","dbName":"created_at"}],"dbName":"role_permissions"},"Material":{"fields":[{"name":"id","kind":"scalar","type":"String"},{"name":"name","kind":"scalar","type":"String"},{"name":"sku","kind":"scalar","type":"String"},{"name":"type","kind":"enum","type":"MaterialType"},{"name":"category","kind":"scalar","type":"String"},{"name":"unitOfMeasure","kind":"scalar","type":"String","dbName":"unit_of_measure"},{"name":"barcode","kind":"scalar","type":"String"},{"name":"shelfLifeDays","kind":"scalar","type":"Int","dbName":"shelf_life_days"},{"name":"requiresLot","kind":"scalar","type":"Boolean","dbName":"requires_lot"},{"name":"attachments","kind":"scalar","type":"Json"},{"name":"status","kind":"enum","type":"RecordStatus"},{"name":"createdAt","kind":"scalar","type":"DateTime","dbName":"created_at"},{"name":"updatedAt","kind":"scalar","type":"DateTime","dbName":"updated_at"},{"name":"batches","kind":"object","type":"BatchLot","relationName":"BatchLotToMaterial"},{"name":"transactions","kind":"object","type":"InventoryTransaction","relationName":"InventoryTransactionToMaterial"},{"name":"bomIngredients","kind":"object","type":"BomIngredient","relationName":"BomIngredientToMaterial"},{"name":"bomOutputs","kind":"object","type":"BomVersion","relationName":"BomVersionToMaterial"},{"name":"requisitionItems","kind":"object","type":"RequisitionItem","relationName":"MaterialToRequisitionItem"},{"name":"poItems","kind":"object","type":"PurchaseOrderItem","relationName":"MaterialToPurchaseOrderItem"},{"name":"grnItems","kind":"object","type":"GoodsReceiptItem","relationName":"GoodsReceiptItemToMaterial"},{"name":"inspectionRecords","kind":"object","type":"InspectionRecord","relationName":"InspectionRecordToMaterial"},{"name":"suppliers","kind":"object","type":"MaterialSupplier","relationName":"MaterialToMaterialSupplier"}],"dbName":"materials"},"Warehouse":{"fields":[{"name":"id","kind":"scalar","type":"String"},{"name":"name","kind":"scalar","type":"String"},{"name":"code","kind":"scalar","type":"String"},{"name":"address","kind":"scalar","type":"String"},{"name":"status","kind":"enum","type":"RecordStatus"},{"name":"createdAt","kind":"scalar","type":"DateTime","dbName":"created_at"},{"name":"zones","kind":"object","type":"Zone","relationName":"WarehouseToZone"},{"name":"bins","kind":"object","type":"WarehouseBin","relationName":"WarehouseToWarehouseBin"},{"name":"transactions","kind":"object","type":"InventoryTransaction","relationName":"InventoryTransactionToWarehouse"}],"dbName":"warehouses"},"Zone":{"fields":[{"name":"id","kind":"scalar","type":"String"},{"name":"warehouseId","kind":"scalar","type":"String","dbName":"warehouse_id"},{"name":"name","kind":"scalar","type":"String"},{"name":"code","kind":"scalar","type":"String"},{"name":"status","kind":"enum","type":"RecordStatus"},{"name":"warehouse","kind":"object","type":"Warehouse","relationName":"WarehouseToZone"},{"name":"bins","kind":"object","type":"WarehouseBin","relationName":"WarehouseBinToZone"}],"dbName":"zones"},"WarehouseBin":{"fields":[{"name":"id","kind":"scalar","type":"String"},{"name":"zoneId","kind":"scalar","type":"String","dbName":"zone_id"},{"name":"warehouseId","kind":"scalar","type":"String","dbName":"warehouse_id"},{"name":"name","kind":"scalar","type":"String"},{"name":"code","kind":"scalar","type":"String"},{"name":"status","kind":"enum","type":"RecordStatus"},{"name":"zone","kind":"object","type":"Zone","relationName":"WarehouseBinToZone"},{"name":"warehouse","kind":"object","type":"Warehouse","relationName":"WarehouseToWarehouseBin"},{"name":"transactions","kind":"object","type":"InventoryTransaction","relationName":"InventoryTransactionToWarehouseBin"}],"dbName":"warehouse_bins"},"Supplier":{"fields":[{"name":"id","kind":"scalar","type":"String"},{"name":"name","kind":"scalar","type":"String"},{"name":"contactPerson","kind":"scalar","type":"String","dbName":"contact_person"},{"name":"email","kind":"scalar","type":"String"},{"name":"phone","kind":"scalar","type":"String"},{"name":"address","kind":"scalar","type":"String"},{"name":"taxId","kind":"scalar","type":"String","dbName":"tax_id"},{"name":"status","kind":"enum","type":"RecordStatus"},{"name":"createdAt","kind":"scalar","type":"DateTime","dbName":"created_at"},{"name":"updatedAt","kind":"scalar","type":"DateTime","dbName":"updated_at"},{"name":"purchaseOrders","kind":"object","type":"PurchaseOrder","relationName":"PurchaseOrderToSupplier"},{"name":"materials","kind":"object","type":"MaterialSupplier","relationName":"MaterialSupplierToSupplier"}],"dbName":"suppliers"},"MaterialSupplier":{"fields":[{"name":"materialId","kind":"scalar","type":"String","dbName":"material_id"},{"name":"supplierId","kind":"scalar","type":"String","dbName":"supplier_id"},{"name":"material","kind":"object","type":"Material","relationName":"MaterialToMaterialSupplier"},{"name":"supplier","kind":"object","type":"Supplier","relationName":"MaterialSupplierToSupplier"}],"dbName":"material_suppliers"},"BatchLot":{"fields":[{"name":"id","kind":"scalar","type":"String"},{"name":"batchNumber","kind":"scalar","type":"String","dbName":"batch_number"},{"name":"materialId","kind":"scalar","type":"String","dbName":"material_id"},{"name":"manufacturingDate","kind":"scalar","type":"DateTime","dbName":"manufacturing_date"},{"name":"expiryDate","kind":"scalar","type":"DateTime","dbName":"expiry_date"},{"name":"status","kind":"enum","type":"BatchStatus"},{"name":"notes","kind":"scalar","type":"String"},{"name":"createdAt","kind":"scalar","type":"DateTime","dbName":"created_at"},{"name":"material","kind":"object","type":"Material","relationName":"BatchLotToMaterial"},{"name":"transactions","kind":"object","type":"InventoryTransaction","relationName":"BatchLotToInventoryTransaction"},{"name":"productionOrders","kind":"object","type":"ProductionOrder","relationName":"finished_batch"},{"name":"grnItems","kind":"object","type":"GoodsReceiptItem","relationName":"BatchLotToGoodsReceiptItem"},{"name":"inspections","kind":"object","type":"InspectionRecord","relationName":"BatchLotToInspectionRecord"}],"dbName":"batch_lots"},"InventoryTransaction":{"fields":[{"name":"id","kind":"scalar","type":"String"},{"name":"eventType","kind":"enum","type":"LedgerEventType","dbName":"event_type"},{"name":"materialId","kind":"scalar","type":"String","dbName":"material_id"},{"name":"batchLotId","kind":"scalar","type":"String","dbName":"batch_lot_id"},{"name":"warehouseId","kind":"scalar","type":"String","dbName":"warehouse_id"},{"name":"binId","kind":"scalar","type":"String","dbName":"bin_id"},{"name":"quantity","kind":"scalar","type":"Decimal"},{"name":"unitOfMeasure","kind":"scalar","type":"String","dbName":"unit_of_measure"},{"name":"referenceType","kind":"scalar","type":"String","dbName":"reference_type"},{"name":"referenceId","kind":"scalar","type":"String","dbName":"reference_id"},{"name":"createdById","kind":"scalar","type":"String","dbName":"created_by_id"},{"name":"approvedById","kind":"scalar","type":"String","dbName":"approved_by_id"},{"name":"notes","kind":"scalar","type":"String"},{"name":"createdAt","kind":"scalar","type":"DateTime","dbName":"created_at"},{"name":"material","kind":"object","type":"Material","relationName":"InventoryTransactionToMaterial"},{"name":"batchLot","kind":"object","type":"BatchLot","relationName":"BatchLotToInventoryTransaction"},{"name":"warehouse","kind":"object","type":"Warehouse","relationName":"InventoryTransactionToWarehouse"},{"name":"bin","kind":"object","type":"WarehouseBin","relationName":"InventoryTransactionToWarehouseBin"},{"name":"createdBy","kind":"object","type":"User","relationName":"transaction_creator"},{"name":"approvedBy","kind":"object","type":"User","relationName":"adjustment_approver"}],"dbName":"inventory_transactions"},"Requisition":{"fields":[{"name":"id","kind":"scalar","type":"String"},{"name":"number","kind":"scalar","type":"String"},{"name":"requestedById","kind":"scalar","type":"String","dbName":"requested_by_id"},{"name":"status","kind":"enum","type":"RequisitionStatus"},{"name":"notes","kind":"scalar","type":"String"},{"name":"createdAt","kind":"scalar","type":"DateTime","dbName":"created_at"},{"name":"updatedAt","kind":"scalar","type":"DateTime","dbName":"updated_at"},{"name":"requestedBy","kind":"object","type":"User","relationName":"RequisitionToUser"},{"name":"items","kind":"object","type":"RequisitionItem","relationName":"RequisitionToRequisitionItem"},{"name":"purchaseOrders","kind":"object","type":"PurchaseOrder","relationName":"PurchaseOrderToRequisition"}],"dbName":"requisitions"},"RequisitionItem":{"fields":[{"name":"id","kind":"scalar","type":"String"},{"name":"requisitionId","kind":"scalar","type":"String","dbName":"requisition_id"},{"name":"materialId","kind":"scalar","type":"String","dbName":"material_id"},{"name":"quantity","kind":"scalar","type":"Decimal"},{"name":"unitOfMeasure","kind":"scalar","type":"String","dbName":"unit_of_measure"},{"name":"requisition","kind":"object","type":"Requisition","relationName":"RequisitionToRequisitionItem"},{"name":"material","kind":"object","type":"Material","relationName":"MaterialToRequisitionItem"}],"dbName":"requisition_items"},"PurchaseOrder":{"fields":[{"name":"id","kind":"scalar","type":"String"},{"name":"number","kind":"scalar","type":"String"},{"name":"supplierId","kind":"scalar","type":"String","dbName":"supplier_id"},{"name":"requisitionId","kind":"scalar","type":"String","dbName":"requisition_id"},{"name":"createdById","kind":"scalar","type":"String","dbName":"created_by_id"},{"name":"status","kind":"enum","type":"PurchaseOrderStatus"},{"name":"orderDate","kind":"scalar","type":"DateTime","dbName":"order_date"},{"name":"expectedDelivery","kind":"scalar","type":"DateTime","dbName":"expected_delivery"},{"name":"notes","kind":"scalar","type":"String"},{"name":"createdAt","kind":"scalar","type":"DateTime","dbName":"created_at"},{"name":"updatedAt","kind":"scalar","type":"DateTime","dbName":"updated_at"},{"name":"supplier","kind":"object","type":"Supplier","relationName":"PurchaseOrderToSupplier"},{"name":"requisition","kind":"object","type":"Requisition","relationName":"PurchaseOrderToRequisition"},{"name":"createdBy","kind":"object","type":"User","relationName":"PurchaseOrderToUser"},{"name":"items","kind":"object","type":"PurchaseOrderItem","relationName":"PurchaseOrderToPurchaseOrderItem"},{"name":"goodsReceipts","kind":"object","type":"GoodsReceipt","relationName":"GoodsReceiptToPurchaseOrder"}],"dbName":"purchase_orders"},"PurchaseOrderItem":{"fields":[{"name":"id","kind":"scalar","type":"String"},{"name":"poId","kind":"scalar","type":"String","dbName":"po_id"},{"name":"materialId","kind":"scalar","type":"String","dbName":"material_id"},{"name":"quantity","kind":"scalar","type":"Decimal"},{"name":"unitCost","kind":"scalar","type":"Decimal","dbName":"unit_cost"},{"name":"receivedQty","kind":"scalar","type":"Decimal","dbName":"received_qty"},{"name":"unitOfMeasure","kind":"scalar","type":"String","dbName":"unit_of_measure"},{"name":"po","kind":"object","type":"PurchaseOrder","relationName":"PurchaseOrderToPurchaseOrderItem"},{"name":"material","kind":"object","type":"Material","relationName":"MaterialToPurchaseOrderItem"}],"dbName":"purchase_order_items"},"GoodsReceipt":{"fields":[{"name":"id","kind":"scalar","type":"String"},{"name":"number","kind":"scalar","type":"String"},{"name":"poId","kind":"scalar","type":"String","dbName":"po_id"},{"name":"receivedById","kind":"scalar","type":"String","dbName":"received_by_id"},{"name":"status","kind":"enum","type":"GoodsReceiptStatus"},{"name":"receivedAt","kind":"scalar","type":"DateTime","dbName":"received_at"},{"name":"notes","kind":"scalar","type":"String"},{"name":"createdAt","kind":"scalar","type":"DateTime","dbName":"created_at"},{"name":"po","kind":"object","type":"PurchaseOrder","relationName":"GoodsReceiptToPurchaseOrder"},{"name":"receivedBy","kind":"object","type":"User","relationName":"GoodsReceiptToUser"},{"name":"items","kind":"object","type":"GoodsReceiptItem","relationName":"GoodsReceiptToGoodsReceiptItem"}],"dbName":"goods_receipts"},"GoodsReceiptItem":{"fields":[{"name":"id","kind":"scalar","type":"String"},{"name":"grnId","kind":"scalar","type":"String","dbName":"grn_id"},{"name":"materialId","kind":"scalar","type":"String","dbName":"material_id"},{"name":"batchLotId","kind":"scalar","type":"String","dbName":"batch_lot_id"},{"name":"quantity","kind":"scalar","type":"Decimal"},{"name":"unitOfMeasure","kind":"scalar","type":"String","dbName":"unit_of_measure"},{"name":"grn","kind":"object","type":"GoodsReceipt","relationName":"GoodsReceiptToGoodsReceiptItem"},{"name":"material","kind":"object","type":"Material","relationName":"GoodsReceiptItemToMaterial"},{"name":"batchLot","kind":"object","type":"BatchLot","relationName":"BatchLotToGoodsReceiptItem"}],"dbName":"goods_receipt_items"},"Bom":{"fields":[{"name":"id","kind":"scalar","type":"String"},{"name":"productName","kind":"scalar","type":"String","dbName":"product_name"},{"name":"description","kind":"scalar","type":"String"},{"name":"createdAt","kind":"scalar","type":"DateTime","dbName":"created_at"},{"name":"updatedAt","kind":"scalar","type":"DateTime","dbName":"updated_at"},{"name":"versions","kind":"object","type":"BomVersion","relationName":"BomToBomVersion"}],"dbName":"boms"},"BomVersion":{"fields":[{"name":"id","kind":"scalar","type":"String"},{"name":"bomId","kind":"scalar","type":"String","dbName":"bom_id"},{"name":"version","kind":"scalar","type":"Int"},{"name":"description","kind":"scalar","type":"String"},{"name":"expectedYield","kind":"scalar","type":"Decimal","dbName":"expected_yield"},{"name":"yieldUnit","kind":"scalar","type":"String","dbName":"yield_unit"},{"name":"finishedSkuId","kind":"scalar","type":"String","dbName":"finished_sku_id"},{"name":"status","kind":"enum","type":"BomStatus"},{"name":"createdAt","kind":"scalar","type":"DateTime","dbName":"created_at"},{"name":"bom","kind":"object","type":"Bom","relationName":"BomToBomVersion"},{"name":"finishedSku","kind":"object","type":"Material","relationName":"BomVersionToMaterial"},{"name":"ingredients","kind":"object","type":"BomIngredient","relationName":"BomIngredientToBomVersion"},{"name":"productionOrders","kind":"object","type":"ProductionOrder","relationName":"BomVersionToProductionOrder"}],"dbName":"bom_versions"},"BomIngredient":{"fields":[{"name":"id","kind":"scalar","type":"String"},{"name":"bomVersionId","kind":"scalar","type":"String","dbName":"bom_version_id"},{"name":"materialId","kind":"scalar","type":"String","dbName":"material_id"},{"name":"quantity","kind":"scalar","type":"Decimal"},{"name":"unitOfMeasure","kind":"scalar","type":"String","dbName":"unit_of_measure"},{"name":"isPercentage","kind":"scalar","type":"Boolean","dbName":"is_percentage"},{"name":"bomVersion","kind":"object","type":"BomVersion","relationName":"BomIngredientToBomVersion"},{"name":"material","kind":"object","type":"Material","relationName":"BomIngredientToMaterial"}],"dbName":"bom_ingredients"},"Machine":{"fields":[{"name":"id","kind":"scalar","type":"String"},{"name":"name","kind":"scalar","type":"String"},{"name":"code","kind":"scalar","type":"String"},{"name":"status","kind":"enum","type":"RecordStatus"},{"name":"productionOrders","kind":"object","type":"ProductionOrder","relationName":"MachineToProductionOrder"}],"dbName":"machines"},"Shift":{"fields":[{"name":"id","kind":"scalar","type":"String"},{"name":"name","kind":"scalar","type":"String"},{"name":"startTime","kind":"scalar","type":"String","dbName":"start_time"},{"name":"endTime","kind":"scalar","type":"String","dbName":"end_time"},{"name":"productionOrders","kind":"object","type":"ProductionOrder","relationName":"ProductionOrderToShift"}],"dbName":"shifts"},"ProductionOrder":{"fields":[{"name":"id","kind":"scalar","type":"String"},{"name":"orderNumber","kind":"scalar","type":"String"},{"name":"bomVersionId","kind":"scalar","type":"String","dbName":"bom_version_id"},{"name":"targetQuantity","kind":"scalar","type":"Decimal","dbName":"target_quantity"},{"name":"actualYield","kind":"scalar","type":"Decimal","dbName":"actual_yield"},{"name":"status","kind":"enum","type":"ProductionOrderStatus"},{"name":"scheduledStart","kind":"scalar","type":"DateTime","dbName":"scheduled_start"},{"name":"actualEnd","kind":"scalar","type":"DateTime","dbName":"actual_end"},{"name":"machineId","kind":"scalar","type":"String","dbName":"machine_id"},{"name":"shiftId","kind":"scalar","type":"String","dbName":"shift_id"},{"name":"createdById","kind":"scalar","type":"String","dbName":"created_by_id"},{"name":"finishedBatchId","kind":"scalar","type":"String","dbName":"finished_batch_id"},{"name":"createdAt","kind":"scalar","type":"DateTime","dbName":"created_at"},{"name":"updatedAt","kind":"scalar","type":"DateTime","dbName":"updated_at"},{"name":"bomVersion","kind":"object","type":"BomVersion","relationName":"BomVersionToProductionOrder"},{"name":"machine","kind":"object","type":"Machine","relationName":"MachineToProductionOrder"},{"name":"shift","kind":"object","type":"Shift","relationName":"ProductionOrderToShift"},{"name":"createdBy","kind":"object","type":"User","relationName":"ProductionOrderToUser"},{"name":"finishedBatch","kind":"object","type":"BatchLot","relationName":"finished_batch"}],"dbName":"production_orders"},"InspectionRecord":{"fields":[{"name":"id","kind":"scalar","type":"String"},{"name":"inspectionType","kind":"scalar","type":"String","dbName":"inspection_type"},{"name":"materialId","kind":"scalar","type":"String","dbName":"material_id"},{"name":"batchLotId","kind":"scalar","type":"String","dbName":"batch_lot_id"},{"name":"referenceId","kind":"scalar","type":"String","dbName":"reference_id"},{"name":"result","kind":"enum","type":"InspectionResult"},{"name":"notes","kind":"scalar","type":"String"},{"name":"inspectedById","kind":"scalar","type":"String","dbName":"inspected_by_id"},{"name":"inspectedAt","kind":"scalar","type":"DateTime","dbName":"inspected_at"},{"name":"createdAt","kind":"scalar","type":"DateTime","dbName":"created_at"},{"name":"material","kind":"object","type":"Material","relationName":"InspectionRecordToMaterial"},{"name":"batchLot","kind":"object","type":"BatchLot","relationName":"BatchLotToInspectionRecord"},{"name":"inspector","kind":"object","type":"User","relationName":"InspectionRecordToUser"}],"dbName":"inspection_records"},"Notification":{"fields":[{"name":"id","kind":"scalar","type":"String"},{"name":"userId","kind":"scalar","type":"String","dbName":"user_id"},{"name":"title","kind":"scalar","type":"String"},{"name":"body","kind":"scalar","type":"String"},{"name":"type","kind":"scalar","type":"String"},{"name":"isRead","kind":"scalar","type":"Boolean","dbName":"is_read"},{"name":"createdAt","kind":"scalar","type":"DateTime","dbName":"created_at"},{"name":"user","kind":"object","type":"User","relationName":"NotificationToUser"}],"dbName":"notifications"}},"enums":{},"types":{}}');
config.parameterizationSchema = {
  strings: JSON.parse('["where","orderBy","cursor","requestedBy","requisition","material","batchLot","warehouse","zone","transactions","_count","bins","zones","bin","createdBy","approvedBy","versions","bom","finishedSku","bomVersion","ingredients","productionOrders","machine","shift","finishedBatch","purchaseOrders","supplier","materials","po","items","goodsReceipts","receivedBy","grn","grnItems","inspector","inspections","batches","bomIngredients","bomOutputs","requisitionItems","poItems","inspectionRecords","suppliers","requisitions","createdTransactions","approvedAdjustments","user","notifications","User.findUnique","User.findUniqueOrThrow","User.findFirst","User.findFirstOrThrow","User.findMany","data","User.createOne","User.createMany","User.createManyAndReturn","User.updateOne","User.updateMany","User.updateManyAndReturn","create","update","User.upsertOne","User.deleteOne","User.deleteMany","having","_min","_max","User.groupBy","User.aggregate","RolePermission.findUnique","RolePermission.findUniqueOrThrow","RolePermission.findFirst","RolePermission.findFirstOrThrow","RolePermission.findMany","RolePermission.createOne","RolePermission.createMany","RolePermission.createManyAndReturn","RolePermission.updateOne","RolePermission.updateMany","RolePermission.updateManyAndReturn","RolePermission.upsertOne","RolePermission.deleteOne","RolePermission.deleteMany","RolePermission.groupBy","RolePermission.aggregate","Material.findUnique","Material.findUniqueOrThrow","Material.findFirst","Material.findFirstOrThrow","Material.findMany","Material.createOne","Material.createMany","Material.createManyAndReturn","Material.updateOne","Material.updateMany","Material.updateManyAndReturn","Material.upsertOne","Material.deleteOne","Material.deleteMany","_avg","_sum","Material.groupBy","Material.aggregate","Warehouse.findUnique","Warehouse.findUniqueOrThrow","Warehouse.findFirst","Warehouse.findFirstOrThrow","Warehouse.findMany","Warehouse.createOne","Warehouse.createMany","Warehouse.createManyAndReturn","Warehouse.updateOne","Warehouse.updateMany","Warehouse.updateManyAndReturn","Warehouse.upsertOne","Warehouse.deleteOne","Warehouse.deleteMany","Warehouse.groupBy","Warehouse.aggregate","Zone.findUnique","Zone.findUniqueOrThrow","Zone.findFirst","Zone.findFirstOrThrow","Zone.findMany","Zone.createOne","Zone.createMany","Zone.createManyAndReturn","Zone.updateOne","Zone.updateMany","Zone.updateManyAndReturn","Zone.upsertOne","Zone.deleteOne","Zone.deleteMany","Zone.groupBy","Zone.aggregate","WarehouseBin.findUnique","WarehouseBin.findUniqueOrThrow","WarehouseBin.findFirst","WarehouseBin.findFirstOrThrow","WarehouseBin.findMany","WarehouseBin.createOne","WarehouseBin.createMany","WarehouseBin.createManyAndReturn","WarehouseBin.updateOne","WarehouseBin.updateMany","WarehouseBin.updateManyAndReturn","WarehouseBin.upsertOne","WarehouseBin.deleteOne","WarehouseBin.deleteMany","WarehouseBin.groupBy","WarehouseBin.aggregate","Supplier.findUnique","Supplier.findUniqueOrThrow","Supplier.findFirst","Supplier.findFirstOrThrow","Supplier.findMany","Supplier.createOne","Supplier.createMany","Supplier.createManyAndReturn","Supplier.updateOne","Supplier.updateMany","Supplier.updateManyAndReturn","Supplier.upsertOne","Supplier.deleteOne","Supplier.deleteMany","Supplier.groupBy","Supplier.aggregate","MaterialSupplier.findUnique","MaterialSupplier.findUniqueOrThrow","MaterialSupplier.findFirst","MaterialSupplier.findFirstOrThrow","MaterialSupplier.findMany","MaterialSupplier.createOne","MaterialSupplier.createMany","MaterialSupplier.createManyAndReturn","MaterialSupplier.updateOne","MaterialSupplier.updateMany","MaterialSupplier.updateManyAndReturn","MaterialSupplier.upsertOne","MaterialSupplier.deleteOne","MaterialSupplier.deleteMany","MaterialSupplier.groupBy","MaterialSupplier.aggregate","BatchLot.findUnique","BatchLot.findUniqueOrThrow","BatchLot.findFirst","BatchLot.findFirstOrThrow","BatchLot.findMany","BatchLot.createOne","BatchLot.createMany","BatchLot.createManyAndReturn","BatchLot.updateOne","BatchLot.updateMany","BatchLot.updateManyAndReturn","BatchLot.upsertOne","BatchLot.deleteOne","BatchLot.deleteMany","BatchLot.groupBy","BatchLot.aggregate","InventoryTransaction.findUnique","InventoryTransaction.findUniqueOrThrow","InventoryTransaction.findFirst","InventoryTransaction.findFirstOrThrow","InventoryTransaction.findMany","InventoryTransaction.createOne","InventoryTransaction.createMany","InventoryTransaction.createManyAndReturn","InventoryTransaction.updateOne","InventoryTransaction.updateMany","InventoryTransaction.updateManyAndReturn","InventoryTransaction.upsertOne","InventoryTransaction.deleteOne","InventoryTransaction.deleteMany","InventoryTransaction.groupBy","InventoryTransaction.aggregate","Requisition.findUnique","Requisition.findUniqueOrThrow","Requisition.findFirst","Requisition.findFirstOrThrow","Requisition.findMany","Requisition.createOne","Requisition.createMany","Requisition.createManyAndReturn","Requisition.updateOne","Requisition.updateMany","Requisition.updateManyAndReturn","Requisition.upsertOne","Requisition.deleteOne","Requisition.deleteMany","Requisition.groupBy","Requisition.aggregate","RequisitionItem.findUnique","RequisitionItem.findUniqueOrThrow","RequisitionItem.findFirst","RequisitionItem.findFirstOrThrow","RequisitionItem.findMany","RequisitionItem.createOne","RequisitionItem.createMany","RequisitionItem.createManyAndReturn","RequisitionItem.updateOne","RequisitionItem.updateMany","RequisitionItem.updateManyAndReturn","RequisitionItem.upsertOne","RequisitionItem.deleteOne","RequisitionItem.deleteMany","RequisitionItem.groupBy","RequisitionItem.aggregate","PurchaseOrder.findUnique","PurchaseOrder.findUniqueOrThrow","PurchaseOrder.findFirst","PurchaseOrder.findFirstOrThrow","PurchaseOrder.findMany","PurchaseOrder.createOne","PurchaseOrder.createMany","PurchaseOrder.createManyAndReturn","PurchaseOrder.updateOne","PurchaseOrder.updateMany","PurchaseOrder.updateManyAndReturn","PurchaseOrder.upsertOne","PurchaseOrder.deleteOne","PurchaseOrder.deleteMany","PurchaseOrder.groupBy","PurchaseOrder.aggregate","PurchaseOrderItem.findUnique","PurchaseOrderItem.findUniqueOrThrow","PurchaseOrderItem.findFirst","PurchaseOrderItem.findFirstOrThrow","PurchaseOrderItem.findMany","PurchaseOrderItem.createOne","PurchaseOrderItem.createMany","PurchaseOrderItem.createManyAndReturn","PurchaseOrderItem.updateOne","PurchaseOrderItem.updateMany","PurchaseOrderItem.updateManyAndReturn","PurchaseOrderItem.upsertOne","PurchaseOrderItem.deleteOne","PurchaseOrderItem.deleteMany","PurchaseOrderItem.groupBy","PurchaseOrderItem.aggregate","GoodsReceipt.findUnique","GoodsReceipt.findUniqueOrThrow","GoodsReceipt.findFirst","GoodsReceipt.findFirstOrThrow","GoodsReceipt.findMany","GoodsReceipt.createOne","GoodsReceipt.createMany","GoodsReceipt.createManyAndReturn","GoodsReceipt.updateOne","GoodsReceipt.updateMany","GoodsReceipt.updateManyAndReturn","GoodsReceipt.upsertOne","GoodsReceipt.deleteOne","GoodsReceipt.deleteMany","GoodsReceipt.groupBy","GoodsReceipt.aggregate","GoodsReceiptItem.findUnique","GoodsReceiptItem.findUniqueOrThrow","GoodsReceiptItem.findFirst","GoodsReceiptItem.findFirstOrThrow","GoodsReceiptItem.findMany","GoodsReceiptItem.createOne","GoodsReceiptItem.createMany","GoodsReceiptItem.createManyAndReturn","GoodsReceiptItem.updateOne","GoodsReceiptItem.updateMany","GoodsReceiptItem.updateManyAndReturn","GoodsReceiptItem.upsertOne","GoodsReceiptItem.deleteOne","GoodsReceiptItem.deleteMany","GoodsReceiptItem.groupBy","GoodsReceiptItem.aggregate","Bom.findUnique","Bom.findUniqueOrThrow","Bom.findFirst","Bom.findFirstOrThrow","Bom.findMany","Bom.createOne","Bom.createMany","Bom.createManyAndReturn","Bom.updateOne","Bom.updateMany","Bom.updateManyAndReturn","Bom.upsertOne","Bom.deleteOne","Bom.deleteMany","Bom.groupBy","Bom.aggregate","BomVersion.findUnique","BomVersion.findUniqueOrThrow","BomVersion.findFirst","BomVersion.findFirstOrThrow","BomVersion.findMany","BomVersion.createOne","BomVersion.createMany","BomVersion.createManyAndReturn","BomVersion.updateOne","BomVersion.updateMany","BomVersion.updateManyAndReturn","BomVersion.upsertOne","BomVersion.deleteOne","BomVersion.deleteMany","BomVersion.groupBy","BomVersion.aggregate","BomIngredient.findUnique","BomIngredient.findUniqueOrThrow","BomIngredient.findFirst","BomIngredient.findFirstOrThrow","BomIngredient.findMany","BomIngredient.createOne","BomIngredient.createMany","BomIngredient.createManyAndReturn","BomIngredient.updateOne","BomIngredient.updateMany","BomIngredient.updateManyAndReturn","BomIngredient.upsertOne","BomIngredient.deleteOne","BomIngredient.deleteMany","BomIngredient.groupBy","BomIngredient.aggregate","Machine.findUnique","Machine.findUniqueOrThrow","Machine.findFirst","Machine.findFirstOrThrow","Machine.findMany","Machine.createOne","Machine.createMany","Machine.createManyAndReturn","Machine.updateOne","Machine.updateMany","Machine.updateManyAndReturn","Machine.upsertOne","Machine.deleteOne","Machine.deleteMany","Machine.groupBy","Machine.aggregate","Shift.findUnique","Shift.findUniqueOrThrow","Shift.findFirst","Shift.findFirstOrThrow","Shift.findMany","Shift.createOne","Shift.createMany","Shift.createManyAndReturn","Shift.updateOne","Shift.updateMany","Shift.updateManyAndReturn","Shift.upsertOne","Shift.deleteOne","Shift.deleteMany","Shift.groupBy","Shift.aggregate","ProductionOrder.findUnique","ProductionOrder.findUniqueOrThrow","ProductionOrder.findFirst","ProductionOrder.findFirstOrThrow","ProductionOrder.findMany","ProductionOrder.createOne","ProductionOrder.createMany","ProductionOrder.createManyAndReturn","ProductionOrder.updateOne","ProductionOrder.updateMany","ProductionOrder.updateManyAndReturn","ProductionOrder.upsertOne","ProductionOrder.deleteOne","ProductionOrder.deleteMany","ProductionOrder.groupBy","ProductionOrder.aggregate","InspectionRecord.findUnique","InspectionRecord.findUniqueOrThrow","InspectionRecord.findFirst","InspectionRecord.findFirstOrThrow","InspectionRecord.findMany","InspectionRecord.createOne","InspectionRecord.createMany","InspectionRecord.createManyAndReturn","InspectionRecord.updateOne","InspectionRecord.updateMany","InspectionRecord.updateManyAndReturn","InspectionRecord.upsertOne","InspectionRecord.deleteOne","InspectionRecord.deleteMany","InspectionRecord.groupBy","InspectionRecord.aggregate","Notification.findUnique","Notification.findUniqueOrThrow","Notification.findFirst","Notification.findFirstOrThrow","Notification.findMany","Notification.createOne","Notification.createMany","Notification.createManyAndReturn","Notification.updateOne","Notification.updateMany","Notification.updateManyAndReturn","Notification.upsertOne","Notification.deleteOne","Notification.deleteMany","Notification.groupBy","Notification.aggregate","AND","OR","NOT","id","userId","title","body","type","isRead","createdAt","equals","in","notIn","lt","lte","gt","gte","not","contains","startsWith","endsWith","inspectionType","materialId","batchLotId","referenceId","InspectionResult","result","notes","inspectedById","inspectedAt","orderNumber","bomVersionId","targetQuantity","actualYield","ProductionOrderStatus","status","scheduledStart","actualEnd","machineId","shiftId","createdById","finishedBatchId","updatedAt","name","startTime","endTime","every","some","none","code","RecordStatus","quantity","unitOfMeasure","isPercentage","bomId","version","description","expectedYield","yieldUnit","finishedSkuId","BomStatus","productName","grnId","number","poId","receivedById","GoodsReceiptStatus","receivedAt","unitCost","receivedQty","supplierId","requisitionId","PurchaseOrderStatus","orderDate","expectedDelivery","requestedById","RequisitionStatus","LedgerEventType","eventType","warehouseId","binId","referenceType","approvedById","batchNumber","manufacturingDate","expiryDate","BatchStatus","contactPerson","email","phone","address","taxId","zoneId","sku","MaterialType","category","barcode","shelfLifeDays","requiresLot","attachments","string_contains","string_starts_with","string_ends_with","array_starts_with","array_ends_with","array_contains","UserRole","role","module","canCreate","canRead","canUpdate","canDelete","canApprove","role_module","username","passwordHash","fullName","phoneNumber","isActive","materialId_supplierId","bomId_version","zoneId_code","warehouseId_code","materialId_batchNumber","is","isNot","connectOrCreate","upsert","createMany","set","disconnect","delete","connect","updateMany","deleteMany","increment","decrement","multiply","divide"]'),
  graph: "-A3fAYADFRUAAOMFACAZAACRBgAgHgAAyQYAICMAAK0GACArAADaBgAgLAAAmQYAIC0AAJkGACAvAADbBgAguAMAANkGADC5AwAAJQAQugMAANkGADC7AwEAAAABwQNAAPUFACHiA0AA9QUAIZAEAQAAAAGjBAAAswajBCKrBAEAAAABrAQBAOIFACGtBAEA4gUAIa4EAQD0BQAhrwQgAKYGACEBAAAAAQAgDQMAALcGACAZAACRBgAgHQAAqgYAILgDAADqBgAwuQMAAAMAELoDAADqBgAwuwMBAOIFACHBA0AA9QUAIdMDAQD0BQAh2wMAAOsGhQQi4gNAAPUFACH3AwEA4gUAIYMEAQDiBQAhBAMAAIcMACAZAADbCQAgHQAAmwsAINMDAADsBgAgDQMAALcGACAZAACRBgAgHQAAqgYAILgDAADqBgAwuQMAAAMAELoDAADqBgAwuwMBAAAAAcEDQAD1BQAh0wMBAPQFACHbAwAA6waFBCLiA0AA9QUAIfcDAQAAAAGDBAEA4gUAIQMAAAADACABAAAEADACAAAFACAKBAAA6QYAIAUAALsGACC4AwAA6AYAMLkDAAAHABC6AwAA6AYAMLsDAQDiBQAhzgMBAOIFACHrAxAAwgYAIewDAQDiBQAh_wMBAOIFACECBAAAjAwAIAUAAIgMACAKBAAA6QYAIAUAALsGACC4AwAA6AYAMLkDAAAHABC6AwAA6AYAMLsDAQAAAAHOAwEA4gUAIesDEADCBgAh7AMBAOIFACH_AwEA4gUAIQMAAAAHACABAAAIADACAAAJACAQBQAAuwYAIAkAAJkGACAVAADjBQAgIQAArAYAICMAAK0GACC4AwAA5gYAMLkDAAALABC6AwAA5gYAMLsDAQDiBQAhwQNAAPUFACHOAwEA4gUAIdMDAQD0BQAh2wMAAOcGjwQiiwQBAOIFACGMBEAAugYAIY0EQAC6BgAhCAUAAIgMACAJAACrCgAgFQAApAcAICEAAJ0LACAjAACeCwAg0wMAAOwGACCMBAAA7AYAII0EAADsBgAgEQUAALsGACAJAACZBgAgFQAA4wUAICEAAKwGACAjAACtBgAguAMAAOYGADC5AwAACwAQugMAAOYGADC7AwEAAAABwQNAAPUFACHOAwEA4gUAIdMDAQD0BQAh2wMAAOcGjwQiiwQBAOIFACGMBEAAugYAIY0EQAC6BgAhtAQAAOUGACADAAAACwAgAQAADAAwAgAADQAgFwUAALsGACAGAAC8BgAgBwAA3wYAIA0AAOQGACAOAAC3BgAgDwAAvQYAILgDAADiBgAwuQMAAA8AELoDAADiBgAwuwMBAOIFACHBA0AA9QUAIc4DAQDiBQAhzwMBAPQFACHQAwEA9AUAIdMDAQD0BQAh4AMBAOIFACHrAxAAwgYAIewDAQDiBQAhhgQAAOMGhgQihwQBAOIFACGIBAEA9AUAIYkEAQD0BQAhigQBAPQFACEMBQAAiAwAIAYAAIkMACAHAACTDAAgDQAAlAwAIA4AAIcMACAPAACHDAAgzwMAAOwGACDQAwAA7AYAINMDAADsBgAgiAQAAOwGACCJBAAA7AYAIIoEAADsBgAgFwUAALsGACAGAAC8BgAgBwAA3wYAIA0AAOQGACAOAAC3BgAgDwAAvQYAILgDAADiBgAwuQMAAA8AELoDAADiBgAwuwMBAAAAAcEDQAD1BQAhzgMBAOIFACHPAwEA9AUAIdADAQD0BQAh0wMBAPQFACHgAwEA4gUAIesDEADCBgAh7AMBAOIFACGGBAAA4waGBCKHBAEA4gUAIYgEAQD0BQAhiQQBAPQFACGKBAEA9AUAIQMAAAAPACABAAAQADACAAARACABAAAACwAgCgcAAN8GACALAACYBgAguAMAAOEGADC5AwAAFAAQugMAAOEGADC7AwEA4gUAIdsDAADpBesDIuMDAQDiBQAh6QMBAOIFACGHBAEA4gUAIQIHAACTDAAgCwAAqgoAIAsHAADfBgAgCwAAmAYAILgDAADhBgAwuQMAABQAELoDAADhBgAwuwMBAAAAAdsDAADpBesDIuMDAQDiBQAh6QMBAOIFACGHBAEA4gUAIbMEAADgBgAgAwAAABQAIAEAABUAMAIAABYAIAwHAADfBgAgCAAA3gYAIAkAAJkGACC4AwAA3QYAMLkDAAAYABC6AwAA3QYAMLsDAQDiBQAh2wMAAOkF6wMi4wMBAOIFACHpAwEA4gUAIYcEAQDiBQAhlAQBAOIFACEDBwAAkwwAIAgAAJIMACAJAACrCgAgDQcAAN8GACAIAADeBgAgCQAAmQYAILgDAADdBgAwuQMAABgAELoDAADdBgAwuwMBAAAAAdsDAADpBesDIuMDAQDiBQAh6QMBAOIFACGHBAEA4gUAIZQEAQDiBQAhsgQAANwGACADAAAAGAAgAQAAGQAwAgAAGgAgAwAAAA8AIAEAABAAMAIAABEAIAEAAAAPACABAAAAGAAgAwAAABgAIAEAABkAMAIAABoAIAMAAAAPACABAAAQADACAAARACABAAAAFAAgAQAAABgAIAEAAAAPACABAAAAGAAgFRUAAOMFACAZAACRBgAgHgAAyQYAICMAAK0GACArAADaBgAgLAAAmQYAIC0AAJkGACAvAADbBgAguAMAANkGADC5AwAAJQAQugMAANkGADC7AwEA4gUAIcEDQAD1BQAh4gNAAPUFACGQBAEA4gUAIaMEAACzBqMEIqsEAQDiBQAhrAQBAOIFACGtBAEA4gUAIa4EAQD0BQAhrwQgAKYGACEBAAAAJQAgFg4AALcGACATAADOBgAgFgAA1wYAIBcAANgGACAYAAC8BgAguAMAANQGADC5AwAAJwAQugMAANQGADC7AwEA4gUAIcEDQAD1BQAh1gMBAOIFACHXAwEA4gUAIdgDEADCBgAh2QMQANUGACHbAwAA1gbbAyLcA0AAugYAId0DQAC6BgAh3gMBAPQFACHfAwEA9AUAIeADAQDiBQAh4QMBAPQFACHiA0AA9QUAIQsOAACHDAAgEwAAjgwAIBYAAJAMACAXAACRDAAgGAAAiQwAINkDAADsBgAg3AMAAOwGACDdAwAA7AYAIN4DAADsBgAg3wMAAOwGACDhAwAA7AYAIBYOAAC3BgAgEwAAzgYAIBYAANcGACAXAADYBgAgGAAAvAYAILgDAADUBgAwuQMAACcAELoDAADUBgAwuwMBAAAAAcEDQAD1BQAh1gMBAAAAAdcDAQDiBQAh2AMQAMIGACHZAxAA1QYAIdsDAADWBtsDItwDQAC6BgAh3QNAALoGACHeAwEA9AUAId8DAQD0BQAh4AMBAOIFACHhAwEA9AUAIeIDQAD1BQAhAwAAACcAIAEAACgAMAIAACkAIBARAADTBgAgEgAAuwYAIBQAAKkGACAVAADjBQAguAMAANAGADC5AwAAKwAQugMAANAGADC7AwEA4gUAIcEDQAD1BQAh2wMAANIG9QMi7gMBAOIFACHvAwIA0QYAIfADAQD0BQAh8QMQAMIGACHyAwEA4gUAIfMDAQDiBQAhBREAAI8MACASAACIDAAgFAAAmgsAIBUAAKQHACDwAwAA7AYAIBERAADTBgAgEgAAuwYAIBQAAKkGACAVAADjBQAguAMAANAGADC5AwAAKwAQugMAANAGADC7AwEAAAABwQNAAPUFACHbAwAA0gb1AyLuAwEA4gUAIe8DAgDRBgAh8AMBAPQFACHxAxAAwgYAIfIDAQDiBQAh8wMBAOIFACGxBAAAzwYAIAMAAAArACABAAAsADACAAAtACABAAAAKwAgCwUAALsGACATAADOBgAguAMAAM0GADC5AwAAMAAQugMAAM0GADC7AwEA4gUAIc4DAQDiBQAh1wMBAOIFACHrAxAAwgYAIewDAQDiBQAh7QMgAKYGACECBQAAiAwAIBMAAI4MACALBQAAuwYAIBMAAM4GACC4AwAAzQYAMLkDAAAwABC6AwAAzQYAMLsDAQAAAAHOAwEA4gUAIdcDAQDiBQAh6wMQAMIGACHsAwEA4gUAIe0DIACmBgAhAwAAADAAIAEAADEAMAIAADIAIAMAAAAnACABAAAoADACAAApACABAAAAMAAgAQAAACcAIAgVAADjBQAguAMAAOgFADC5AwAANwAQugMAAOgFADC7AwEA4gUAIdsDAADpBesDIuMDAQDiBQAh6QMBAOIFACEBAAAANwAgAwAAACcAIAEAACgAMAIAACkAIAEAAAAnACAIFQAA4wUAILgDAADhBQAwuQMAADsAELoDAADhBQAwuwMBAOIFACHjAwEA4gUAIeQDAQDiBQAh5QMBAOIFACEBAAAAOwAgAwAAACcAIAEAACgAMAIAACkAIAEAAAAnACABAAAACwAgDAUAALsGACAGAADMBgAgIAAAywYAILgDAADKBgAwuQMAAEAAELoDAADKBgAwuwMBAOIFACHOAwEA4gUAIc8DAQDiBQAh6wMQAMIGACHsAwEA4gUAIfYDAQDiBQAhAwUAAIgMACAGAACJDAAgIAAAjQwAIAwFAAC7BgAgBgAAzAYAICAAAMsGACC4AwAAygYAMLkDAABAABC6AwAAygYAMLsDAQAAAAHOAwEA4gUAIc8DAQDiBQAh6wMQAMIGACHsAwEA4gUAIfYDAQDiBQAhAwAAAEAAIAEAAEEAMAIAAEIAIBMEAADIBgAgDgAAtwYAIBoAAMUGACAdAACrBgAgHgAAyQYAILgDAADGBgAwuQMAAEQAELoDAADGBgAwuwMBAOIFACHBA0AA9QUAIdMDAQD0BQAh2wMAAMcGgQQi4AMBAOIFACHiA0AA9QUAIfcDAQDiBQAh_gMBAOIFACH_AwEA9AUAIYEEQAC6BgAhggRAALoGACEJBAAAjAwAIA4AAIcMACAaAACLDAAgHQAAnAsAIB4AAIUMACDTAwAA7AYAIP8DAADsBgAggQQAAOwGACCCBAAA7AYAIBMEAADIBgAgDgAAtwYAIBoAAMUGACAdAACrBgAgHgAAyQYAILgDAADGBgAwuQMAAEQAELoDAADGBgAwuwMBAAAAAcEDQAD1BQAh0wMBAPQFACHbAwAAxwaBBCLgAwEA4gUAIeIDQAD1BQAh9wMBAAAAAf4DAQDiBQAh_wMBAPQFACGBBEAAugYAIYIEQAC6BgAhAwAAAEQAIAEAAEUAMAIAAEYAIAcFAAC7BgAgGgAAxQYAILgDAADEBgAwuQMAAEgAELoDAADEBgAwzgMBAOIFACH-AwEA4gUAIQIFAACIDAAgGgAAiwwAIAgFAAC7BgAgGgAAxQYAILgDAADEBgAwuQMAAEgAELoDAADEBgAwzgMBAOIFACH-AwEA4gUAIbAEAADDBgAgAwAAAEgAIAEAAEkAMAIAAEoAIAEAAABEACABAAAASAAgAQAAAAMAIAwFAAC7BgAgHAAAwAYAILgDAADBBgAwuQMAAE8AELoDAADBBgAwuwMBAOIFACHOAwEA4gUAIesDEADCBgAh7AMBAOIFACH4AwEA4gUAIfwDEADCBgAh_QMQAMIGACECBQAAiAwAIBwAAIoMACAMBQAAuwYAIBwAAMAGACC4AwAAwQYAMLkDAABPABC6AwAAwQYAMLsDAQAAAAHOAwEA4gUAIesDEADCBgAh7AMBAOIFACH4AwEA4gUAIfwDEADCBgAh_QMQAMIGACEDAAAATwAgAQAAUAAwAgAAUQAgDhwAAMAGACAdAACsBgAgHwAAtwYAILgDAAC-BgAwuQMAAFMAELoDAAC-BgAwuwMBAOIFACHBA0AA9QUAIdMDAQD0BQAh2wMAAL8G-wMi9wMBAOIFACH4AwEA4gUAIfkDAQDiBQAh-wNAAPUFACEEHAAAigwAIB0AAJ0LACAfAACHDAAg0wMAAOwGACAOHAAAwAYAIB0AAKwGACAfAAC3BgAguAMAAL4GADC5AwAAUwAQugMAAL4GADC7AwEAAAABwQNAAPUFACHTAwEA9AUAIdsDAAC_BvsDIvcDAQAAAAH4AwEA4gUAIfkDAQDiBQAh-wNAAPUFACEDAAAAUwAgAQAAVAAwAgAAVQAgAQAAAE8AIAEAAABTACADAAAAQAAgAQAAQQAwAgAAQgAgAQAAAEAAIBAFAAC7BgAgBgAAvAYAICIAAL0GACC4AwAAuAYAMLkDAABbABC6AwAAuAYAMLsDAQDiBQAhwQNAAPUFACHNAwEA4gUAIc4DAQDiBQAhzwMBAPQFACHQAwEA9AUAIdIDAAC5BtIDItMDAQD0BQAh1AMBAPQFACHVA0AAugYAIQgFAACIDAAgBgAAiQwAICIAAIcMACDPAwAA7AYAINADAADsBgAg0wMAAOwGACDUAwAA7AYAINUDAADsBgAgEAUAALsGACAGAAC8BgAgIgAAvQYAILgDAAC4BgAwuQMAAFsAELoDAAC4BgAwuwMBAAAAAcEDQAD1BQAhzQMBAOIFACHOAwEA4gUAIc8DAQD0BQAh0AMBAPQFACHSAwAAuQbSAyLTAwEA9AUAIdQDAQD0BQAh1QNAALoGACEDAAAAWwAgAQAAXAAwAgAAXQAgAQAAAAsAIAEAAAAlACABAAAADwAgAQAAACcAIAEAAABAACABAAAAWwAgAwAAAA8AIAEAABAAMAIAABEAIAMAAAAwACABAAAxADACAAAyACADAAAAKwAgAQAALAAwAgAALQAgAwAAAAcAIAEAAAgAMAIAAAkAIAMAAABPACABAABQADACAABRACADAAAAQAAgAQAAQQAwAgAAQgAgAwAAAFsAIAEAAFwAMAIAAF0AIAMAAABIACABAABJADACAABKACABAAAACwAgAQAAAA8AIAEAAAAwACABAAAAKwAgAQAAAAcAIAEAAABPACABAAAAQAAgAQAAAFsAIAEAAABIACADAAAARAAgAQAARQAwAgAARgAgAQAAAAcAIAEAAABEACADAAAARAAgAQAARQAwAgAARgAgAwAAAFMAIAEAAFQAMAIAAFUAIAMAAAAnACABAAAoADACAAApACADAAAAWwAgAQAAXAAwAgAAXQAgAwAAAA8AIAEAABAAMAIAABEAIAMAAAAPACABAAAQADACAAARACALLgAAtwYAILgDAAC2BgAwuQMAAH8AELoDAAC2BgAwuwMBAOIFACG8AwEA4gUAIb0DAQDiBQAhvgMBAPQFACG_AwEA4gUAIcADIACmBgAhwQNAAPUFACECLgAAhwwAIL4DAADsBgAgCy4AALcGACC4AwAAtgYAMLkDAAB_ABC6AwAAtgYAMLsDAQAAAAG8AwEA4gUAIb0DAQDiBQAhvgMBAPQFACG_AwEA4gUAIcADIACmBgAhwQNAAPUFACEDAAAAfwAgAQAAgAEAMAIAAIEBACABAAAAAwAgAQAAAEQAIAEAAABTACABAAAAJwAgAQAAAFsAIAEAAAAPACABAAAADwAgAQAAAH8AIAEAAAABACAJFQAApAcAIBkAANsJACAeAACFDAAgIwAAngsAICsAAIQMACAsAACrCgAgLQAAqwoAIC8AAIYMACCuBAAA7AYAIAMAAAAlACABAACMAQAwAgAAAQAgAwAAACUAIAEAAIwBADACAAABACADAAAAJQAgAQAAjAEAMAIAAAEAIBIVAAD_CwAgGQAA_QsAIB4AAP4LACAjAACADAAgKwAA_AsAICwAAIEMACAtAACCDAAgLwAAgwwAILsDAQAAAAHBA0AAAAAB4gNAAAAAAZAEAQAAAAGjBAAAAKMEAqsEAQAAAAGsBAEAAAABrQQBAAAAAa4EAQAAAAGvBCAAAAABATUAAJABACAKuwMBAAAAAcEDQAAAAAHiA0AAAAABkAQBAAAAAaMEAAAAowQCqwQBAAAAAawEAQAAAAGtBAEAAAABrgQBAAAAAa8EIAAAAAEBNQAAkgEAMAE1AACSAQAwEhUAAKkLACAZAACnCwAgHgAAqAsAICMAAKoLACArAACmCwAgLAAAqwsAIC0AAKwLACAvAACtCwAguwMBAPAGACHBA0AA8wYAIeIDQADzBgAhkAQBAPAGACGjBAAAogujBCKrBAEA8AYAIawEAQDwBgAhrQQBAPAGACGuBAEA8QYAIa8EIADyBgAhAgAAAAEAIDUAAJUBACAKuwMBAPAGACHBA0AA8wYAIeIDQADzBgAhkAQBAPAGACGjBAAAogujBCKrBAEA8AYAIawEAQDwBgAhrQQBAPAGACGuBAEA8QYAIa8EIADyBgAhAgAAACUAIDUAAJcBACACAAAAJQAgNQAAlwEAIAMAAAABACA8AACQAQAgPQAAlQEAIAEAAAABACABAAAAJQAgBAoAAKMLACBCAAClCwAgQwAApAsAIK4EAADsBgAgDbgDAAC1BgAwuQMAAJ4BABC6AwAAtQYAMLsDAQDBBQAhwQNAAMQFACHiA0AAxAUAIZAEAQDBBQAhowQAAK8GowQiqwQBAMEFACGsBAEAwQUAIa0EAQDBBQAhrgQBAMIFACGvBCAAwwUAIQMAAAAlACABAACdAQAwQQAAngEAIAMAAAAlACABAACMAQAwAgAAAQAgDbgDAACyBgAwuQMAAKQBABC6AwAAsgYAMLsDAQAAAAHBA0AA9QUAIaMEAACzBqMEIqQEAQDiBQAhpQQgAKYGACGmBCAApgYAIacEIACmBgAhqAQgAKYGACGpBCAApgYAIaoEAAC0BgAgAQAAAKEBACABAAAAoQEAIAy4AwAAsgYAMLkDAACkAQAQugMAALIGADC7AwEA4gUAIcEDQAD1BQAhowQAALMGowQipAQBAOIFACGlBCAApgYAIaYEIACmBgAhpwQgAKYGACGoBCAApgYAIakEIACmBgAhAAMAAACkAQAgAQAApQEAMAIAAKEBACADAAAApAEAIAEAAKUBADACAAChAQAgAwAAAKQBACABAAClAQAwAgAAoQEAIAm7AwEAAAABwQNAAAAAAaMEAAAAowQCpAQBAAAAAaUEIAAAAAGmBCAAAAABpwQgAAAAAagEIAAAAAGpBCAAAAABATUAAKkBACAJuwMBAAAAAcEDQAAAAAGjBAAAAKMEAqQEAQAAAAGlBCAAAAABpgQgAAAAAacEIAAAAAGoBCAAAAABqQQgAAAAAQE1AACrAQAwATUAAKsBADAJuwMBAPAGACHBA0AA8wYAIaMEAACiC6MEIqQEAQDwBgAhpQQgAPIGACGmBCAA8gYAIacEIADyBgAhqAQgAPIGACGpBCAA8gYAIQIAAAChAQAgNQAArgEAIAm7AwEA8AYAIcEDQADzBgAhowQAAKILowQipAQBAPAGACGlBCAA8gYAIaYEIADyBgAhpwQgAPIGACGoBCAA8gYAIakEIADyBgAhAgAAAKQBACA1AACwAQAgAgAAAKQBACA1AACwAQAgAwAAAKEBACA8AACpAQAgPQAArgEAIAEAAAChAQAgAQAAAKQBACADCgAAnwsAIEIAAKELACBDAACgCwAgDLgDAACuBgAwuQMAALcBABC6AwAArgYAMLsDAQDBBQAhwQNAAMQFACGjBAAArwajBCKkBAEAwQUAIaUEIADDBQAhpgQgAMMFACGnBCAAwwUAIagEIADDBQAhqQQgAMMFACEDAAAApAEAIAEAALYBADBBAAC3AQAgAwAAAKQBACABAAClAQAwAgAAoQEAIBkJAACZBgAgIQAArAYAICQAAKgGACAlAACpBgAgJgAA9gUAICcAAKoGACAoAACrBgAgKQAArQYAICoAAJIGACC4AwAAowYAMLkDAAC9AQAQugMAAKMGADC7AwEAAAABvwMAAKQGlwQiwQNAAPUFACHbAwAA6QXrAyLiA0AA9QUAIeMDAQDiBQAh7AMBAOIFACGVBAEAAAABlwQBAPQFACGYBAEA9AUAIZkEAgClBgAhmgQgAKYGACGbBAAApwYAIAEAAAC6AQAgAQAAALoBACAZCQAAmQYAICEAAKwGACAkAACoBgAgJQAAqQYAICYAAPYFACAnAACqBgAgKAAAqwYAICkAAK0GACAqAACSBgAguAMAAKMGADC5AwAAvQEAELoDAACjBgAwuwMBAOIFACG_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_wEAELoDAACUBgAwuwMBAMEFACHbAwAA5QXrAyLjAwEAwQUAIekDAQDBBQAhhwQBAMEFACEDAAAAFAAgAQAA_gEAMEEAAP8BACADAAAAFAAgAQAAFQAwAgAAFgAgAQAAABoAIAEAAAAaACADAAAAGAAgAQAAGQAwAgAAGgAgAwAAABgAIAEAABkAMAIAABoAIAMAAAAYACABAAAZADACAAAaACAJBwAA7QkAIAgAAOwJACAJAADuCQAguwMBAAAAAdsDAAAA6wMC4wMBAAAAAekDAQAAAAGHBAEAAAABlAQBAAAAAQE1AACHAgAgBrsDAQAAAAHbAwAAAOsDAuMDAQAAAAHpAwEAAAABhwQBAAAAAZQEAQAAAAEBNQAAiQIAMAE1AACJAgAwCQcAAOEJACAIAADgCQAgCQAA4gkAILsDAQDwBgAh2wMAAKgH6wMi4wMBAPAGACHpAwEA8AYAIYcEAQDwBgAhlAQBAPAGACECAAAAGgAgNQAAjAIAIAa7AwEA8AYAIdsDAACoB-sDIuMDAQDwBgAh6QMBAPAGACGHBAEA8AYAIZQEAQDwBgAhAgAAABgAIDUAAI4CACACAAAAGAAgNQAAjgIAIAMAAAAaACA8AACHAgAgPQAAjAIAIAEAAAAaACABAAAAGAAgAwoAAN0JACBCAADfCQAgQwAA3gkAIAm4AwAAkwYAMLkDAACVAgAQugMAAJMGADC7AwEAwQUAIdsDAADlBesDIuMDAQDBBQAh6QMBAMEFACGHBAEAwQUAIZQEAQDBBQAhAwAAABgAIAEAAJQCADBBAACVAgAgAwAAABgAIAEAABkAMAIAABoAIA8ZAACRBgAgGwAAkgYAILgDAACQBgAwuQMAAJsCABC6AwAAkAYAMLsDAQAAAAHBA0AA9QUAIdsDAADpBesDIuIDQAD1BQAh4wMBAOIFACGPBAEA9AUAIZAEAQD0BQAhkQQBAPQFACGSBAEA9AUAIZMEAQD0BQAhAQAAAJgCACABAAAAmAIAIA8ZAACRBgAgGwAAkgYAILgDAACQBgAwuQMAAJsCABC6AwAAkAYAMLsDAQDiBQAhwQNAAPUFACHbAwAA6QXrAyLiA0AA9QUAIeMDAQDiBQAhjwQBAPQFACGQBAEA9AUAIZEEAQD0BQAhkgQBAPQFACGTBAEA9AUAIQcZAADbCQAgGwAA3AkAII8EAADsBgAgkAQAAOwGACCRBAAA7AYAIJIEAADsBgAgkwQAAOwGACADAAAAmwIAIAEAAJwCADACAACYAgAgAwAAAJsCACABAACcAgAwAgAAmAIAIAMAAACbAgAgAQAAnAIAMAIAAJgCACAMGQAA2QkAIBsAANoJACC7AwEAAAABwQNAAAAAAdsDAAAA6wMC4gNAAAAAAeMDAQAAAAGPBAEAAAABkAQBAAAAAZEEAQAAAAGSBAEAAAABkwQBAAAAAQE1AACgAgAgCrsDAQAAAAHBA0AAAAAB2wMAAADrAwLiA0AAAAAB4wMBAAAAAY8EAQAAAAGQBAEAAAABkQQBAAAAAZIEAQAAAAGTBAEAAAABATUAAKICADABNQAAogIAMAwZAADCCQAgGwAAwwkAILsDAQDwBgAhwQNAAPMGACHbAwAAqAfrAyLiA0AA8wYAIeMDAQDwBgAhjwQBAPEGACGQBAEA8QYAIZEEAQDxBgAhkgQBAPEGACGTBAEA8QYAIQIAAACYAgAgNQAApQIAIAq7AwEA8AYAIcEDQADzBgAh2wMAAKgH6wMi4gNAAPMGACHjAwEA8AYAIY8EAQDxBgAhkAQBAPEGACGRBAEA8QYAIZIEAQDxBgAhkwQBAPEGACECAAAAmwIAIDUAAKcCACACAAAAmwIAIDUAAKcCACADAAAAmAIAIDwAAKACACA9AAClAgAgAQAAAJgCACABAAAAmwIAIAgKAAC_CQAgQgAAwQkAIEMAAMAJACCPBAAA7AYAIJAEAADsBgAgkQQAAOwGACCSBAAA7AYAIJMEAADsBgAgDbgDAACPBgAwuQMAAK4CABC6AwAAjwYAMLsDAQDBBQAhwQNAAMQFACHbAwAA5QXrAyLiA0AAxAUAIeMDAQDBBQAhjwQBAMIFACGQBAEAwgUAIZEEAQDCBQAhkgQBAMIFACGTBAEAwgUAIQMAAACbAgAgAQAArQIAMEEAAK4CACADAAAAmwIAIAEAAJwCADACAACYAgAgAQAAAEoAIAEAAABKACADAAAASAAgAQAASQAwAgAASgAgAwAAAEgAIAEAAEkAMAIAAEoAIAMAAABIACABAABJADACAABKACAEBQAAvQkAIBoAAL4JACDOAwEAAAAB_gMBAAAAAQE1AAC2AgAgAs4DAQAAAAH-AwEAAAABATUAALgCADABNQAAuAIAMAQFAAC7CQAgGgAAvAkAIM4DAQDwBgAh_gMBAPAGACECAAAASgAgNQAAuwIAIALOAwEA8AYAIf4DAQDwBgAhAgAAAEgAIDUAAL0CACACAAAASAAgNQAAvQIAIAMAAABKACA8AAC2AgAgPQAAuwIAIAEAAABKACABAAAASAAgAwoAALgJACBCAAC6CQAgQwAAuQkAIAW4AwAAjgYAMLkDAADEAgAQugMAAI4GADDOAwEAwQUAIf4DAQDBBQAhAwAAAEgAIAEAAMMCADBBAADEAgAgAwAAAEgAIAEAAEkAMAIAAEoAIAEAAAANACABAAAADQAgAwAAAAsAIAEAAAwAMAIAAA0AIAMAAAALACABAAAMADACAAANACADAAAACwAgAQAADAAwAgAADQAgDQUAALMJACAJAAC0CQAgFQAAtQkAICEAALYJACAjAAC3CQAguwMBAAAAAcEDQAAAAAHOAwEAAAAB0wMBAAAAAdsDAAAAjwQCiwQBAAAAAYwEQAAAAAGNBEAAAAABATUAAMwCACAIuwMBAAAAAcEDQAAAAAHOAwEAAAAB0wMBAAAAAdsDAAAAjwQCiwQBAAAAAYwEQAAAAAGNBEAAAAABATUAAM4CADABNQAAzgIAMA0FAACECQAgCQAAhQkAIBUAAIYJACAhAACHCQAgIwAAiAkAILsDAQDwBgAhwQNAAPMGACHOAwEA8AYAIdMDAQDxBgAh2wMAAIMJjwQiiwQBAPAGACGMBEAA-gYAIY0EQAD6BgAhAgAAAA0AIDUAANECACAIuwMBAPAGACHBA0AA8wYAIc4DAQDwBgAh0wMBAPEGACHbAwAAgwmPBCKLBAEA8AYAIYwEQAD6BgAhjQRAAPoGACECAAAACwAgNQAA0wIAIAIAAAALACA1AADTAgAgAwAAAA0AIDwAAMwCACA9AADRAgAgAQAAAA0AIAEAAAALACAGCgAAgAkAIEIAAIIJACBDAACBCQAg0wMAAOwGACCMBAAA7AYAII0EAADsBgAgC7gDAACKBgAwuQMAANoCABC6AwAAigYAMLsDAQDBBQAhwQNAAMQFACHOAwEAwQUAIdMDAQDCBQAh2wMAAIsGjwQiiwQBAMEFACGMBEAA0QUAIY0EQADRBQAhAwAAAAsAIAEAANkCADBBAADaAgAgAwAAAAsAIAEAAAwAMAIAAA0AIAEAAAARACABAAAAEQAgAwAAAA8AIAEAABAAMAIAABEAIAMAAAAPACABAAAQADACAAARACADAAAADwAgAQAAEAAwAgAAEQAgFAUAAPoIACAGAAD7CAAgBwAA_AgAIA0AAP0IACAOAAD-CAAgDwAA_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_wMBAAAAAQE1AACWAwAwATUAAJYDADAHBAAAyAgAIAUAAMkIACC7AwEA8AYAIc4DAQDwBgAh6wMQAIYHACHsAwEA8AYAIf8DAQDwBgAhAgAAAAkAIDUAAJkDACAFuwMBAPAGACHOAwEA8AYAIesDEACGBwAh7AMBAPAGACH_AwEA8AYAIQIAAAAHACA1AACbAwAgAgAAAAcAIDUAAJsDACADAAAACQAgPAAAlAMAID0AAJkDACABAAAACQAgAQAAAAcAIAUKAADDCAAgQgAAxggAIEMAAMUIACBkAADECAAgZQAAxwgAIAi4AwAAgQYAMLkDAACiAwAQugMAAIEGADC7AwEAwQUAIc4DAQDBBQAh6wMQANcFACHsAwEAwQUAIf8DAQDBBQAhAwAAAAcAIAEAAKEDADBBAACiAwAgAwAAAAcAIAEAAAgAMAIAAAkAIAEAAABGACABAAAARgAgAwAAAEQAIAEAAEUAMAIAAEYAIAMAAABEACABAABFADACAABGACADAAAARAAgAQAARQAwAgAARgAgEAQAAL8IACAOAADACAAgGgAAvggAIB0AAMEIACAeAADCCAAguwMBAAAAAcEDQAAAAAHTAwEAAAAB2wMAAACBBALgAwEAAAAB4gNAAAAAAfcDAQAAAAH-AwEAAAAB_wMBAAAAAYEEQAAAAAGCBEAAAAABATUAAKoDACALuwMBAAAAAcEDQAAAAAHTAwEAAAAB2wMAAACBBALgAwEAAAAB4gNAAAAAAfcDAQAAAAH-AwEAAAAB_wMBAAAAAYEEQAAAAAGCBEAAAAABATUAAKwDADABNQAArAMAMAEAAAADACAQBAAAoggAIA4AAKMIACAaAAChCAAgHQAApAgAIB4AAKUIACC7AwEA8AYAIcEDQADzBgAh0wMBAPEGACHbAwAAoAiBBCLgAwEA8AYAIeIDQADzBgAh9wMBAPAGACH-AwEA8AYAIf8DAQDxBgAhgQRAAPoGACGCBEAA-gYAIQIAAABGACA1AACwAwAgC7sDAQDwBgAhwQNAAPMGACHTAwEA8QYAIdsDAACgCIEEIuADAQDwBgAh4gNAAPMGACH3AwEA8AYAIf4DAQDwBgAh_wMBAPEGACGBBEAA-gYAIYIEQAD6BgAhAgAAAEQAIDUAALIDACACAAAARAAgNQAAsgMAIAEAAAADACADAAAARgAgPAAAqgMAID0AALADACABAAAARgAgAQAAAEQAIAcKAACdCAAgQgAAnwgAIEMAAJ4IACDTAwAA7AYAIP8DAADsBgAggQQAAOwGACCCBAAA7AYAIA64AwAA_QUAMLkDAAC6AwAQugMAAP0FADC7AwEAwQUAIcEDQADEBQAh0wMBAMIFACHbAwAA_gWBBCLgAwEAwQUAIeIDQADEBQAh9wMBAMEFACH-AwEAwQUAIf8DAQDCBQAhgQRAANEFACGCBEAA0QUAIQMAAABEACABAAC5AwAwQQAAugMAIAMAAABEACABAABFADACAABGACABAAAAUQAgAQAAAFEAIAMAAABPACABAABQADACAABRACADAAAATwAgAQAAUAAwAgAAUQAgAwAAAE8AIAEAAFAAMAIAAFEAIAkFAACcCAAgHAAAmwgAILsDAQAAAAHOAwEAAAAB6wMQAAAAAewDAQAAAAH4AwEAAAAB_AMQAAAAAf0DEAAAAAEBNQAAwgMAIAe7AwEAAAABzgMBAAAAAesDEAAAAAHsAwEAAAAB-AMBAAAAAfwDEAAAAAH9AxAAAAABATUAAMQDADABNQAAxAMAMAkFAACaCAAgHAAAmQgAILsDAQDwBgAhzgMBAPAGACHrAxAAhgcAIewDAQDwBgAh-AMBAPAGACH8AxAAhgcAIf0DEACGBwAhAgAAAFEAIDUAAMcDACAHuwMBAPAGACHOAwEA8AYAIesDEACGBwAh7AMBAPAGACH4AwEA8AYAIfwDEACGBwAh_QMQAIYHACECAAAATwAgNQAAyQMAIAIAAABPACA1AADJAwAgAwAAAFEAIDwAAMIDACA9AADHAwAgAQAAAFEAIAEAAABPACAFCgAAlAgAIEIAAJcIACBDAACWCAAgZAAAlQgAIGUAAJgIACAKuAMAAPwFADC5AwAA0AMAELoDAAD8BQAwuwMBAMEFACHOAwEAwQUAIesDEADXBQAh7AMBAMEFACH4AwEAwQUAIfwDEADXBQAh_QMQANcFACEDAAAATwAgAQAAzwMAMEEAANADACADAAAATwAgAQAAUAAwAgAAUQAgAQAAAFUAIAEAAABVACADAAAAUwAgAQAAVAAwAgAAVQAgAwAAAFMAIAEAAFQAMAIAAFUAIAMAAABTACABAABUADACAABVACALHAAAkQgAIB0AAJMIACAfAACSCAAguwMBAAAAAcEDQAAAAAHTAwEAAAAB2wMAAAD7AwL3AwEAAAAB-AMBAAAAAfkDAQAAAAH7A0AAAAABATUAANgDACAIuwMBAAAAAcEDQAAAAAHTAwEAAAAB2wMAAAD7AwL3AwEAAAAB-AMBAAAAAfkDAQAAAAH7A0AAAAABATUAANoDADABNQAA2gMAMAscAACCCAAgHQAAhAgAIB8AAIMIACC7AwEA8AYAIcEDQADzBgAh0wMBAPEGACHbAwAAgQj7AyL3AwEA8AYAIfgDAQDwBgAh-QMBAPAGACH7A0AA8wYAIQIAAABVACA1AADdAwAgCLsDAQDwBgAhwQNAAPMGACHTAwEA8QYAIdsDAACBCPsDIvcDAQDwBgAh-AMBAPAGACH5AwEA8AYAIfsDQADzBgAhAgAAAFMAIDUAAN8DACACAAAAUwAgNQAA3wMAIAMAAABVACA8AADYAwAgPQAA3QMAIAEAAABVACABAAAAUwAgBAoAAP4HACBCAACACAAgQwAA_wcAINMDAADsBgAgC7gDAAD4BQAwuQMAAOYDABC6AwAA-AUAMLsDAQDBBQAhwQNAAMQFACHTAwEAwgUAIdsDAAD5BfsDIvcDAQDBBQAh-AMBAMEFACH5AwEAwQUAIfsDQADEBQAhAwAAAFMAIAEAAOUDADBBAADmAwAgAwAAAFMAIAEAAFQAMAIAAFUAIAEAAABCACABAAAAQgAgAwAAAEAAIAEAAEEAMAIAAEIAIAMAAABAACABAABBADACAABCACADAAAAQAAgAQAAQQAwAgAAQgAgCQUAAPwHACAGAAD9BwAgIAAA-wcAILsDAQAAAAHOAwEAAAABzwMBAAAAAesDEAAAAAHsAwEAAAAB9gMBAAAAAQE1AADuAwAgBrsDAQAAAAHOAwEAAAABzwMBAAAAAesDEAAAAAHsAwEAAAAB9gMBAAAAAQE1AADwAwAwATUAAPADADAJBQAA-QcAIAYAAPoHACAgAAD4BwAguwMBAPAGACHOAwEA8AYAIc8DAQDwBgAh6wMQAIYHACHsAwEA8AYAIfYDAQDwBgAhAgAAAEIAIDUAAPMDACAGuwMBAPAGACHOAwEA8AYAIc8DAQDwBgAh6wMQAIYHACHsAwEA8AYAIfYDAQDwBgAhAgAAAEAAIDUAAPUDACACAAAAQAAgNQAA9QMAIAMAAABCACA8AADuAwAgPQAA8wMAIAEAAABCACABAAAAQAAgBQoAAPMHACBCAAD2BwAgQwAA9QcAIGQAAPQHACBlAAD3BwAgCbgDAAD3BQAwuQMAAPwDABC6AwAA9wUAMLsDAQDBBQAhzgMBAMEFACHPAwEAwQUAIesDEADXBQAh7AMBAMEFACH2AwEAwQUAIQMAAABAACABAAD7AwAwQQAA_AMAIAMAAABAACABAABBADACAABCACAJEAAA9gUAILgDAADzBQAwuQMAAIIEABC6AwAA8wUAMLsDAQAAAAHBA0AA9QUAIeIDQAD1BQAh8AMBAPQFACH1AwEA4gUAIQEAAAD_AwAgAQAAAP8DACAJEAAA9gUAILgDAADzBQAwuQMAAIIEABC6AwAA8wUAMLsDAQDiBQAhwQNAAPUFACHiA0AA9QUAIfADAQD0BQAh9QMBAOIFACECEAAA8gcAIPADAADsBgAgAwAAAIIEACABAACDBAAwAgAA_wMAIAMAAACCBAAgAQAAgwQAMAIAAP8DACADAAAAggQAIAEAAIMEADACAAD_AwAgBhAAAPEHACC7AwEAAAABwQNAAAAAAeIDQAAAAAHwAwEAAAAB9QMBAAAAAQE1AACHBAAgBbsDAQAAAAHBA0AAAAAB4gNAAAAAAfADAQAAAAH1AwEAAAABATUAAIkEADABNQAAiQQAMAYQAADkBwAguwMBAPAGACHBA0AA8wYAIeIDQADzBgAh8AMBAPEGACH1AwEA8AYAIQIAAAD_AwAgNQAAjAQAIAW7AwEA8AYAIcEDQADzBgAh4gNAAPMGACHwAwEA8QYAIfUDAQDwBgAhAgAAAIIEACA1AACOBAAgAgAAAIIEACA1AACOBAAgAwAAAP8DACA8AACHBAAgPQAAjAQAIAEAAAD_AwAgAQAAAIIEACAECgAA4QcAIEIAAOMHACBDAADiBwAg8AMAAOwGACAIuAMAAPIFADC5AwAAlQQAELoDAADyBQAwuwMBAMEFACHBA0AAxAUAIeIDQADEBQAh8AMBAMIFACH1AwEAwQUAIQMAAACCBAAgAQAAlAQAMEEAAJUEACADAAAAggQAIAEAAIMEADACAAD_AwAgAQAAAC0AIAEAAAAtACADAAAAKwAgAQAALAAwAgAALQAgAwAAACsAIAEAACwAMAIAAC0AIAMAAAArACABAAAsADACAAAtACANEQAA3QcAIBIAAN4HACAUAADfBwAgFQAA4AcAILsDAQAAAAHBA0AAAAAB2wMAAAD1AwLuAwEAAAAB7wMCAAAAAfADAQAAAAHxAxAAAAAB8gMBAAAAAfMDAQAAAAEBNQAAnQQAIAm7AwEAAAABwQNAAAAAAdsDAAAA9QMC7gMBAAAAAe8DAgAAAAHwAwEAAAAB8QMQAAAAAfIDAQAAAAHzAwEAAAABATUAAJ8EADABNQAAnwQAMA0RAADEBwAgEgAAxQcAIBQAAMYHACAVAADHBwAguwMBAPAGACHBA0AA8wYAIdsDAADDB_UDIu4DAQDwBgAh7wMCAMIHACHwAwEA8QYAIfEDEACGBwAh8gMBAPAGACHzAwEA8AYAIQIAAAAtACA1AACiBAAgCbsDAQDwBgAhwQNAAPMGACHbAwAAwwf1AyLuAwEA8AYAIe8DAgDCBwAh8AMBAPEGACHxAxAAhgcAIfIDAQDwBgAh8wMBAPAGACECAAAAKwAgNQAApAQAIAIAAAArACA1AACkBAAgAwAAAC0AIDwAAJ0EACA9AACiBAAgAQAAAC0AIAEAAAArACAGCgAAvQcAIEIAAMAHACBDAAC_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-BgAgBgAA_wYAICIAAIAHACC7AwEAAAABwQNAAAAAAc0DAQAAAAHOAwEAAAABzwMBAAAAAdADAQAAAAHSAwAAANIDAtMDAQAAAAHUAwEAAAAB1QNAAAAAAQE1AACVBQAgCrsDAQAAAAHBA0AAAAABzQMBAAAAAc4DAQAAAAHPAwEAAAAB0AMBAAAAAdIDAAAA0gMC0wMBAAAAAdQDAQAAAAHVA0AAAAABATUAAJcFADABNQAAlwUAMAEAAAALACABAAAAJQAgDQUAAPsGACAGAAD8BgAgIgAA_QYAILsDAQDwBgAhwQNAAPMGACHNAwEA8AYAIc4DAQDwBgAhzwMBAPEGACHQAwEA8QYAIdIDAAD5BtIDItMDAQDxBgAh1AMBAPEGACHVA0AA-gYAIQIAAABdACA1AACcBQAgCrsDAQDwBgAhwQNAAPMGACHNAwEA8AYAIc4DAQDwBgAhzwMBAPEGACHQAwEA8QYAIdIDAAD5BtIDItMDAQDxBgAh1AMBAPEGACHVA0AA-gYAIQIAAABbACA1AACeBQAgAgAAAFsAIDUAAJ4FACABAAAACwAgAQAAACUAIAMAAABdACA8AACVBQAgPQAAnAUAIAEAAABdACABAAAAWwAgCAoAAPYGACBCAAD4BgAgQwAA9wYAIM8DAADsBgAg0AMAAOwGACDTAwAA7AYAINQDAADsBgAg1QMAAOwGACANuAMAAM8FADC5AwAApwUAELoDAADPBQAwuwMBAMEFACHBA0AAxAUAIc0DAQDBBQAhzgMBAMEFACHPAwEAwgUAIdADAQDCBQAh0gMAANAF0gMi0wMBAMIFACHUAwEAwgUAIdUDQADRBQAhAwAAAFsAIAEAAKYFADBBAACnBQAgAwAAAFsAIAEAAFwAMAIAAF0AIAEAAACBAQAgAQAAAIEBACADAAAAfwAgAQAAgAEAMAIAAIEBACADAAAAfwAgAQAAgAEAMAIAAIEBACADAAAAfwAgAQAAgAEAMAIAAIEBACAILgAA9QYAILsDAQAAAAG8AwEAAAABvQMBAAAAAb4DAQAAAAG_AwEAAAABwAMgAAAAAcEDQAAAAAEBNQAArwUAIAe7AwEAAAABvAMBAAAAAb0DAQAAAAG-AwEAAAABvwMBAAAAAcADIAAAAAHBA0AAAAABATUAALEFADABNQAAsQUAMAguAAD0BgAguwMBAPAGACG8AwEA8AYAIb0DAQDwBgAhvgMBAPEGACG_AwEA8AYAIcADIADyBgAhwQNAAPMGACECAAAAgQEAIDUAALQFACAHuwMBAPAGACG8AwEA8AYAIb0DAQDwBgAhvgMBAPEGACG_AwEA8AYAIcADIADyBgAhwQNAAPMGACECAAAAfwAgNQAAtgUAIAIAAAB_ACA1AAC2BQAgAwAAAIEBACA8AACvBQAgPQAAtAUAIAEAAACBAQAgAQAAAH8AIAQKAADtBgAgQgAA7wYAIEMAAO4GACC-AwAA7AYAIAq4AwAAwAUAMLkDAAC9BQAQugMAAMAFADC7AwEAwQUAIbwDAQDBBQAhvQMBAMEFACG-AwEAwgUAIb8DAQDBBQAhwAMgAMMFACHBA0AAxAUAIQMAAAB_ACABAAC8BQAwQQAAvQUAIAMAAAB_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_AMAELoDAAD3BQAwuwMBAMEFACHOAwEAwQUAIc8DAQDBBQAh6wMQANcFACHsAwEAwQUAIfYDAQDBBQAhC7gDAAD4BQAwuQMAAOYDABC6AwAA-AUAMLsDAQDBBQAhwQNAAMQFACHTAwEAwgUAIdsDAAD5BfsDIvcDAQDBBQAh-AMBAMEFACH5AwEAwQUAIfsDQADEBQAhBwoAAMYFACBCAAD7BQAgQwAA-wUAIMIDAAAA-wMCwwMAAAD7AwjEAwAAAPsDCMkDAAD6BfsDIgcKAADGBQAgQgAA-wUAIEMAAPsFACDCAwAAAPsDAsMDAAAA-wMIxAMAAAD7AwjJAwAA-gX7AyIEwgMAAAD7AwLDAwAAAPsDCMQDAAAA-wMIyQMAAPsF-wMiCrgDAAD8BQAwuQMAANADABC6AwAA_AUAMLsDAQDBBQAhzgMBAMEFACHrAxAA1wUAIewDAQDBBQAh-AMBAMEFACH8AxAA1wUAIf0DEADXBQAhDrgDAAD9BQAwuQMAALoDABC6AwAA_QUAMLsDAQDBBQAhwQNAAMQFACHTAwEAwgUAIdsDAAD-BYEEIuADAQDBBQAh4gNAAMQFACH3AwEAwQUAIf4DAQDBBQAh_wMBAMIFACGBBEAA0QUAIYIEQADRBQAhBwoAAMYFACBCAACABgAgQwAAgAYAIMIDAAAAgQQCwwMAAACBBAjEAwAAAIEECMkDAAD_BYEEIgcKAADGBQAgQgAAgAYAIEMAAIAGACDCAwAAAIEEAsMDAAAAgQQIxAMAAACBBAjJAwAA_wWBBCIEwgMAAACBBALDAwAAAIEECMQDAAAAgQQIyQMAAIAGgQQiCLgDAACBBgAwuQMAAKIDABC6AwAAgQYAMLsDAQDBBQAhzgMBAMEFACHrAxAA1wUAIewDAQDBBQAh_wMBAMEFACEKuAMAAIIGADC5AwAAjAMAELoDAACCBgAwuwMBAMEFACHBA0AAxAUAIdMDAQDCBQAh2wMAAIMGhQQi4gNAAMQFACH3AwEAwQUAIYMEAQDBBQAhBwoAAMYFACBCAACFBgAgQwAAhQYAIMIDAAAAhQQCwwMAAACFBAjEAwAAAIUECMkDAACEBoUEIgcKAADGBQAgQgAAhQYAIEMAAIUGACDCAwAAAIUEAsMDAAAAhQQIxAMAAACFBAjJAwAAhAaFBCIEwgMAAACFBALDAwAAAIUECMQDAAAAhQQIyQMAAIUGhQQiEbgDAACGBgAwuQMAAPYCABC6AwAAhgYAMLsDAQDBBQAhwQNAAMQFACHOAwEAwQUAIc8DAQDCBQAh0AMBAMIFACHTAwEAwgUAIeADAQDBBQAh6wMQANcFACHsAwEAwQUAIYYEAACHBoYEIocEAQDBBQAhiAQBAMIFACGJBAEAwgUAIYoEAQDCBQAhBwoAAMYFACBCAACJBgAgQwAAiQYAIMIDAAAAhgQCwwMAAACGBAjEAwAAAIYECMkDAACIBoYEIgcKAADGBQAgQgAAiQYAIEMAAIkGACDCAwAAAIYEAsMDAAAAhgQIxAMAAACGBAjJAwAAiAaGBCIEwgMAAACGBALDAwAAAIYECMQDAAAAhgQIyQMAAIkGhgQiC7gDAACKBgAwuQMAANoCABC6AwAAigYAMLsDAQDBBQAhwQNAAMQFACHOAwEAwQUAIdMDAQDCBQAh2wMAAIsGjwQiiwQBAMEFACGMBEAA0QUAIY0EQADRBQAhBwoAAMYFACBCAACNBgAgQwAAjQYAIMIDAAAAjwQCwwMAAACPBAjEAwAAAI8ECMkDAACMBo8EIgcKAADGBQAgQgAAjQYAIEMAAI0GACDCAwAAAI8EAsMDAAAAjwQIxAMAAACPBAjJAwAAjAaPBCIEwgMAAACPBALDAwAAAI8ECMQDAAAAjwQIyQMAAI0GjwQiBbgDAACOBgAwuQMAAMQCABC6AwAAjgYAMM4DAQDBBQAh_gMBAMEFACENuAMAAI8GADC5AwAArgIAELoDAACPBgAwuwMBAMEFACHBA0AAxAUAIdsDAADlBesDIuIDQADEBQAh4wMBAMEFACGPBAEAwgUAIZAEAQDCBQAhkQQBAMIFACGSBAEAwgUAIZMEAQDCBQAhDxkAAJEGACAbAACSBgAguAMAAJAGADC5AwAAmwIAELoDAACQBgAwuwMBAOIFACHBA0AA9QUAIdsDAADpBesDIuIDQAD1BQAh4wMBAOIFACGPBAEA9AUAIZAEAQD0BQAhkQQBAPQFACGSBAEA9AUAIZMEAQD0BQAhA-YDAABEACDnAwAARAAg6AMAAEQAIAPmAwAASAAg5wMAAEgAIOgDAABIACAJuAMAAJMGADC5AwAAlQIAELoDAACTBgAwuwMBAMEFACHbAwAA5QXrAyLjAwEAwQUAIekDAQDBBQAhhwQBAMEFACGUBAEAwQUAIQi4AwAAlAYAMLkDAAD_AQAQugMAAJQGADC7AwEAwQUAIdsDAADlBesDIuMDAQDBBQAh6QMBAMEFACGHBAEAwQUAIQm4AwAAlQYAMLkDAADpAQAQugMAAJUGADC7AwEAwQUAIcEDQADEBQAh2wMAAOUF6wMi4wMBAMEFACHpAwEAwQUAIZIEAQDCBQAhDAkAAJkGACALAACYBgAgDAAAlwYAILgDAACWBgAwuQMAANYBABC6AwAAlgYAMLsDAQDiBQAhwQNAAPUFACHbAwAA6QXrAyLjAwEA4gUAIekDAQDiBQAhkgQBAPQFACED5gMAABQAIOcDAAAUACDoAwAAFAAgA-YDAAAYACDnAwAAGAAg6AMAABgAIAPmAwAADwAg5wMAAA8AIOgDAAAPACAQuAMAAJoGADC5AwAA0AEAELoDAACaBgAwuwMBAMEFACG_AwAAmwaXBCLBA0AAxAUAIdsDAADlBesDIuIDQADEBQAh4wMBAMEFACHsAwEAwQUAIZUEAQDBBQAhlwQBAMIFACGYBAEAwgUAIZkEAgCcBgAhmgQgAMMFACGbBAAAnQYAIAcKAADGBQAgQgAAogYAIEMAAKIGACDCAwAAAJcEAsMDAAAAlwQIxAMAAACXBAjJAwAAoQaXBCINCgAAywUAIEIAAMsFACBDAADLBQAgZAAAoAYAIGUAAMsFACDCAwIAAAABwwMCAAAABcQDAgAAAAXFAwIAAAABxgMCAAAAAccDAgAAAAHIAwIAAAAByQMCAJ8GACEPCgAAywUAIEIAAJ4GACBDAACeBgAgwgOAAAAAAcUDgAAAAAHGA4AAAAABxwOAAAAAAcgDgAAAAAHJA4AAAAABnAQBAAAAAZ0EAQAAAAGeBAEAAAABnwSAAAAAAaAEgAAAAAGhBIAAAAABDMIDgAAAAAHFA4AAAAABxgOAAAAAAccDgAAAAAHIA4AAAAAByQOAAAAAAZwEAQAAAAGdBAEAAAABngQBAAAAAZ8EgAAAAAGgBIAAAAABoQSAAAAAAQ0KAADLBQAgQgAAywUAIEMAAMsFACBkAACgBgAgZQAAywUAIMIDAgAAAAHDAwIAAAAFxAMCAAAABcUDAgAAAAHGAwIAAAABxwMCAAAAAcgDAgAAAAHJAwIAnwYAIQjCAwgAAAABwwMIAAAABcQDCAAAAAXFAwgAAAABxgMIAAAAAccDCAAAAAHIAwgAAAAByQMIAKAGACEHCgAAxgUAIEIAAKIGACBDAACiBgAgwgMAAACXBALDAwAAAJcECMQDAAAAlwQIyQMAAKEGlwQiBMIDAAAAlwQCwwMAAACXBAjEAwAAAJcECMkDAACiBpcEIhkJAACZBgAgIQAArAYAICQAAKgGACAlAACpBgAgJgAA9gUAICcAAKoGACAoAACrBgAgKQAArQYAICoAAJIGACC4AwAAowYAMLkDAAC9AQAQugMAAKMGADC7AwEA4gUAIb8DAACkBpcEIsEDQAD1BQAh2wMAAOkF6wMi4gNAAPUFACHjAwEA4gUAIewDAQDiBQAhlQQBAOIFACGXBAEA9AUAIZgEAQD0BQAhmQQCAKUGACGaBCAApgYAIZsEAACnBgAgBMIDAAAAlwQCwwMAAACXBAjEAwAAAJcECMkDAACiBpcEIgjCAwIAAAABwwMCAAAABcQDAgAAAAXFAwIAAAABxgMCAAAAAccDAgAAAAHIAwIAAAAByQMCAMsFACECwgMgAAAAAckDIADJBQAhDMIDgAAAAAHFA4AAAAABxgOAAAAAAccDgAAAAAHIA4AAAAAByQOAAAAAAZwEAQAAAAGdBAEAAAABngQBAAAAAZ8EgAAAAAGgBIAAAAABoQSAAAAAAQPmAwAACwAg5wMAAAsAIOgDAAALACAD5gMAADAAIOcDAAAwACDoAwAAMAAgA-YDAAAHACDnAwAABwAg6AMAAAcAIAPmAwAATwAg5wMAAE8AIOgDAABPACAD5gMAAEAAIOcDAABAACDoAwAAQAAgA-YDAABbACDnAwAAWwAg6AMAAFsAIAy4AwAArgYAMLkDAAC3AQAQugMAAK4GADC7AwEAwQUAIcEDQADEBQAhowQAAK8GowQipAQBAMEFACGlBCAAwwUAIaYEIADDBQAhpwQgAMMFACGoBCAAwwUAIakEIADDBQAhBwoAAMYFACBCAACxBgAgQwAAsQYAIMIDAAAAowQCwwMAAACjBAjEAwAAAKMECMkDAACwBqMEIgcKAADGBQAgQgAAsQYAIEMAALEGACDCAwAAAKMEAsMDAAAAowQIxAMAAACjBAjJAwAAsAajBCIEwgMAAACjBALDAwAAAKMECMQDAAAAowQIyQMAALEGowQiDLgDAACyBgAwuQMAAKQBABC6AwAAsgYAMLsDAQDiBQAhwQNAAPUFACGjBAAAswajBCKkBAEA4gUAIaUEIACmBgAhpgQgAKYGACGnBCAApgYAIagEIACmBgAhqQQgAKYGACEEwgMAAACjBALDAwAAAKMECMQDAAAAowQIyQMAALEGowQiAqMEAAAAowQCpAQBAAAAAQ24AwAAtQYAMLkDAACeAQAQugMAALUGADC7AwEAwQUAIcEDQADEBQAh4gNAAMQFACGQBAEAwQUAIaMEAACvBqMEIqsEAQDBBQAhrAQBAMEFACGtBAEAwQUAIa4EAQDCBQAhrwQgAMMFACELLgAAtwYAILgDAAC2BgAwuQMAAH8AELoDAAC2BgAwuwMBAOIFACG8AwEA4gUAIb0DAQDiBQAhvgMBAPQFACG_AwEA4gUAIcADIACmBgAhwQNAAPUFACEXFQAA4wUAIBkAAJEGACAeAADJBgAgIwAArQYAICsAANoGACAsAACZBgAgLQAAmQYAIC8AANsGACC4AwAA2QYAMLkDAAAlABC6AwAA2QYAMLsDAQDiBQAhwQNAAPUFACHiA0AA9QUAIZAEAQDiBQAhowQAALMGowQiqwQBAOIFACGsBAEA4gUAIa0EAQDiBQAhrgQBAPQFACGvBCAApgYAIbUEAAAlACC2BAAAJQAgEAUAALsGACAGAAC8BgAgIgAAvQYAILgDAAC4BgAwuQMAAFsAELoDAAC4BgAwuwMBAOIFACHBA0AA9QUAIc0DAQDiBQAhzgMBAOIFACHPAwEA9AUAIdADAQD0BQAh0gMAALkG0gMi0wMBAPQFACHUAwEA9AUAIdUDQAC6BgAhBMIDAAAA0gMCwwMAAADSAwjEAwAAANIDCMkDAADVBdIDIgjCA0AAAAABwwNAAAAABcQDQAAAAAXFA0AAAAABxgNAAAAAAccDQAAAAAHIA0AAAAAByQNAANMFACEbCQAAmQYAICEAAKwGACAkAACoBgAgJQAAqQYAICYAAPYFACAnAACqBgAgKAAAqwYAICkAAK0GACAqAACSBgAguAMAAKMGADC5AwAAvQEAELoDAACjBgAwuwMBAOIFACG_AwAApAaXBCLBA0AA9QUAIdsDAADpBesDIuIDQAD1BQAh4wMBAOIFACHsAwEA4gUAIZUEAQDiBQAhlwQBAPQFACGYBAEA9AUAIZkEAgClBgAhmgQgAKYGACGbBAAApwYAILUEAAC9AQAgtgQAAL0BACASBQAAuwYAIAkAAJkGACAVAADjBQAgIQAArAYAICMAAK0GACC4AwAA5gYAMLkDAAALABC6AwAA5gYAMLsDAQDiBQAhwQNAAPUFACHOAwEA4gUAIdMDAQD0BQAh2wMAAOcGjwQiiwQBAOIFACGMBEAAugYAIY0EQAC6BgAhtQQAAAsAILYEAAALACAXFQAA4wUAIBkAAJEGACAeAADJBgAgIwAArQYAICsAANoGACAsAACZBgAgLQAAmQYAIC8AANsGACC4AwAA2QYAMLkDAAAlABC6AwAA2QYAMLsDAQDiBQAhwQNAAPUFACHiA0AA9QUAIZAEAQDiBQAhowQAALMGowQiqwQBAOIFACGsBAEA4gUAIa0EAQDiBQAhrgQBAPQFACGvBCAApgYAIbUEAAAlACC2BAAAJQAgDhwAAMAGACAdAACsBgAgHwAAtwYAILgDAAC-BgAwuQMAAFMAELoDAAC-BgAwuwMBAOIFACHBA0AA9QUAIdMDAQD0BQAh2wMAAL8G-wMi9wMBAOIFACH4AwEA4gUAIfkDAQDiBQAh-wNAAPUFACEEwgMAAAD7AwLDAwAAAPsDCMQDAAAA-wMIyQMAAPsF-wMiFQQAAMgGACAOAAC3BgAgGgAAxQYAIB0AAKsGACAeAADJBgAguAMAAMYGADC5AwAARAAQugMAAMYGADC7AwEA4gUAIcEDQAD1BQAh0wMBAPQFACHbAwAAxwaBBCLgAwEA4gUAIeIDQAD1BQAh9wMBAOIFACH-AwEA4gUAIf8DAQD0BQAhgQRAALoGACGCBEAAugYAIbUEAABEACC2BAAARAAgDAUAALsGACAcAADABgAguAMAAMEGADC5AwAATwAQugMAAMEGADC7AwEA4gUAIc4DAQDiBQAh6wMQAMIGACHsAwEA4gUAIfgDAQDiBQAh_AMQAMIGACH9AxAAwgYAIQjCAxAAAAABwwMQAAAABMQDEAAAAATFAxAAAAABxgMQAAAAAccDEAAAAAHIAxAAAAAByQMQAN8FACECzgMBAAAAAf4DAQAAAAEHBQAAuwYAIBoAAMUGACC4AwAAxAYAMLkDAABIABC6AwAAxAYAMM4DAQDiBQAh_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_ACAC6QMBAAAAAZQEAQAAAAEMBwAA3wYAIAgAAN4GACAJAACZBgAguAMAAN0GADC5AwAAGAAQugMAAN0GADC7AwEA4gUAIdsDAADpBesDIuMDAQDiBQAh6QMBAOIFACGHBAEA4gUAIZQEAQDiBQAhDAcAAN8GACALAACYBgAguAMAAOEGADC5AwAAFAAQugMAAOEGADC7AwEA4gUAIdsDAADpBesDIuMDAQDiBQAh6QMBAOIFACGHBAEA4gUAIbUEAAAUACC2BAAAFAAgDgkAAJkGACALAACYBgAgDAAAlwYAILgDAACWBgAwuQMAANYBABC6AwAAlgYAMLsDAQDiBQAhwQNAAPUFACHbAwAA6QXrAyLjAwEA4gUAIekDAQDiBQAhkgQBAPQFACG1BAAA1gEAILYEAADWAQAgAukDAQAAAAGHBAEAAAABCgcAAN8GACALAACYBgAguAMAAOEGADC5AwAAFAAQugMAAOEGADC7AwEA4gUAIdsDAADpBesDIuMDAQDiBQAh6QMBAOIFACGHBAEA4gUAIRcFAAC7BgAgBgAAvAYAIAcAAN8GACANAADkBgAgDgAAtwYAIA8AAL0GACC4AwAA4gYAMLkDAAAPABC6AwAA4gYAMLsDAQDiBQAhwQNAAPUFACHOAwEA4gUAIc8DAQD0BQAh0AMBAPQFACHTAwEA9AUAIeADAQDiBQAh6wMQAMIGACHsAwEA4gUAIYYEAADjBoYEIocEAQDiBQAhiAQBAPQFACGJBAEA9AUAIYoEAQD0BQAhBMIDAAAAhgQCwwMAAACGBAjEAwAAAIYECMkDAACJBoYEIg4HAADfBgAgCAAA3gYAIAkAAJkGACC4AwAA3QYAMLkDAAAYABC6AwAA3QYAMLsDAQDiBQAh2wMAAOkF6wMi4wMBAOIFACHpAwEA4gUAIYcEAQDiBQAhlAQBAOIFACG1BAAAGAAgtgQAABgAIALOAwEAAAABiwQBAAAAARAFAAC7BgAgCQAAmQYAIBUAAOMFACAhAACsBgAgIwAArQYAILgDAADmBgAwuQMAAAsAELoDAADmBgAwuwMBAOIFACHBA0AA9QUAIc4DAQDiBQAh0wMBAPQFACHbAwAA5waPBCKLBAEA4gUAIYwEQAC6BgAhjQRAALoGACEEwgMAAACPBALDAwAAAI8ECMQDAAAAjwQIyQMAAI0GjwQiCgQAAOkGACAFAAC7BgAguAMAAOgGADC5AwAABwAQugMAAOgGADC7AwEA4gUAIc4DAQDiBQAh6wMQAMIGACHsAwEA4gUAIf8DAQDiBQAhDwMAALcGACAZAACRBgAgHQAAqgYAILgDAADqBgAwuQMAAAMAELoDAADqBgAwuwMBAOIFACHBA0AA9QUAIdMDAQD0BQAh2wMAAOsGhQQi4gNAAPUFACH3AwEA4gUAIYMEAQDiBQAhtQQAAAMAILYEAAADACANAwAAtwYAIBkAAJEGACAdAACqBgAguAMAAOoGADC5AwAAAwAQugMAAOoGADC7AwEA4gUAIcEDQAD1BQAh0wMBAPQFACHbAwAA6waFBCLiA0AA9QUAIfcDAQDiBQAhgwQBAOIFACEEwgMAAACFBALDAwAAAIUECMQDAAAAhQQIyQMAAIUGhQQiAAAAAAG6BAEAAAABAboEAQAAAAEBugQgAAAAAQG6BEAAAAABBTwAAPQNACA9AAD3DQAgtwQAAPUNACC4BAAA9g0AIL0EAAABACADPAAA9A0AILcEAAD1DQAgvQQAAAEAIAAAAAG6BAAAANIDAgG6BEAAAAABBTwAAOkNACA9AADyDQAgtwQAAOoNACC4BAAA8Q0AIL0EAAC6AQAgBzwAAOcNACA9AADvDQAgtwQAAOgNACC4BAAA7g0AILsEAAALACC8BAAACwAgvQQAAA0AIAc8AADlDQAgPQAA7A0AILcEAADmDQAguAQAAOsNACC7BAAAJQAgvAQAACUAIL0EAAABACADPAAA6Q0AILcEAADqDQAgvQQAALoBACADPAAA5w0AILcEAADoDQAgvQQAAA0AIAM8AADlDQAgtwQAAOYNACC9BAAAAQAgAAAAAAAFugQQAAAAAcAEEAAAAAHBBBAAAAABwgQQAAAAAcMEEAAAAAEFugQQAAAAAcAEEAAAAAHBBBAAAAABwgQQAAAAAcMEEAAAAAEBugQAAADbAwIFPAAA1A0AID0AAOMNACC3BAAA1Q0AILgEAADiDQAgvQQAAC0AIAc8AADSDQAgPQAA4A0AILcEAADTDQAguAQAAN8NACC7BAAANwAgvAQAADcAIL0EAADEBAAgBzwAANANACA9AADdDQAgtwQAANENACC4BAAA3A0AILsEAAA7ACC8BAAAOwAgvQQAANwEACAFPAAAzg0AID0AANoNACC3BAAAzw0AILgEAADZDQAgvQQAAAEAIAc8AADMDQAgPQAA1w0AILcEAADNDQAguAQAANYNACC7BAAACwAgvAQAAAsAIL0EAAANACADPAAA1A0AILcEAADVDQAgvQQAAC0AIAM8AADSDQAgtwQAANMNACC9BAAAxAQAIAM8AADQDQAgtwQAANENACC9BAAA3AQAIAM8AADODQAgtwQAAM8NACC9BAAAAQAgAzwAAMwNACC3BAAAzQ0AIL0EAAANACAAAAALPAAAlwcAMD0AAJwHADC3BAAAmAcAMLgEAACZBwAwuQQAAJoHACC6BAAAmwcAMLsEAACbBwAwvAQAAJsHADC9BAAAmwcAML4EAACdBwAwvwQAAJ4HADARDgAAkQcAIBMAAI4HACAWAACPBwAgGAAAkgcAILsDAQAAAAHBA0AAAAAB1gMBAAAAAdcDAQAAAAHYAxAAAAAB2QMQAAAAAdsDAAAA2wMC3ANAAAAAAd0DQAAAAAHeAwEAAAAB4AMBAAAAAeEDAQAAAAHiA0AAAAABAgAAACkAIDwAAKIHACADAAAAKQAgPAAAogcAID0AAKEHACABNQAAyw0AMBYOAAC3BgAgEwAAzgYAIBYAANcGACAXAADYBgAgGAAAvAYAILgDAADUBgAwuQMAACcAELoDAADUBgAwuwMBAAAAAcEDQAD1BQAh1gMBAAAAAdcDAQDiBQAh2AMQAMIGACHZAxAA1QYAIdsDAADWBtsDItwDQAC6BgAh3QNAALoGACHeAwEA9AUAId8DAQD0BQAh4AMBAOIFACHhAwEA9AUAIeIDQAD1BQAhAgAAACkAIDUAAKEHACACAAAAnwcAIDUAAKAHACARuAMAAJ4HADC5AwAAnwcAELoDAACeBwAwuwMBAOIFACHBA0AA9QUAIdYDAQDiBQAh1wMBAOIFACHYAxAAwgYAIdkDEADVBgAh2wMAANYG2wMi3ANAALoGACHdA0AAugYAId4DAQD0BQAh3wMBAPQFACHgAwEA4gUAIeEDAQD0BQAh4gNAAPUFACERuAMAAJ4HADC5AwAAnwcAELoDAACeBwAwuwMBAOIFACHBA0AA9QUAIdYDAQDiBQAh1wMBAOIFACHYAxAAwgYAIdkDEADVBgAh2wMAANYG2wMi3ANAALoGACHdA0AAugYAId4DAQD0BQAh3wMBAPQFACHgAwEA4gUAIeEDAQD0BQAh4gNAAPUFACENuwMBAPAGACHBA0AA8wYAIdYDAQDwBgAh1wMBAPAGACHYAxAAhgcAIdkDEACHBwAh2wMAAIgH2wMi3ANAAPoGACHdA0AA-gYAId4DAQDxBgAh4AMBAPAGACHhAwEA8QYAIeIDQADzBgAhEQ4AAIwHACATAACJBwAgFgAAigcAIBgAAI0HACC7AwEA8AYAIcEDQADzBgAh1gMBAPAGACHXAwEA8AYAIdgDEACGBwAh2QMQAIcHACHbAwAAiAfbAyLcA0AA-gYAId0DQAD6BgAh3gMBAPEGACHgAwEA8AYAIeEDAQDxBgAh4gNAAPMGACERDgAAkQcAIBMAAI4HACAWAACPBwAgGAAAkgcAILsDAQAAAAHBA0AAAAAB1gMBAAAAAdcDAQAAAAHYAxAAAAAB2QMQAAAAAdsDAAAA2wMC3ANAAAAAAd0DQAAAAAHeAwEAAAAB4AMBAAAAAeEDAQAAAAHiA0AAAAABBDwAAJcHADC3BAAAmAcAMLkEAACaBwAgvQQAAJsHADAAAAAAAboEAAAA6wMCCzwAAKoHADA9AACuBwAwtwQAAKsHADC4BAAArAcAMLkEAACtBwAgugQAAJsHADC7BAAAmwcAMLwEAACbBwAwvQQAAJsHADC-BAAArwcAML8EAACeBwAwEQ4AAJEHACATAACOBwAgFwAAkAcAIBgAAJIHACC7AwEAAAABwQNAAAAAAdYDAQAAAAHXAwEAAAAB2AMQAAAAAdkDEAAAAAHbAwAAANsDAtwDQAAAAAHdA0AAAAAB3wMBAAAAAeADAQAAAAHhAwEAAAAB4gNAAAAAAQIAAAApACA8AACyBwAgAwAAACkAIDwAALIHACA9AACxBwAgATUAAMoNADACAAAAKQAgNQAAsQcAIAIAAACfBwAgNQAAsAcAIA27AwEA8AYAIcEDQADzBgAh1gMBAPAGACHXAwEA8AYAIdgDEACGBwAh2QMQAIcHACHbAwAAiAfbAyLcA0AA-gYAId0DQAD6BgAh3wMBAPEGACHgAwEA8AYAIeEDAQDxBgAh4gNAAPMGACERDgAAjAcAIBMAAIkHACAXAACLBwAgGAAAjQcAILsDAQDwBgAhwQNAAPMGACHWAwEA8AYAIdcDAQDwBgAh2AMQAIYHACHZAxAAhwcAIdsDAACIB9sDItwDQAD6BgAh3QNAAPoGACHfAwEA8QYAIeADAQDwBgAh4QMBAPEGACHiA0AA8wYAIREOAACRBwAgEwAAjgcAIBcAAJAHACAYAACSBwAguwMBAAAAAcEDQAAAAAHWAwEAAAAB1wMBAAAAAdgDEAAAAAHZAxAAAAAB2wMAAADbAwLcA0AAAAAB3QNAAAAAAd8DAQAAAAHgAwEAAAAB4QMBAAAAAeIDQAAAAAEEPAAAqgcAMLcEAACrBwAwuQQAAK0HACC9BAAAmwcAMAAAAAAABTwAAMINACA9AADIDQAgtwQAAMMNACC4BAAAxw0AIL0EAAAtACAFPAAAwA0AID0AAMUNACC3BAAAwQ0AILgEAADEDQAgvQQAALoBACADPAAAwg0AILcEAADDDQAgvQQAAC0AIAM8AADADQAgtwQAAMENACC9BAAAugEAIAAAAAAABboEAgAAAAHABAIAAAABwQQCAAAAAcIEAgAAAAHDBAIAAAABAboEAAAA9QMCBTwAALYNACA9AAC-DQAgtwQAALcNACC4BAAAvQ0AIL0EAAD_AwAgBTwAALQNACA9AAC7DQAgtwQAALUNACC4BAAAug0AIL0EAAC6AQAgCzwAANEHADA9AADWBwAwtwQAANIHADC4BAAA0wcAMLkEAADUBwAgugQAANUHADC7BAAA1QcAMLwEAADVBwAwvQQAANUHADC-BAAA1wcAML8EAADYBwAwCzwAAMgHADA9AADMBwAwtwQAAMkHADC4BAAAygcAMLkEAADLBwAgugQAAJsHADC7BAAAmwcAMLwEAACbBwAwvQQAAJsHADC-BAAAzQcAML8EAACeBwAwEQ4AAJEHACAWAACPBwAgFwAAkAcAIBgAAJIHACC7AwEAAAABwQNAAAAAAdYDAQAAAAHYAxAAAAAB2QMQAAAAAdsDAAAA2wMC3ANAAAAAAd0DQAAAAAHeAwEAAAAB3wMBAAAAAeADAQAAAAHhAwEAAAAB4gNAAAAAAQIAAAApACA8AADQBwAgAwAAACkAIDwAANAHACA9AADPBwAgATUAALkNADACAAAAKQAgNQAAzwcAIAIAAACfBwAgNQAAzgcAIA27AwEA8AYAIcEDQADzBgAh1gMBAPAGACHYAxAAhgcAIdkDEACHBwAh2wMAAIgH2wMi3ANAAPoGACHdA0AA-gYAId4DAQDxBgAh3wMBAPEGACHgAwEA8AYAIeEDAQDxBgAh4gNAAPMGACERDgAAjAcAIBYAAIoHACAXAACLBwAgGAAAjQcAILsDAQDwBgAhwQNAAPMGACHWAwEA8AYAIdgDEACGBwAh2QMQAIcHACHbAwAAiAfbAyLcA0AA-gYAId0DQAD6BgAh3gMBAPEGACHfAwEA8QYAIeADAQDwBgAh4QMBAPEGACHiA0AA8wYAIREOAACRBwAgFgAAjwcAIBcAAJAHACAYAACSBwAguwMBAAAAAcEDQAAAAAHWAwEAAAAB2AMQAAAAAdkDEAAAAAHbAwAAANsDAtwDQAAAAAHdA0AAAAAB3gMBAAAAAd8DAQAAAAHgAwEAAAAB4QMBAAAAAeIDQAAAAAEGBQAAvAcAILsDAQAAAAHOAwEAAAAB6wMQAAAAAewDAQAAAAHtAyAAAAABAgAAADIAIDwAANwHACADAAAAMgAgPAAA3AcAID0AANsHACABNQAAuA0AMAsFAAC7BgAgEwAAzgYAILgDAADNBgAwuQMAADAAELoDAADNBgAwuwMBAAAAAc4DAQDiBQAh1wMBAOIFACHrAxAAwgYAIewDAQDiBQAh7QMgAKYGACECAAAAMgAgNQAA2wcAIAIAAADZBwAgNQAA2gcAIAm4AwAA2AcAMLkDAADZBwAQugMAANgHADC7AwEA4gUAIc4DAQDiBQAh1wMBAOIFACHrAxAAwgYAIewDAQDiBQAh7QMgAKYGACEJuAMAANgHADC5AwAA2QcAELoDAADYBwAwuwMBAOIFACHOAwEA4gUAIdcDAQDiBQAh6wMQAMIGACHsAwEA4gUAIe0DIACmBgAhBbsDAQDwBgAhzgMBAPAGACHrAxAAhgcAIewDAQDwBgAh7QMgAPIGACEGBQAAugcAILsDAQDwBgAhzgMBAPAGACHrAxAAhgcAIewDAQDwBgAh7QMgAPIGACEGBQAAvAcAILsDAQAAAAHOAwEAAAAB6wMQAAAAAewDAQAAAAHtAyAAAAABAzwAALYNACC3BAAAtw0AIL0EAAD_AwAgAzwAALQNACC3BAAAtQ0AIL0EAAC6AQAgBDwAANEHADC3BAAA0gcAMLkEAADUBwAgvQQAANUHADAEPAAAyAcAMLcEAADJBwAwuQQAAMsHACC9BAAAmwcAMAAAAAs8AADlBwAwPQAA6gcAMLcEAADmBwAwuAQAAOcHADC5BAAA6AcAILoEAADpBwAwuwQAAOkHADC8BAAA6QcAML0EAADpBwAwvgQAAOsHADC_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_BvsDIvcDAQAAAAH4AwEA4gUAIfkDAQDiBQAh-wNAAPUFACECAAAAVQAgNQAAsAgAIAIAAACuCAAgNQAArwgAIAu4AwAArQgAMLkDAACuCAAQugMAAK0IADC7AwEA4gUAIcEDQAD1BQAh0wMBAPQFACHbAwAAvwb7AyL3AwEA4gUAIfgDAQDiBQAh-QMBAOIFACH7A0AA9QUAIQu4AwAArQgAMLkDAACuCAAQugMAAK0IADC7AwEA4gUAIcEDQAD1BQAh0wMBAPQFACHbAwAAvwb7AyL3AwEA4gUAIfgDAQDiBQAh-QMBAOIFACH7A0AA9QUAIQe7AwEA8AYAIcEDQADzBgAh0wMBAPEGACHbAwAAgQj7AyL3AwEA8AYAIfkDAQDwBgAh-wNAAPMGACEJHQAAhAgAIB8AAIMIACC7AwEA8AYAIcEDQADzBgAh0wMBAPEGACHbAwAAgQj7AyL3AwEA8AYAIfkDAQDwBgAh-wNAAPMGACEJHQAAkwgAIB8AAJIIACC7AwEAAAABwQNAAAAAAdMDAQAAAAHbAwAAAPsDAvcDAQAAAAH5AwEAAAAB-wNAAAAAAQcFAACcCAAguwMBAAAAAc4DAQAAAAHrAxAAAAAB7AMBAAAAAfwDEAAAAAH9AxAAAAABAgAAAFEAIDwAAL0IACADAAAAUQAgPAAAvQgAID0AALwIACABNQAAhA0AMAwFAAC7BgAgHAAAwAYAILgDAADBBgAwuQMAAE8AELoDAADBBgAwuwMBAAAAAc4DAQDiBQAh6wMQAMIGACHsAwEA4gUAIfgDAQDiBQAh_AMQAMIGACH9AxAAwgYAIQIAAABRACA1AAC8CAAgAgAAALoIACA1AAC7CAAgCrgDAAC5CAAwuQMAALoIABC6AwAAuQgAMLsDAQDiBQAhzgMBAOIFACHrAxAAwgYAIewDAQDiBQAh-AMBAOIFACH8AxAAwgYAIf0DEADCBgAhCrgDAAC5CAAwuQMAALoIABC6AwAAuQgAMLsDAQDiBQAhzgMBAOIFACHrAxAAwgYAIewDAQDiBQAh-AMBAOIFACH8AxAAwgYAIf0DEADCBgAhBrsDAQDwBgAhzgMBAPAGACHrAxAAhgcAIewDAQDwBgAh_AMQAIYHACH9AxAAhgcAIQcFAACaCAAguwMBAPAGACHOAwEA8AYAIesDEACGBwAh7AMBAPAGACH8AxAAhgcAIf0DEACGBwAhBwUAAJwIACC7AwEAAAABzgMBAAAAAesDEAAAAAHsAwEAAAAB_AMQAAAAAf0DEAAAAAEDPAAAgg0AILcEAACDDQAgvQQAAJgCACADPAAAgA0AILcEAACBDQAgvQQAAAUAIAM8AAD-DAAgtwQAAP8MACC9BAAAAQAgBDwAALIIADC3BAAAswgAMLkEAAC1CAAgvQQAALYIADAEPAAApggAMLcEAACnCAAwuQQAAKkIACC9BAAAqggAMAAAAAAABTwAAPYMACA9AAD8DAAgtwQAAPcMACC4BAAA-wwAIL0EAAAFACAFPAAA9AwAID0AAPkMACC3BAAA9QwAILgEAAD4DAAgvQQAALoBACADPAAA9gwAILcEAAD3DAAgvQQAAAUAIAM8AAD0DAAgtwQAAPUMACC9BAAAugEAIAAAAAG6BAAAAIUEAgU8AADtDAAgPQAA8gwAILcEAADuDAAguAQAAPEMACC9BAAAAQAgCzwAAN8IADA9AADkCAAwtwQAAOAIADC4BAAA4QgAMLkEAADiCAAgugQAAOMIADC7BAAA4wgAMLwEAADjCAAwvQQAAOMIADC-BAAA5QgAML8EAADmCAAwCzwAANMIADA9AADYCAAwtwQAANQIADC4BAAA1QgAMLkEAADWCAAgugQAANcIADC7BAAA1wgAMLwEAADXCAAwvQQAANcIADC-BAAA2QgAML8EAADaCAAwDg4AAMAIACAaAAC-CAAgHQAAwQgAIB4AAMIIACC7AwEAAAABwQNAAAAAAdMDAQAAAAHbAwAAAIEEAuADAQAAAAHiA0AAAAAB9wMBAAAAAf4DAQAAAAGBBEAAAAABggRAAAAAAQIAAABGACA8AADeCAAgAwAAAEYAIDwAAN4IACA9AADdCAAgATUAAPAMADATBAAAyAYAIA4AALcGACAaAADFBgAgHQAAqwYAIB4AAMkGACC4AwAAxgYAMLkDAABEABC6AwAAxgYAMLsDAQAAAAHBA0AA9QUAIdMDAQD0BQAh2wMAAMcGgQQi4AMBAOIFACHiA0AA9QUAIfcDAQAAAAH-AwEA4gUAIf8DAQD0BQAhgQRAALoGACGCBEAAugYAIQIAAABGACA1AADdCAAgAgAAANsIACA1AADcCAAgDrgDAADaCAAwuQMAANsIABC6AwAA2ggAMLsDAQDiBQAhwQNAAPUFACHTAwEA9AUAIdsDAADHBoEEIuADAQDiBQAh4gNAAPUFACH3AwEA4gUAIf4DAQDiBQAh_wMBAPQFACGBBEAAugYAIYIEQAC6BgAhDrgDAADaCAAwuQMAANsIABC6AwAA2ggAMLsDAQDiBQAhwQNAAPUFACHTAwEA9AUAIdsDAADHBoEEIuADAQDiBQAh4gNAAPUFACH3AwEA4gUAIf4DAQDiBQAh_wMBAPQFACGBBEAAugYAIYIEQAC6BgAhCrsDAQDwBgAhwQNAAPMGACHTAwEA8QYAIdsDAACgCIEEIuADAQDwBgAh4gNAAPMGACH3AwEA8AYAIf4DAQDwBgAhgQRAAPoGACGCBEAA-gYAIQ4OAACjCAAgGgAAoQgAIB0AAKQIACAeAAClCAAguwMBAPAGACHBA0AA8wYAIdMDAQDxBgAh2wMAAKAIgQQi4AMBAPAGACHiA0AA8wYAIfcDAQDwBgAh_gMBAPAGACGBBEAA-gYAIYIEQAD6BgAhDg4AAMAIACAaAAC-CAAgHQAAwQgAIB4AAMIIACC7AwEAAAABwQNAAAAAAdMDAQAAAAHbAwAAAIEEAuADAQAAAAHiA0AAAAAB9wMBAAAAAf4DAQAAAAGBBEAAAAABggRAAAAAAQUFAADLCAAguwMBAAAAAc4DAQAAAAHrAxAAAAAB7AMBAAAAAQIAAAAJACA8AADqCAAgAwAAAAkAIDwAAOoIACA9AADpCAAgATUAAO8MADAKBAAA6QYAIAUAALsGACC4AwAA6AYAMLkDAAAHABC6AwAA6AYAMLsDAQAAAAHOAwEA4gUAIesDEADCBgAh7AMBAOIFACH_AwEA4gUAIQIAAAAJACA1AADpCAAgAgAAAOcIACA1AADoCAAgCLgDAADmCAAwuQMAAOcIABC6AwAA5ggAMLsDAQDiBQAhzgMBAOIFACHrAxAAwgYAIewDAQDiBQAh_wMBAOIFACEIuAMAAOYIADC5AwAA5wgAELoDAADmCAAwuwMBAOIFACHOAwEA4gUAIesDEADCBgAh7AMBAOIFACH_AwEA4gUAIQS7AwEA8AYAIc4DAQDwBgAh6wMQAIYHACHsAwEA8AYAIQUFAADJCAAguwMBAPAGACHOAwEA8AYAIesDEACGBwAh7AMBAPAGACEFBQAAywgAILsDAQAAAAHOAwEAAAAB6wMQAAAAAewDAQAAAAEDPAAA7QwAILcEAADuDAAgvQQAAAEAIAQ8AADfCAAwtwQAAOAIADC5BAAA4ggAIL0EAADjCAAwBDwAANMIADC3BAAA1AgAMLkEAADWCAAgvQQAANcIADAAAAAAAAG6BAAAAIYEAgU8AADZDAAgPQAA6wwAILcEAADaDAAguAQAAOoMACC9BAAAugEAIAc8AADXDAAgPQAA6AwAILcEAADYDAAguAQAAOcMACC7BAAACwAgvAQAAAsAIL0EAAANACAFPAAA1QwAID0AAOUMACC3BAAA1gwAILgEAADkDAAgvQQAANMBACAHPAAA0wwAID0AAOIMACC3BAAA1AwAILgEAADhDAAguwQAABgAILwEAAAYACC9BAAAGgAgBTwAANEMACA9AADfDAAgtwQAANIMACC4BAAA3gwAIL0EAAABACAHPAAAzwwAID0AANwMACC3BAAA0AwAILgEAADbDAAguwQAACUAILwEAAAlACC9BAAAAQAgAzwAANkMACC3BAAA2gwAIL0EAAC6AQAgAzwAANcMACC3BAAA2AwAIL0EAAANACADPAAA1QwAILcEAADWDAAgvQQAANMBACADPAAA0wwAILcEAADUDAAgvQQAABoAIAM8AADRDAAgtwQAANIMACC9BAAAAQAgAzwAAM8MACC3BAAA0AwAIL0EAAABACAAAAABugQAAACPBAIFPAAAxgwAID0AAM0MACC3BAAAxwwAILgEAADMDAAgvQQAALoBACALPAAApwkAMD0AAKwJADC3BAAAqAkAMLgEAACpCQAwuQQAAKoJACC6BAAAqwkAMLsEAACrCQAwvAQAAKsJADC9BAAAqwkAML4EAACtCQAwvwQAAK4JADALPAAAngkAMD0AAKIJADC3BAAAnwkAMLgEAACgCQAwuQQAAKEJACC6BAAAmwcAMLsEAACbBwAwvAQAAJsHADC9BAAAmwcAML4EAACjCQAwvwQAAJ4HADALPAAAlQkAMD0AAJkJADC3BAAAlgkAMLgEAACXCQAwuQQAAJgJACC6BAAAiQgAMLsEAACJCAAwvAQAAIkIADC9BAAAiQgAML4EAACaCQAwvwQAAIwIADALPAAAiQkAMD0AAI4JADC3BAAAigkAMLgEAACLCQAwuQQAAIwJACC6BAAAjQkAMLsEAACNCQAwvAQAAI0JADC9BAAAjQkAML4EAACPCQAwvwQAAJAJADALBQAA_gYAICIAAIAHACC7AwEAAAABwQNAAAAAAc0DAQAAAAHOAwEAAAAB0AMBAAAAAdIDAAAA0gMC0wMBAAAAAdQDAQAAAAHVA0AAAAABAgAAAF0AIDwAAJQJACADAAAAXQAgPAAAlAkAID0AAJMJACABNQAAywwAMBAFAAC7BgAgBgAAvAYAICIAAL0GACC4AwAAuAYAMLkDAABbABC6AwAAuAYAMLsDAQAAAAHBA0AA9QUAIc0DAQDiBQAhzgMBAOIFACHPAwEA9AUAIdADAQD0BQAh0gMAALkG0gMi0wMBAPQFACHUAwEA9AUAIdUDQAC6BgAhAgAAAF0AIDUAAJMJACACAAAAkQkAIDUAAJIJACANuAMAAJAJADC5AwAAkQkAELoDAACQCQAwuwMBAOIFACHBA0AA9QUAIc0DAQDiBQAhzgMBAOIFACHPAwEA9AUAIdADAQD0BQAh0gMAALkG0gMi0wMBAPQFACHUAwEA9AUAIdUDQAC6BgAhDbgDAACQCQAwuQMAAJEJABC6AwAAkAkAMLsDAQDiBQAhwQNAAPUFACHNAwEA4gUAIc4DAQDiBQAhzwMBAPQFACHQAwEA9AUAIdIDAAC5BtIDItMDAQD0BQAh1AMBAPQFACHVA0AAugYAIQm7AwEA8AYAIcEDQADzBgAhzQMBAPAGACHOAwEA8AYAIdADAQDxBgAh0gMAAPkG0gMi0wMBAPEGACHUAwEA8QYAIdUDQAD6BgAhCwUAAPsGACAiAAD9BgAguwMBAPAGACHBA0AA8wYAIc0DAQDwBgAhzgMBAPAGACHQAwEA8QYAIdIDAAD5BtIDItMDAQDxBgAh1AMBAPEGACHVA0AA-gYAIQsFAAD-BgAgIgAAgAcAILsDAQAAAAHBA0AAAAABzQMBAAAAAc4DAQAAAAHQAwEAAAAB0gMAAADSAwLTAwEAAAAB1AMBAAAAAdUDQAAAAAEHBQAA_AcAICAAAPsHACC7AwEAAAABzgMBAAAAAesDEAAAAAHsAwEAAAAB9gMBAAAAAQIAAABCACA8AACdCQAgAwAAAEIAIDwAAJ0JACA9AACcCQAgATUAAMoMADACAAAAQgAgNQAAnAkAIAIAAACNCAAgNQAAmwkAIAW7AwEA8AYAIc4DAQDwBgAh6wMQAIYHACHsAwEA8AYAIfYDAQDwBgAhBwUAAPkHACAgAAD4BwAguwMBAPAGACHOAwEA8AYAIesDEACGBwAh7AMBAPAGACH2AwEA8AYAIQcFAAD8BwAgIAAA-wcAILsDAQAAAAHOAwEAAAAB6wMQAAAAAewDAQAAAAH2AwEAAAABEQ4AAJEHACATAACOBwAgFgAAjwcAIBcAAJAHACC7AwEAAAABwQNAAAAAAdYDAQAAAAHXAwEAAAAB2AMQAAAAAdkDEAAAAAHbAwAAANsDAtwDQAAAAAHdA0AAAAAB3gMBAAAAAd8DAQAAAAHgAwEAAAAB4gNAAAAAAQIAAAApACA8AACmCQAgAwAAACkAIDwAAKYJACA9AAClCQAgATUAAMkMADACAAAAKQAgNQAApQkAIAIAAACfBwAgNQAApAkAIA27AwEA8AYAIcEDQADzBgAh1gMBAPAGACHXAwEA8AYAIdgDEACGBwAh2QMQAIcHACHbAwAAiAfbAyLcA0AA-gYAId0DQAD6BgAh3gMBAPEGACHfAwEA8QYAIeADAQDwBgAh4gNAAPMGACERDgAAjAcAIBMAAIkHACAWAACKBwAgFwAAiwcAILsDAQDwBgAhwQNAAPMGACHWAwEA8AYAIdcDAQDwBgAh2AMQAIYHACHZAxAAhwcAIdsDAACIB9sDItwDQAD6BgAh3QNAAPoGACHeAwEA8QYAId8DAQDxBgAh4AMBAPAGACHiA0AA8wYAIREOAACRBwAgEwAAjgcAIBYAAI8HACAXAACQBwAguwMBAAAAAcEDQAAAAAHWAwEAAAAB1wMBAAAAAdgDEAAAAAHZAxAAAAAB2wMAAADbAwLcA0AAAAAB3QNAAAAAAd4DAQAAAAHfAwEAAAAB4AMBAAAAAeIDQAAAAAESBQAA-ggAIAcAAPwIACANAAD9CAAgDgAA_ggAIA8AAP8IACC7AwEAAAABwQNAAAAAAc4DAQAAAAHQAwEAAAAB0wMBAAAAAeADAQAAAAHrAxAAAAAB7AMBAAAAAYYEAAAAhgQChwQBAAAAAYgEAQAAAAGJBAEAAAABigQBAAAAAQIAAAARACA8AACyCQAgAwAAABEAIDwAALIJACA9AACxCQAgATUAAMgMADAXBQAAuwYAIAYAALwGACAHAADfBgAgDQAA5AYAIA4AALcGACAPAAC9BgAguAMAAOIGADC5AwAADwAQugMAAOIGADC7AwEAAAABwQNAAPUFACHOAwEA4gUAIc8DAQD0BQAh0AMBAPQFACHTAwEA9AUAIeADAQDiBQAh6wMQAMIGACHsAwEA4gUAIYYEAADjBoYEIocEAQDiBQAhiAQBAPQFACGJBAEA9AUAIYoEAQD0BQAhAgAAABEAIDUAALEJACACAAAArwkAIDUAALAJACARuAMAAK4JADC5AwAArwkAELoDAACuCQAwuwMBAOIFACHBA0AA9QUAIc4DAQDiBQAhzwMBAPQFACHQAwEA9AUAIdMDAQD0BQAh4AMBAOIFACHrAxAAwgYAIewDAQDiBQAhhgQAAOMGhgQihwQBAOIFACGIBAEA9AUAIYkEAQD0BQAhigQBAPQFACERuAMAAK4JADC5AwAArwkAELoDAACuCQAwuwMBAOIFACHBA0AA9QUAIc4DAQDiBQAhzwMBAPQFACHQAwEA9AUAIdMDAQD0BQAh4AMBAOIFACHrAxAAwgYAIewDAQDiBQAhhgQAAOMGhgQihwQBAOIFACGIBAEA9AUAIYkEAQD0BQAhigQBAPQFACENuwMBAPAGACHBA0AA8wYAIc4DAQDwBgAh0AMBAPEGACHTAwEA8QYAIeADAQDwBgAh6wMQAIYHACHsAwEA8AYAIYYEAADzCIYEIocEAQDwBgAhiAQBAPEGACGJBAEA8QYAIYoEAQDxBgAhEgUAAPQIACAHAAD2CAAgDQAA9wgAIA4AAPgIACAPAAD5CAAguwMBAPAGACHBA0AA8wYAIc4DAQDwBgAh0AMBAPEGACHTAwEA8QYAIeADAQDwBgAh6wMQAIYHACHsAwEA8AYAIYYEAADzCIYEIocEAQDwBgAhiAQBAPEGACGJBAEA8QYAIYoEAQDxBgAhEgUAAPoIACAHAAD8CAAgDQAA_QgAIA4AAP4IACAPAAD_CAAguwMBAAAAAcEDQAAAAAHOAwEAAAAB0AMBAAAAAdMDAQAAAAHgAwEAAAAB6wMQAAAAAewDAQAAAAGGBAAAAIYEAocEAQAAAAGIBAEAAAABiQQBAAAAAYoEAQAAAAEDPAAAxgwAILcEAADHDAAgvQQAALoBACAEPAAApwkAMLcEAACoCQAwuQQAAKoJACC9BAAAqwkAMAQ8AACeCQAwtwQAAJ8JADC5BAAAoQkAIL0EAACbBwAwBDwAAJUJADC3BAAAlgkAMLkEAACYCQAgvQQAAIkIADAEPAAAiQkAMLcEAACKCQAwuQQAAIwJACC9BAAAjQkAMAAAAAU8AAC-DAAgPQAAxAwAILcEAAC_DAAguAQAAMMMACC9BAAAugEAIAU8AAC8DAAgPQAAwQwAILcEAAC9DAAguAQAAMAMACC9BAAAmAIAIAM8AAC-DAAgtwQAAL8MACC9BAAAugEAIAM8AAC8DAAgtwQAAL0MACC9BAAAmAIAIAAAAAs8AADQCQAwPQAA1AkAMLcEAADRCQAwuAQAANIJADC5BAAA0wkAILoEAADXCAAwuwQAANcIADC8BAAA1wgAML0EAADXCAAwvgQAANUJADC_BAAA2ggAMAs8AADECQAwPQAAyQkAMLcEAADFCQAwuAQAAMYJADC5BAAAxwkAILoEAADICQAwuwQAAMgJADC8BAAAyAkAML0EAADICQAwvgQAAMoJADC_BAAAywkAMAIFAAC9CQAgzgMBAAAAAQIAAABKACA8AADPCQAgAwAAAEoAIDwAAM8JACA9AADOCQAgATUAALsMADAIBQAAuwYAIBoAAMUGACC4AwAAxAYAMLkDAABIABC6AwAAxAYAMM4DAQDiBQAh_gMBAOIFACGwBAAAwwYAIAIAAABKACA1AADOCQAgAgAAAMwJACA1AADNCQAgBbgDAADLCQAwuQMAAMwJABC6AwAAywkAMM4DAQDiBQAh_gMBAOIFACEFuAMAAMsJADC5AwAAzAkAELoDAADLCQAwzgMBAOIFACH-AwEA4gUAIQHOAwEA8AYAIQIFAAC7CQAgzgMBAPAGACECBQAAvQkAIM4DAQAAAAEOBAAAvwgAIA4AAMAIACAdAADBCAAgHgAAwggAILsDAQAAAAHBA0AAAAAB0wMBAAAAAdsDAAAAgQQC4AMBAAAAAeIDQAAAAAH3AwEAAAAB_wMBAAAAAYEEQAAAAAGCBEAAAAABAgAAAEYAIDwAANgJACADAAAARgAgPAAA2AkAID0AANcJACABNQAAugwAMAIAAABGACA1AADXCQAgAgAAANsIACA1AADWCQAgCrsDAQDwBgAhwQNAAPMGACHTAwEA8QYAIdsDAACgCIEEIuADAQDwBgAh4gNAAPMGACH3AwEA8AYAIf8DAQDxBgAhgQRAAPoGACGCBEAA-gYAIQ4EAACiCAAgDgAAowgAIB0AAKQIACAeAAClCAAguwMBAPAGACHBA0AA8wYAIdMDAQDxBgAh2wMAAKAIgQQi4AMBAPAGACHiA0AA8wYAIfcDAQDwBgAh_wMBAPEGACGBBEAA-gYAIYIEQAD6BgAhDgQAAL8IACAOAADACAAgHQAAwQgAIB4AAMIIACC7AwEAAAABwQNAAAAAAdMDAQAAAAHbAwAAAIEEAuADAQAAAAHiA0AAAAAB9wMBAAAAAf8DAQAAAAGBBEAAAAABggRAAAAAAQQ8AADQCQAwtwQAANEJADC5BAAA0wkAIL0EAADXCAAwBDwAAMQJADC3BAAAxQkAMLkEAADHCQAgvQQAAMgJADAAAAAAAAU8AACxDAAgPQAAuAwAILcEAACyDAAguAQAALcMACC9BAAAFgAgBTwAAK8MACA9AAC1DAAgtwQAALAMACC4BAAAtAwAIL0EAADTAQAgCzwAAOMJADA9AADnCQAwtwQAAOQJADC4BAAA5QkAMLkEAADmCQAgugQAAKsJADC7BAAAqwkAMLwEAACrCQAwvQQAAKsJADC-BAAA6AkAML8EAACuCQAwEgUAAPoIACAGAAD7CAAgBwAA_AgAIA4AAP4IACAPAAD_CAAguwMBAAAAAcEDQAAAAAHOAwEAAAABzwMBAAAAAdADAQAAAAHTAwEAAAAB4AMBAAAAAesDEAAAAAHsAwEAAAABhgQAAACGBAKHBAEAAAABiQQBAAAAAYoEAQAAAAECAAAAEQAgPAAA6wkAIAMAAAARACA8AADrCQAgPQAA6gkAIAE1AACzDAAwAgAAABEAIDUAAOoJACACAAAArwkAIDUAAOkJACANuwMBAPAGACHBA0AA8wYAIc4DAQDwBgAhzwMBAPEGACHQAwEA8QYAIdMDAQDxBgAh4AMBAPAGACHrAxAAhgcAIewDAQDwBgAhhgQAAPMIhgQihwQBAPAGACGJBAEA8QYAIYoEAQDxBgAhEgUAAPQIACAGAAD1CAAgBwAA9ggAIA4AAPgIACAPAAD5CAAguwMBAPAGACHBA0AA8wYAIc4DAQDwBgAhzwMBAPEGACHQAwEA8QYAIdMDAQDxBgAh4AMBAPAGACHrAxAAhgcAIewDAQDwBgAhhgQAAPMIhgQihwQBAPAGACGJBAEA8QYAIYoEAQDxBgAhEgUAAPoIACAGAAD7CAAgBwAA_AgAIA4AAP4IACAPAAD_CAAguwMBAAAAAcEDQAAAAAHOAwEAAAABzwMBAAAAAdADAQAAAAHTAwEAAAAB4AMBAAAAAesDEAAAAAHsAwEAAAABhgQAAACGBAKHBAEAAAABiQQBAAAAAYoEAQAAAAEDPAAAsQwAILcEAACyDAAgvQQAABYAIAM8AACvDAAgtwQAALAMACC9BAAA0wEAIAQ8AADjCQAwtwQAAOQJADC5BAAA5gkAIL0EAACrCQAwAAAABTwAAKkMACA9AACtDAAgtwQAAKoMACC4BAAArAwAIL0EAADTAQAgCzwAAPQJADA9AAD5CQAwtwQAAPUJADC4BAAA9gkAMLkEAAD3CQAgugQAAPgJADC7BAAA-AkAMLwEAAD4CQAwvQQAAPgJADC-BAAA-gkAML8EAAD7CQAwBwcAAO0JACAJAADuCQAguwMBAAAAAdsDAAAA6wMC4wMBAAAAAekDAQAAAAGHBAEAAAABAgAAABoAIDwAAP8JACADAAAAGgAgPAAA_wkAID0AAP4JACABNQAAqwwAMA0HAADfBgAgCAAA3gYAIAkAAJkGACC4AwAA3QYAMLkDAAAYABC6AwAA3QYAMLsDAQAAAAHbAwAA6QXrAyLjAwEA4gUAIekDAQDiBQAhhwQBAOIFACGUBAEA4gUAIbIEAADcBgAgAgAAABoAIDUAAP4JACACAAAA_AkAIDUAAP0JACAJuAMAAPsJADC5AwAA_AkAELoDAAD7CQAwuwMBAOIFACHbAwAA6QXrAyLjAwEA4gUAIekDAQDiBQAhhwQBAOIFACGUBAEA4gUAIQm4AwAA-wkAMLkDAAD8CQAQugMAAPsJADC7AwEA4gUAIdsDAADpBesDIuMDAQDiBQAh6QMBAOIFACGHBAEA4gUAIZQEAQDiBQAhBbsDAQDwBgAh2wMAAKgH6wMi4wMBAPAGACHpAwEA8AYAIYcEAQDwBgAhBwcAAOEJACAJAADiCQAguwMBAPAGACHbAwAAqAfrAyLjAwEA8AYAIekDAQDwBgAhhwQBAPAGACEHBwAA7QkAIAkAAO4JACC7AwEAAAAB2wMAAADrAwLjAwEAAAAB6QMBAAAAAYcEAQAAAAEDPAAAqQwAILcEAACqDAAgvQQAANMBACAEPAAA9AkAMLcEAAD1CQAwuQQAAPcJACC9BAAA-AkAMAAAAAs8AACaCgAwPQAAnwoAMLcEAACbCgAwuAQAAJwKADC5BAAAnQoAILoEAACeCgAwuwQAAJ4KADC8BAAAngoAML0EAACeCgAwvgQAAKAKADC_BAAAoQoAMAs8AACRCgAwPQAAlQoAMLcEAACSCgAwuAQAAJMKADC5BAAAlAoAILoEAAD4CQAwuwQAAPgJADC8BAAA-AkAML0EAAD4CQAwvgQAAJYKADC_BAAA-wkAMAs8AACICgAwPQAAjAoAMLcEAACJCgAwuAQAAIoKADC5BAAAiwoAILoEAACrCQAwuwQAAKsJADC8BAAAqwkAML0EAACrCQAwvgQAAI0KADC_BAAArgkAMBIFAAD6CAAgBgAA-wgAIA0AAP0IACAOAAD-CAAgDwAA_wgAILsDAQAAAAHBA0AAAAABzgMBAAAAAc8DAQAAAAHQAwEAAAAB0wMBAAAAAeADAQAAAAHrAxAAAAAB7AMBAAAAAYYEAAAAhgQCiAQBAAAAAYkEAQAAAAGKBAEAAAABAgAAABEAIDwAAJAKACADAAAAEQAgPAAAkAoAID0AAI8KACABNQAAqAwAMAIAAAARACA1AACPCgAgAgAAAK8JACA1AACOCgAgDbsDAQDwBgAhwQNAAPMGACHOAwEA8AYAIc8DAQDxBgAh0AMBAPEGACHTAwEA8QYAIeADAQDwBgAh6wMQAIYHACHsAwEA8AYAIYYEAADzCIYEIogEAQDxBgAhiQQBAPEGACGKBAEA8QYAIRIFAAD0CAAgBgAA9QgAIA0AAPcIACAOAAD4CAAgDwAA-QgAILsDAQDwBgAhwQNAAPMGACHOAwEA8AYAIc8DAQDxBgAh0AMBAPEGACHTAwEA8QYAIeADAQDwBgAh6wMQAIYHACHsAwEA8AYAIYYEAADzCIYEIogEAQDxBgAhiQQBAPEGACGKBAEA8QYAIRIFAAD6CAAgBgAA-wgAIA0AAP0IACAOAAD-CAAgDwAA_wgAILsDAQAAAAHBA0AAAAABzgMBAAAAAc8DAQAAAAHQAwEAAAAB0wMBAAAAAeADAQAAAAHrAxAAAAAB7AMBAAAAAYYEAAAAhgQCiAQBAAAAAYkEAQAAAAGKBAEAAAABBwgAAOwJACAJAADuCQAguwMBAAAAAdsDAAAA6wMC4wMBAAAAAekDAQAAAAGUBAEAAAABAgAAABoAIDwAAJkKACADAAAAGgAgPAAAmQoAID0AAJgKACABNQAApwwAMAIAAAAaACA1AACYCgAgAgAAAPwJACA1AACXCgAgBbsDAQDwBgAh2wMAAKgH6wMi4wMBAPAGACHpAwEA8AYAIZQEAQDwBgAhBwgAAOAJACAJAADiCQAguwMBAPAGACHbAwAAqAfrAyLjAwEA8AYAIekDAQDwBgAhlAQBAPAGACEHCAAA7AkAIAkAAO4JACC7AwEAAAAB2wMAAADrAwLjAwEAAAAB6QMBAAAAAZQEAQAAAAEFCwAAgQoAILsDAQAAAAHbAwAAAOsDAuMDAQAAAAHpAwEAAAABAgAAABYAIDwAAKUKACADAAAAFgAgPAAApQoAID0AAKQKACABNQAApgwAMAsHAADfBgAgCwAAmAYAILgDAADhBgAwuQMAABQAELoDAADhBgAwuwMBAAAAAdsDAADpBesDIuMDAQDiBQAh6QMBAOIFACGHBAEA4gUAIbMEAADgBgAgAgAAABYAIDUAAKQKACACAAAAogoAIDUAAKMKACAIuAMAAKEKADC5AwAAogoAELoDAAChCgAwuwMBAOIFACHbAwAA6QXrAyLjAwEA4gUAIekDAQDiBQAhhwQBAOIFACEIuAMAAKEKADC5AwAAogoAELoDAAChCgAwuwMBAOIFACHbAwAA6QXrAyLjAwEA4gUAIekDAQDiBQAhhwQBAOIFACEEuwMBAPAGACHbAwAAqAfrAyLjAwEA8AYAIekDAQDwBgAhBQsAAPMJACC7AwEA8AYAIdsDAACoB-sDIuMDAQDwBgAh6QMBAPAGACEFCwAAgQoAILsDAQAAAAHbAwAAAOsDAuMDAQAAAAHpAwEAAAABBDwAAJoKADC3BAAAmwoAMLkEAACdCgAgvQQAAJ4KADAEPAAAkQoAMLcEAACSCgAwuQQAAJQKACC9BAAA-AkAMAQ8AACICgAwtwQAAIkKADC5BAAAiwoAIL0EAACrCQAwAAAAAAAAAAABugQAAACXBAIFugQCAAAAAcAEAgAAAAHBBAIAAAABwgQCAAAAAcMEAgAAAAELPAAAhAsAMD0AAIkLADC3BAAAhQsAMLgEAACGCwAwuQQAAIcLACC6BAAAiAsAMLsEAACICwAwvAQAAIgLADC9BAAAiAsAML4EAACKCwAwvwQAAIsLADALPAAA-woAMD0AAP8KADC3BAAA_AoAMLgEAAD9CgAwuQQAAP4KACC6BAAAqwkAMLsEAACrCQAwvAQAAKsJADC9BAAAqwkAML4EAACACwAwvwQAAK4JADALPAAA8goAMD0AAPYKADC3BAAA8woAMLgEAAD0CgAwuQQAAPUKACC6BAAA1QcAMLsEAADVBwAwvAQAANUHADC9BAAA1QcAML4EAAD3CgAwvwQAANgHADALPAAA6QoAMD0AAO0KADC3BAAA6goAMLgEAADrCgAwuQQAAOwKACC6BAAA6QcAMLsEAADpBwAwvAQAAOkHADC9BAAA6QcAML4EAADuCgAwvwQAAOwHADALPAAA4AoAMD0AAOQKADC3BAAA4QoAMLgEAADiCgAwuQQAAOMKACC6BAAA4wgAMLsEAADjCAAwvAQAAOMIADC9BAAA4wgAML4EAADlCgAwvwQAAOYIADALPAAA1woAMD0AANsKADC3BAAA2AoAMLgEAADZCgAwuQQAANoKACC6BAAAtggAMLsEAAC2CAAwvAQAALYIADC9BAAAtggAML4EAADcCgAwvwQAALkIADALPAAAzgoAMD0AANIKADC3BAAAzwoAMLgEAADQCgAwuQQAANEKACC6BAAAiQgAMLsEAACJCAAwvAQAAIkIADC9BAAAiQgAML4EAADTCgAwvwQAAIwIADALPAAAxQoAMD0AAMkKADC3BAAAxgoAMLgEAADHCgAwuQQAAMgKACC6BAAAjQkAMLsEAACNCQAwvAQAAI0JADC9BAAAjQkAML4EAADKCgAwvwQAAJAJADALPAAAvAoAMD0AAMAKADC3BAAAvQoAMLgEAAC-CgAwuQQAAL8KACC6BAAAyAkAMLsEAADICQAwvAQAAMgJADC9BAAAyAkAML4EAADBCgAwvwQAAMsJADACGgAAvgkAIP4DAQAAAAECAAAASgAgPAAAxAoAIAMAAABKACA8AADECgAgPQAAwwoAIAE1AAClDAAwAgAAAEoAIDUAAMMKACACAAAAzAkAIDUAAMIKACAB_gMBAPAGACECGgAAvAkAIP4DAQDwBgAhAhoAAL4JACD-AwEAAAABCwYAAP8GACAiAACABwAguwMBAAAAAcEDQAAAAAHNAwEAAAABzwMBAAAAAdADAQAAAAHSAwAAANIDAtMDAQAAAAHUAwEAAAAB1QNAAAAAAQIAAABdACA8AADNCgAgAwAAAF0AIDwAAM0KACA9AADMCgAgATUAAKQMADACAAAAXQAgNQAAzAoAIAIAAACRCQAgNQAAywoAIAm7AwEA8AYAIcEDQADzBgAhzQMBAPAGACHPAwEA8QYAIdADAQDxBgAh0gMAAPkG0gMi0wMBAPEGACHUAwEA8QYAIdUDQAD6BgAhCwYAAPwGACAiAAD9BgAguwMBAPAGACHBA0AA8wYAIc0DAQDwBgAhzwMBAPEGACHQAwEA8QYAIdIDAAD5BtIDItMDAQDxBgAh1AMBAPEGACHVA0AA-gYAIQsGAAD_BgAgIgAAgAcAILsDAQAAAAHBA0AAAAABzQMBAAAAAc8DAQAAAAHQAwEAAAAB0gMAAADSAwLTAwEAAAAB1AMBAAAAAdUDQAAAAAEHBgAA_QcAICAAAPsHACC7AwEAAAABzwMBAAAAAesDEAAAAAHsAwEAAAAB9gMBAAAAAQIAAABCACA8AADWCgAgAwAAAEIAIDwAANYKACA9AADVCgAgATUAAKMMADACAAAAQgAgNQAA1QoAIAIAAACNCAAgNQAA1AoAIAW7AwEA8AYAIc8DAQDwBgAh6wMQAIYHACHsAwEA8AYAIfYDAQDwBgAhBwYAAPoHACAgAAD4BwAguwMBAPAGACHPAwEA8AYAIesDEACGBwAh7AMBAPAGACH2AwEA8AYAIQcGAAD9BwAgIAAA-wcAILsDAQAAAAHPAwEAAAAB6wMQAAAAAewDAQAAAAH2AwEAAAABBxwAAJsIACC7AwEAAAAB6wMQAAAAAewDAQAAAAH4AwEAAAAB_AMQAAAAAf0DEAAAAAECAAAAUQAgPAAA3woAIAMAAABRACA8AADfCgAgPQAA3goAIAE1AACiDAAwAgAAAFEAIDUAAN4KACACAAAAuggAIDUAAN0KACAGuwMBAPAGACHrAxAAhgcAIewDAQDwBgAh-AMBAPAGACH8AxAAhgcAIf0DEACGBwAhBxwAAJkIACC7AwEA8AYAIesDEACGBwAh7AMBAPAGACH4AwEA8AYAIfwDEACGBwAh_QMQAIYHACEHHAAAmwgAILsDAQAAAAHrAxAAAAAB7AMBAAAAAfgDAQAAAAH8AxAAAAAB_QMQAAAAAQUEAADKCAAguwMBAAAAAesDEAAAAAHsAwEAAAAB_wMBAAAAAQIAAAAJACA8AADoCgAgAwAAAAkAIDwAAOgKACA9AADnCgAgATUAAKEMADACAAAACQAgNQAA5woAIAIAAADnCAAgNQAA5goAIAS7AwEA8AYAIesDEACGBwAh7AMBAPAGACH_AwEA8AYAIQUEAADICAAguwMBAPAGACHrAxAAhgcAIewDAQDwBgAh_wMBAPAGACEFBAAAyggAILsDAQAAAAHrAxAAAAAB7AMBAAAAAf8DAQAAAAELEQAA3QcAIBQAAN8HACAVAADgBwAguwMBAAAAAcEDQAAAAAHbAwAAAPUDAu4DAQAAAAHvAwIAAAAB8AMBAAAAAfEDEAAAAAHyAwEAAAABAgAAAC0AIDwAAPEKACADAAAALQAgPAAA8QoAID0AAPAKACABNQAAoAwAMAIAAAAtACA1AADwCgAgAgAAAO0HACA1AADvCgAgCLsDAQDwBgAhwQNAAPMGACHbAwAAwwf1AyLuAwEA8AYAIe8DAgDCBwAh8AMBAPEGACHxAxAAhgcAIfIDAQDwBgAhCxEAAMQHACAUAADGBwAgFQAAxwcAILsDAQDwBgAhwQNAAPMGACHbAwAAwwf1AyLuAwEA8AYAIe8DAgDCBwAh8AMBAPEGACHxAxAAhgcAIfIDAQDwBgAhCxEAAN0HACAUAADfBwAgFQAA4AcAILsDAQAAAAHBA0AAAAAB2wMAAAD1AwLuAwEAAAAB7wMCAAAAAfADAQAAAAHxAxAAAAAB8gMBAAAAAQYTAAC7BwAguwMBAAAAAdcDAQAAAAHrAxAAAAAB7AMBAAAAAe0DIAAAAAECAAAAMgAgPAAA-goAIAMAAAAyACA8AAD6CgAgPQAA-QoAIAE1AACfDAAwAgAAADIAIDUAAPkKACACAAAA2QcAIDUAAPgKACAFuwMBAPAGACHXAwEA8AYAIesDEACGBwAh7AMBAPAGACHtAyAA8gYAIQYTAAC5BwAguwMBAPAGACHXAwEA8AYAIesDEACGBwAh7AMBAPAGACHtAyAA8gYAIQYTAAC7BwAguwMBAAAAAdcDAQAAAAHrAxAAAAAB7AMBAAAAAe0DIAAAAAESBgAA-wgAIAcAAPwIACANAAD9CAAgDgAA_ggAIA8AAP8IACC7AwEAAAABwQNAAAAAAc8DAQAAAAHQAwEAAAAB0wMBAAAAAeADAQAAAAHrAxAAAAAB7AMBAAAAAYYEAAAAhgQChwQBAAAAAYgEAQAAAAGJBAEAAAABigQBAAAAAQIAAAARACA8AACDCwAgAwAAABEAIDwAAIMLACA9AACCCwAgATUAAJ4MADACAAAAEQAgNQAAggsAIAIAAACvCQAgNQAAgQsAIA27AwEA8AYAIcEDQADzBgAhzwMBAPEGACHQAwEA8QYAIdMDAQDxBgAh4AMBAPAGACHrAxAAhgcAIewDAQDwBgAhhgQAAPMIhgQihwQBAPAGACGIBAEA8QYAIYkEAQDxBgAhigQBAPEGACESBgAA9QgAIAcAAPYIACANAAD3CAAgDgAA-AgAIA8AAPkIACC7AwEA8AYAIcEDQADzBgAhzwMBAPEGACHQAwEA8QYAIdMDAQDxBgAh4AMBAPAGACHrAxAAhgcAIewDAQDwBgAhhgQAAPMIhgQihwQBAPAGACGIBAEA8QYAIYkEAQDxBgAhigQBAPEGACESBgAA-wgAIAcAAPwIACANAAD9CAAgDgAA_ggAIA8AAP8IACC7AwEAAAABwQNAAAAAAc8DAQAAAAHQAwEAAAAB0wMBAAAAAeADAQAAAAHrAxAAAAAB7AMBAAAAAYYEAAAAhgQChwQBAAAAAYgEAQAAAAGJBAEAAAABigQBAAAAAQsJAAC0CQAgFQAAtQkAICEAALYJACAjAAC3CQAguwMBAAAAAcEDQAAAAAHTAwEAAAAB2wMAAACPBAKLBAEAAAABjARAAAAAAY0EQAAAAAECAAAADQAgPAAAjwsAIAMAAAANACA8AACPCwAgPQAAjgsAIAE1AACdDAAwEQUAALsGACAJAACZBgAgFQAA4wUAICEAAKwGACAjAACtBgAguAMAAOYGADC5AwAACwAQugMAAOYGADC7AwEAAAABwQNAAPUFACHOAwEA4gUAIdMDAQD0BQAh2wMAAOcGjwQiiwQBAOIFACGMBEAAugYAIY0EQAC6BgAhtAQAAOUGACACAAAADQAgNQAAjgsAIAIAAACMCwAgNQAAjQsAIAu4AwAAiwsAMLkDAACMCwAQugMAAIsLADC7AwEA4gUAIcEDQAD1BQAhzgMBAOIFACHTAwEA9AUAIdsDAADnBo8EIosEAQDiBQAhjARAALoGACGNBEAAugYAIQu4AwAAiwsAMLkDAACMCwAQugMAAIsLADC7AwEA4gUAIcEDQAD1BQAhzgMBAOIFACHTAwEA9AUAIdsDAADnBo8EIosEAQDiBQAhjARAALoGACGNBEAAugYAIQe7AwEA8AYAIcEDQADzBgAh0wMBAPEGACHbAwAAgwmPBCKLBAEA8AYAIYwEQAD6BgAhjQRAAPoGACELCQAAhQkAIBUAAIYJACAhAACHCQAgIwAAiAkAILsDAQDwBgAhwQNAAPMGACHTAwEA8QYAIdsDAACDCY8EIosEAQDwBgAhjARAAPoGACGNBEAA-gYAIQsJAAC0CQAgFQAAtQkAICEAALYJACAjAAC3CQAguwMBAAAAAcEDQAAAAAHTAwEAAAAB2wMAAACPBAKLBAEAAAABjARAAAAAAY0EQAAAAAEEPAAAhAsAMLcEAACFCwAwuQQAAIcLACC9BAAAiAsAMAQ8AAD7CgAwtwQAAPwKADC5BAAA_goAIL0EAACrCQAwBDwAAPIKADC3BAAA8woAMLkEAAD1CgAgvQQAANUHADAEPAAA6QoAMLcEAADqCgAwuQQAAOwKACC9BAAA6QcAMAQ8AADgCgAwtwQAAOEKADC5BAAA4woAIL0EAADjCAAwBDwAANcKADC3BAAA2AoAMLkEAADaCgAgvQQAALYIADAEPAAAzgoAMLcEAADPCgAwuQQAANEKACC9BAAAiQgAMAQ8AADFCgAwtwQAAMYKADC5BAAAyAoAIL0EAACNCQAwBDwAALwKADC3BAAAvQoAMLkEAAC_CgAgvQQAAMgJADAAAAAAAAAAAAABugQAAACjBAIAAAALPAAA8AsAMD0AAPULADC3BAAA8QsAMLgEAADyCwAwuQQAAPMLACC6BAAA9AsAMLsEAAD0CwAwvAQAAPQLADC9BAAA9AsAML4EAAD2CwAwvwQAAPcLADALPAAA5wsAMD0AAOsLADC3BAAA6AsAMLgEAADpCwAwuQQAAOoLACC6BAAA1wgAMLsEAADXCAAwvAQAANcIADC9BAAA1wgAML4EAADsCwAwvwQAANoIADALPAAA3gsAMD0AAOILADC3BAAA3wsAMLgEAADgCwAwuQQAAOELACC6BAAAqggAMLsEAACqCAAwvAQAAKoIADC9BAAAqggAML4EAADjCwAwvwQAAK0IADALPAAA1QsAMD0AANkLADC3BAAA1gsAMLgEAADXCwAwuQQAANgLACC6BAAAmwcAMLsEAACbBwAwvAQAAJsHADC9BAAAmwcAML4EAADaCwAwvwQAAJ4HADALPAAAzAsAMD0AANALADC3BAAAzQsAMLgEAADOCwAwuQQAAM8LACC6BAAAjQkAMLsEAACNCQAwvAQAAI0JADC9BAAAjQkAML4EAADRCwAwvwQAAJAJADALPAAAwwsAMD0AAMcLADC3BAAAxAsAMLgEAADFCwAwuQQAAMYLACC6BAAAqwkAMLsEAACrCQAwvAQAAKsJADC9BAAAqwkAML4EAADICwAwvwQAAK4JADALPAAAugsAMD0AAL4LADC3BAAAuwsAMLgEAAC8CwAwuQQAAL0LACC6BAAAqwkAMLsEAACrCQAwvAQAAKsJADC9BAAAqwkAML4EAAC_CwAwvwQAAK4JADALPAAArgsAMD0AALMLADC3BAAArwsAMLgEAACwCwAwuQQAALELACC6BAAAsgsAMLsEAACyCwAwvAQAALILADC9BAAAsgsAML4EAAC0CwAwvwQAALULADAGuwMBAAAAAb0DAQAAAAG-AwEAAAABvwMBAAAAAcADIAAAAAHBA0AAAAABAgAAAIEBACA8AAC5CwAgAwAAAIEBACA8AAC5CwAgPQAAuAsAIAE1AACcDAAwCy4AALcGACC4AwAAtgYAMLkDAAB_ABC6AwAAtgYAMLsDAQAAAAG8AwEA4gUAIb0DAQDiBQAhvgMBAPQFACG_AwEA4gUAIcADIACmBgAhwQNAAPUFACECAAAAgQEAIDUAALgLACACAAAAtgsAIDUAALcLACAKuAMAALULADC5AwAAtgsAELoDAAC1CwAwuwMBAOIFACG8AwEA4gUAIb0DAQDiBQAhvgMBAPQFACG_AwEA4gUAIcADIACmBgAhwQNAAPUFACEKuAMAALULADC5AwAAtgsAELoDAAC1CwAwuwMBAOIFACG8AwEA4gUAIb0DAQDiBQAhvgMBAPQFACG_AwEA4gUAIcADIACmBgAhwQNAAPUFACEGuwMBAPAGACG9AwEA8AYAIb4DAQDxBgAhvwMBAPAGACHAAyAA8gYAIcEDQADzBgAhBrsDAQDwBgAhvQMBAPAGACG-AwEA8QYAIb8DAQDwBgAhwAMgAPIGACHBA0AA8wYAIQa7AwEAAAABvQMBAAAAAb4DAQAAAAG_AwEAAAABwAMgAAAAAcEDQAAAAAESBQAA-ggAIAYAAPsIACAHAAD8CAAgDQAA_QgAIA4AAP4IACC7AwEAAAABwQNAAAAAAc4DAQAAAAHPAwEAAAAB0AMBAAAAAdMDAQAAAAHgAwEAAAAB6wMQAAAAAewDAQAAAAGGBAAAAIYEAocEAQAAAAGIBAEAAAABiQQBAAAAAQIAAAARACA8AADCCwAgAwAAABEAIDwAAMILACA9AADBCwAgATUAAJsMADACAAAAEQAgNQAAwQsAIAIAAACvCQAgNQAAwAsAIA27AwEA8AYAIcEDQADzBgAhzgMBAPAGACHPAwEA8QYAIdADAQDxBgAh0wMBAPEGACHgAwEA8AYAIesDEACGBwAh7AMBAPAGACGGBAAA8wiGBCKHBAEA8AYAIYgEAQDxBgAhiQQBAPEGACESBQAA9AgAIAYAAPUIACAHAAD2CAAgDQAA9wgAIA4AAPgIACC7AwEA8AYAIcEDQADzBgAhzgMBAPAGACHPAwEA8QYAIdADAQDxBgAh0wMBAPEGACHgAwEA8AYAIesDEACGBwAh7AMBAPAGACGGBAAA8wiGBCKHBAEA8AYAIYgEAQDxBgAhiQQBAPEGACESBQAA-ggAIAYAAPsIACAHAAD8CAAgDQAA_QgAIA4AAP4IACC7AwEAAAABwQNAAAAAAc4DAQAAAAHPAwEAAAAB0AMBAAAAAdMDAQAAAAHgAwEAAAAB6wMQAAAAAewDAQAAAAGGBAAAAIYEAocEAQAAAAGIBAEAAAABiQQBAAAAARIFAAD6CAAgBgAA-wgAIAcAAPwIACANAAD9CAAgDwAA_wgAILsDAQAAAAHBA0AAAAABzgMBAAAAAc8DAQAAAAHQAwEAAAAB0wMBAAAAAesDEAAAAAHsAwEAAAABhgQAAACGBAKHBAEAAAABiAQBAAAAAYkEAQAAAAGKBAEAAAABAgAAABEAIDwAAMsLACADAAAAEQAgPAAAywsAID0AAMoLACABNQAAmgwAMAIAAAARACA1AADKCwAgAgAAAK8JACA1AADJCwAgDbsDAQDwBgAhwQNAAPMGACHOAwEA8AYAIc8DAQDxBgAh0AMBAPEGACHTAwEA8QYAIesDEACGBwAh7AMBAPAGACGGBAAA8wiGBCKHBAEA8AYAIYgEAQDxBgAhiQQBAPEGACGKBAEA8QYAIRIFAAD0CAAgBgAA9QgAIAcAAPYIACANAAD3CAAgDwAA-QgAILsDAQDwBgAhwQNAAPMGACHOAwEA8AYAIc8DAQDxBgAh0AMBAPEGACHTAwEA8QYAIesDEACGBwAh7AMBAPAGACGGBAAA8wiGBCKHBAEA8AYAIYgEAQDxBgAhiQQBAPEGACGKBAEA8QYAIRIFAAD6CAAgBgAA-wgAIAcAAPwIACANAAD9CAAgDwAA_wgAILsDAQAAAAHBA0AAAAABzgMBAAAAAc8DAQAAAAHQAwEAAAAB0wMBAAAAAesDEAAAAAHsAwEAAAABhgQAAACGBAKHBAEAAAABiAQBAAAAAYkEAQAAAAGKBAEAAAABCwUAAP4GACAGAAD_BgAguwMBAAAAAcEDQAAAAAHNAwEAAAABzgMBAAAAAc8DAQAAAAHQAwEAAAAB0gMAAADSAwLTAwEAAAAB1QNAAAAAAQIAAABdACA8AADUCwAgAwAAAF0AIDwAANQLACA9AADTCwAgATUAAJkMADACAAAAXQAgNQAA0wsAIAIAAACRCQAgNQAA0gsAIAm7AwEA8AYAIcEDQADzBgAhzQMBAPAGACHOAwEA8AYAIc8DAQDxBgAh0AMBAPEGACHSAwAA-QbSAyLTAwEA8QYAIdUDQAD6BgAhCwUAAPsGACAGAAD8BgAguwMBAPAGACHBA0AA8wYAIc0DAQDwBgAhzgMBAPAGACHPAwEA8QYAIdADAQDxBgAh0gMAAPkG0gMi0wMBAPEGACHVA0AA-gYAIQsFAAD-BgAgBgAA_wYAILsDAQAAAAHBA0AAAAABzQMBAAAAAc4DAQAAAAHPAwEAAAAB0AMBAAAAAdIDAAAA0gMC0wMBAAAAAdUDQAAAAAEREwAAjgcAIBYAAI8HACAXAACQBwAgGAAAkgcAILsDAQAAAAHBA0AAAAAB1gMBAAAAAdcDAQAAAAHYAxAAAAAB2QMQAAAAAdsDAAAA2wMC3ANAAAAAAd0DQAAAAAHeAwEAAAAB3wMBAAAAAeEDAQAAAAHiA0AAAAABAgAAACkAIDwAAN0LACADAAAAKQAgPAAA3QsAID0AANwLACABNQAAmAwAMAIAAAApACA1AADcCwAgAgAAAJ8HACA1AADbCwAgDbsDAQDwBgAhwQNAAPMGACHWAwEA8AYAIdcDAQDwBgAh2AMQAIYHACHZAxAAhwcAIdsDAACIB9sDItwDQAD6BgAh3QNAAPoGACHeAwEA8QYAId8DAQDxBgAh4QMBAPEGACHiA0AA8wYAIRETAACJBwAgFgAAigcAIBcAAIsHACAYAACNBwAguwMBAPAGACHBA0AA8wYAIdYDAQDwBgAh1wMBAPAGACHYAxAAhgcAIdkDEACHBwAh2wMAAIgH2wMi3ANAAPoGACHdA0AA-gYAId4DAQDxBgAh3wMBAPEGACHhAwEA8QYAIeIDQADzBgAhERMAAI4HACAWAACPBwAgFwAAkAcAIBgAAJIHACC7AwEAAAABwQNAAAAAAdYDAQAAAAHXAwEAAAAB2AMQAAAAAdkDEAAAAAHbAwAAANsDAtwDQAAAAAHdA0AAAAAB3gMBAAAAAd8DAQAAAAHhAwEAAAAB4gNAAAAAAQkcAACRCAAgHQAAkwgAILsDAQAAAAHBA0AAAAAB0wMBAAAAAdsDAAAA-wMC9wMBAAAAAfgDAQAAAAH7A0AAAAABAgAAAFUAIDwAAOYLACADAAAAVQAgPAAA5gsAID0AAOULACABNQAAlwwAMAIAAABVACA1AADlCwAgAgAAAK4IACA1AADkCwAgB7sDAQDwBgAhwQNAAPMGACHTAwEA8QYAIdsDAACBCPsDIvcDAQDwBgAh-AMBAPAGACH7A0AA8wYAIQkcAACCCAAgHQAAhAgAILsDAQDwBgAhwQNAAPMGACHTAwEA8QYAIdsDAACBCPsDIvcDAQDwBgAh-AMBAPAGACH7A0AA8wYAIQkcAACRCAAgHQAAkwgAILsDAQAAAAHBA0AAAAAB0wMBAAAAAdsDAAAA-wMC9wMBAAAAAfgDAQAAAAH7A0AAAAABDgQAAL8IACAaAAC-CAAgHQAAwQgAIB4AAMIIACC7AwEAAAABwQNAAAAAAdMDAQAAAAHbAwAAAIEEAuIDQAAAAAH3AwEAAAAB_gMBAAAAAf8DAQAAAAGBBEAAAAABggRAAAAAAQIAAABGACA8AADvCwAgAwAAAEYAIDwAAO8LACA9AADuCwAgATUAAJYMADACAAAARgAgNQAA7gsAIAIAAADbCAAgNQAA7QsAIAq7AwEA8AYAIcEDQADzBgAh0wMBAPEGACHbAwAAoAiBBCLiA0AA8wYAIfcDAQDwBgAh_gMBAPAGACH_AwEA8QYAIYEEQAD6BgAhggRAAPoGACEOBAAAoggAIBoAAKEIACAdAACkCAAgHgAApQgAILsDAQDwBgAhwQNAAPMGACHTAwEA8QYAIdsDAACgCIEEIuIDQADzBgAh9wMBAPAGACH-AwEA8AYAIf8DAQDxBgAhgQRAAPoGACGCBEAA-gYAIQ4EAAC_CAAgGgAAvggAIB0AAMEIACAeAADCCAAguwMBAAAAAcEDQAAAAAHTAwEAAAAB2wMAAACBBALiA0AAAAAB9wMBAAAAAf4DAQAAAAH_AwEAAAABgQRAAAAAAYIEQAAAAAEIGQAA7QgAIB0AAOwIACC7AwEAAAABwQNAAAAAAdMDAQAAAAHbAwAAAIUEAuIDQAAAAAH3AwEAAAABAgAAAAUAIDwAAPsLACADAAAABQAgPAAA-wsAID0AAPoLACABNQAAlQwAMA0DAAC3BgAgGQAAkQYAIB0AAKoGACC4AwAA6gYAMLkDAAADABC6AwAA6gYAMLsDAQAAAAHBA0AA9QUAIdMDAQD0BQAh2wMAAOsGhQQi4gNAAPUFACH3AwEAAAABgwQBAOIFACECAAAABQAgNQAA-gsAIAIAAAD4CwAgNQAA-QsAIAq4AwAA9wsAMLkDAAD4CwAQugMAAPcLADC7AwEA4gUAIcEDQAD1BQAh0wMBAPQFACHbAwAA6waFBCLiA0AA9QUAIfcDAQDiBQAhgwQBAOIFACEKuAMAAPcLADC5AwAA-AsAELoDAAD3CwAwuwMBAOIFACHBA0AA9QUAIdMDAQD0BQAh2wMAAOsGhQQi4gNAAPUFACH3AwEA4gUAIYMEAQDiBQAhBrsDAQDwBgAhwQNAAPMGACHTAwEA8QYAIdsDAADPCIUEIuIDQADzBgAh9wMBAPAGACEIGQAA0ggAIB0AANEIACC7AwEA8AYAIcEDQADzBgAh0wMBAPEGACHbAwAAzwiFBCLiA0AA8wYAIfcDAQDwBgAhCBkAAO0IACAdAADsCAAguwMBAAAAAcEDQAAAAAHTAwEAAAAB2wMAAACFBALiA0AAAAAB9wMBAAAAAQQ8AADwCwAwtwQAAPELADC5BAAA8wsAIL0EAAD0CwAwBDwAAOcLADC3BAAA6AsAMLkEAADqCwAgvQQAANcIADAEPAAA3gsAMLcEAADfCwAwuQQAAOELACC9BAAAqggAMAQ8AADVCwAwtwQAANYLADC5BAAA2AsAIL0EAACbBwAwBDwAAMwLADC3BAAAzQsAMLkEAADPCwAgvQQAAI0JADAEPAAAwwsAMLcEAADECwAwuQQAAMYLACC9BAAAqwkAMAQ8AAC6CwAwtwQAALsLADC5BAAAvQsAIL0EAACrCQAwBDwAAK4LADC3BAAArwsAMLkEAACxCwAgvQQAALILADAAAAAJFQAApAcAIBkAANsJACAeAACFDAAgIwAAngsAICsAAIQMACAsAACrCgAgLQAAqwoAIC8AAIYMACCuBAAA7AYAIA0JAACrCgAgIQAAnQsAICQAAJkLACAlAACaCwAgJgAA8gcAICcAAJsLACAoAACcCwAgKQAAngsAICoAANwJACCXBAAA7AYAIJgEAADsBgAgmQQAAOwGACCbBAAA7AYAIAgFAACIDAAgCQAAqwoAIBUAAKQHACAhAACdCwAgIwAAngsAINMDAADsBgAgjAQAAOwGACCNBAAA7AYAIAkEAACMDAAgDgAAhwwAIBoAAIsMACAdAACcCwAgHgAAhQwAINMDAADsBgAg_wMAAOwGACCBBAAA7AYAIIIEAADsBgAgBxkAANsJACAbAADcCQAgjwQAAOwGACCQBAAA7AYAIJEEAADsBgAgkgQAAOwGACCTBAAA7AYAIAQDAACHDAAgGQAA2wkAIB0AAJsLACDTAwAA7AYAIAQcAACKDAAgHQAAnQsAIB8AAIcMACDTAwAA7AYAIAURAACPDAAgEgAAiAwAIBQAAJoLACAVAACkBwAg8AMAAOwGACACEAAA8gcAIPADAADsBgAgARUAAKQHACABFQAApAcAIAIHAACTDAAgCwAAqgoAIAQJAACrCgAgCwAAqgoAIAwAAKkKACCSBAAA7AYAIAMHAACTDAAgCAAAkgwAIAkAAKsKACAGuwMBAAAAAcEDQAAAAAHTAwEAAAAB2wMAAACFBALiA0AAAAAB9wMBAAAAAQq7AwEAAAABwQNAAAAAAdMDAQAAAAHbAwAAAIEEAuIDQAAAAAH3AwEAAAAB_gMBAAAAAf8DAQAAAAGBBEAAAAABggRAAAAAAQe7AwEAAAABwQNAAAAAAdMDAQAAAAHbAwAAAPsDAvcDAQAAAAH4AwEAAAAB-wNAAAAAAQ27AwEAAAABwQNAAAAAAdYDAQAAAAHXAwEAAAAB2AMQAAAAAdkDEAAAAAHbAwAAANsDAtwDQAAAAAHdA0AAAAAB3gMBAAAAAd8DAQAAAAHhAwEAAAAB4gNAAAAAAQm7AwEAAAABwQNAAAAAAc0DAQAAAAHOAwEAAAABzwMBAAAAAdADAQAAAAHSAwAAANIDAtMDAQAAAAHVA0AAAAABDbsDAQAAAAHBA0AAAAABzgMBAAAAAc8DAQAAAAHQAwEAAAAB0wMBAAAAAesDEAAAAAHsAwEAAAABhgQAAACGBAKHBAEAAAABiAQBAAAAAYkEAQAAAAGKBAEAAAABDbsDAQAAAAHBA0AAAAABzgMBAAAAAc8DAQAAAAHQAwEAAAAB0wMBAAAAAeADAQAAAAHrAxAAAAAB7AMBAAAAAYYEAAAAhgQChwQBAAAAAYgEAQAAAAGJBAEAAAABBrsDAQAAAAG9AwEAAAABvgMBAAAAAb8DAQAAAAHAAyAAAAABwQNAAAAAAQe7AwEAAAABwQNAAAAAAdMDAQAAAAHbAwAAAI8EAosEAQAAAAGMBEAAAAABjQRAAAAAAQ27AwEAAAABwQNAAAAAAc8DAQAAAAHQAwEAAAAB0wMBAAAAAeADAQAAAAHrAxAAAAAB7AMBAAAAAYYEAAAAhgQChwQBAAAAAYgEAQAAAAGJBAEAAAABigQBAAAAAQW7AwEAAAAB1wMBAAAAAesDEAAAAAHsAwEAAAAB7QMgAAAAAQi7AwEAAAABwQNAAAAAAdsDAAAA9QMC7gMBAAAAAe8DAgAAAAHwAwEAAAAB8QMQAAAAAfIDAQAAAAEEuwMBAAAAAesDEAAAAAHsAwEAAAAB_wMBAAAAAQa7AwEAAAAB6wMQAAAAAewDAQAAAAH4AwEAAAAB_AMQAAAAAf0DEAAAAAEFuwMBAAAAAc8DAQAAAAHrAxAAAAAB7AMBAAAAAfYDAQAAAAEJuwMBAAAAAcEDQAAAAAHNAwEAAAABzwMBAAAAAdADAQAAAAHSAwAAANIDAtMDAQAAAAHUAwEAAAAB1QNAAAAAAQH-AwEAAAABBLsDAQAAAAHbAwAAAOsDAuMDAQAAAAHpAwEAAAABBbsDAQAAAAHbAwAAAOsDAuMDAQAAAAHpAwEAAAABlAQBAAAAAQ27AwEAAAABwQNAAAAAAc4DAQAAAAHPAwEAAAAB0AMBAAAAAdMDAQAAAAHgAwEAAAAB6wMQAAAAAewDAQAAAAGGBAAAAIYEAogEAQAAAAGJBAEAAAABigQBAAAAAQgJAACoCgAgCwAApwoAILsDAQAAAAHBA0AAAAAB2wMAAADrAwLjAwEAAAAB6QMBAAAAAZIEAQAAAAECAAAA0wEAIDwAAKkMACAFuwMBAAAAAdsDAAAA6wMC4wMBAAAAAekDAQAAAAGHBAEAAAABAwAAANYBACA8AACpDAAgPQAArgwAIAoAAADWAQAgCQAAhwoAIAsAAIYKACA1AACuDAAguwMBAPAGACHBA0AA8wYAIdsDAACoB-sDIuMDAQDwBgAh6QMBAPAGACGSBAEA8QYAIQgJAACHCgAgCwAAhgoAILsDAQDwBgAhwQNAAPMGACHbAwAAqAfrAyLjAwEA8AYAIekDAQDwBgAhkgQBAPEGACEICQAAqAoAIAwAAKYKACC7AwEAAAABwQNAAAAAAdsDAAAA6wMC4wMBAAAAAekDAQAAAAGSBAEAAAABAgAAANMBACA8AACvDAAgBgcAAIAKACC7AwEAAAAB2wMAAADrAwLjAwEAAAAB6QMBAAAAAYcEAQAAAAECAAAAFgAgPAAAsQwAIA27AwEAAAABwQNAAAAAAc4DAQAAAAHPAwEAAAAB0AMBAAAAAdMDAQAAAAHgAwEAAAAB6wMQAAAAAewDAQAAAAGGBAAAAIYEAocEAQAAAAGJBAEAAAABigQBAAAAAQMAAADWAQAgPAAArwwAID0AALYMACAKAAAA1gEAIAkAAIcKACAMAACFCgAgNQAAtgwAILsDAQDwBgAhwQNAAPMGACHbAwAAqAfrAyLjAwEA8AYAIekDAQDwBgAhkgQBAPEGACEICQAAhwoAIAwAAIUKACC7AwEA8AYAIcEDQADzBgAh2wMAAKgH6wMi4wMBAPAGACHpAwEA8AYAIZIEAQDxBgAhAwAAABQAIDwAALEMACA9AAC5DAAgCAAAABQAIAcAAPIJACA1AAC5DAAguwMBAPAGACHbAwAAqAfrAyLjAwEA8AYAIekDAQDwBgAhhwQBAPAGACEGBwAA8gkAILsDAQDwBgAh2wMAAKgH6wMi4wMBAPAGACHpAwEA8AYAIYcEAQDwBgAhCrsDAQAAAAHBA0AAAAAB0wMBAAAAAdsDAAAAgQQC4AMBAAAAAeIDQAAAAAH3AwEAAAAB_wMBAAAAAYEEQAAAAAGCBEAAAAABAc4DAQAAAAELGQAA2QkAILsDAQAAAAHBA0AAAAAB2wMAAADrAwLiA0AAAAAB4wMBAAAAAY8EAQAAAAGQBAEAAAABkQQBAAAAAZIEAQAAAAGTBAEAAAABAgAAAJgCACA8AAC8DAAgFQkAAJELACAhAACWCwAgJAAAkAsAICUAAJILACAmAACTCwAgJwAAlAsAICgAAJULACApAACXCwAguwMBAAAAAb8DAAAAlwQCwQNAAAAAAdsDAAAA6wMC4gNAAAAAAeMDAQAAAAHsAwEAAAABlQQBAAAAAZcEAQAAAAGYBAEAAAABmQQCAAAAAZoEIAAAAAGbBIAAAAABAgAAALoBACA8AAC-DAAgAwAAAJsCACA8AAC8DAAgPQAAwgwAIA0AAACbAgAgGQAAwgkAIDUAAMIMACC7AwEA8AYAIcEDQADzBgAh2wMAAKgH6wMi4gNAAPMGACHjAwEA8AYAIY8EAQDxBgAhkAQBAPEGACGRBAEA8QYAIZIEAQDxBgAhkwQBAPEGACELGQAAwgkAILsDAQDwBgAhwQNAAPMGACHbAwAAqAfrAyLiA0AA8wYAIeMDAQDwBgAhjwQBAPEGACGQBAEA8QYAIZEEAQDxBgAhkgQBAPEGACGTBAEA8QYAIQMAAAC9AQAgPAAAvgwAID0AAMUMACAXAAAAvQEAIAkAALQKACAhAAC5CgAgJAAAswoAICUAALUKACAmAAC2CgAgJwAAtwoAICgAALgKACApAAC6CgAgNQAAxQwAILsDAQDwBgAhvwMAALEKlwQiwQNAAPMGACHbAwAAqAfrAyLiA0AA8wYAIeMDAQDwBgAh7AMBAPAGACGVBAEA8AYAIZcEAQDxBgAhmAQBAPEGACGZBAIAsgoAIZoEIADyBgAhmwSAAAAAARUJAAC0CgAgIQAAuQoAICQAALMKACAlAAC1CgAgJgAAtgoAICcAALcKACAoAAC4CgAgKQAAugoAILsDAQDwBgAhvwMAALEKlwQiwQNAAPMGACHbAwAAqAfrAyLiA0AA8wYAIeMDAQDwBgAh7AMBAPAGACGVBAEA8AYAIZcEAQDxBgAhmAQBAPEGACGZBAIAsgoAIZoEIADyBgAhmwSAAAAAARUJAACRCwAgIQAAlgsAICUAAJILACAmAACTCwAgJwAAlAsAICgAAJULACApAACXCwAgKgAAmAsAILsDAQAAAAG_AwAAAJcEAsEDQAAAAAHbAwAAAOsDAuIDQAAAAAHjAwEAAAAB7AMBAAAAAZUEAQAAAAGXBAEAAAABmAQBAAAAAZkEAgAAAAGaBCAAAAABmwSAAAAAAQIAAAC6AQAgPAAAxgwAIA27AwEAAAABwQNAAAAAAc4DAQAAAAHQAwEAAAAB0wMBAAAAAeADAQAAAAHrAxAAAAAB7AMBAAAAAYYEAAAAhgQChwQBAAAAAYgEAQAAAAGJBAEAAAABigQBAAAAAQ27AwEAAAABwQNAAAAAAdYDAQAAAAHXAwEAAAAB2AMQAAAAAdkDEAAAAAHbAwAAANsDAtwDQAAAAAHdA0AAAAAB3gMBAAAAAd8DAQAAAAHgAwEAAAAB4gNAAAAAAQW7AwEAAAABzgMBAAAAAesDEAAAAAHsAwEAAAAB9gMBAAAAAQm7AwEAAAABwQNAAAAAAc0DAQAAAAHOAwEAAAAB0AMBAAAAAdIDAAAA0gMC0wMBAAAAAdQDAQAAAAHVA0AAAAABAwAAAL0BACA8AADGDAAgPQAAzgwAIBcAAAC9AQAgCQAAtAoAICEAALkKACAlAAC1CgAgJgAAtgoAICcAALcKACAoAAC4CgAgKQAAugoAICoAALsKACA1AADODAAguwMBAPAGACG_AwAAsQqXBCLBA0AA8wYAIdsDAACoB-sDIuIDQADzBgAh4wMBAPAGACHsAwEA8AYAIZUEAQDwBgAhlwQBAPEGACGYBAEA8QYAIZkEAgCyCgAhmgQgAPIGACGbBIAAAAABFQkAALQKACAhAAC5CgAgJQAAtQoAICYAALYKACAnAAC3CgAgKAAAuAoAICkAALoKACAqAAC7CgAguwMBAPAGACG_AwAAsQqXBCLBA0AA8wYAIdsDAACoB-sDIuIDQADzBgAh4wMBAPAGACHsAwEA8AYAIZUEAQDwBgAhlwQBAPEGACGYBAEA8QYAIZkEAgCyCgAhmgQgAPIGACGbBIAAAAABERUAAP8LACAZAAD9CwAgHgAA_gsAICMAAIAMACArAAD8CwAgLAAAgQwAIC8AAIMMACC7AwEAAAABwQNAAAAAAeIDQAAAAAGQBAEAAAABowQAAACjBAKrBAEAAAABrAQBAAAAAa0EAQAAAAGuBAEAAAABrwQgAAAAAQIAAAABACA8AADPDAAgERUAAP8LACAZAAD9CwAgHgAA_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_wsAIBkAAP0LACAeAAD-CwAgIwAAgAwAICwAAIEMACAtAACCDAAgLwAAgwwAILsDAQAAAAHBA0AAAAAB4gNAAAAAAZAEAQAAAAGjBAAAAKMEAqsEAQAAAAGsBAEAAAABrQQBAAAAAa4EAQAAAAGvBCAAAAABAgAAAAEAIDwAAO0MACAEuwMBAAAAAc4DAQAAAAHrAxAAAAAB7AMBAAAAAQq7AwEAAAABwQNAAAAAAdMDAQAAAAHbAwAAAIEEAuADAQAAAAHiA0AAAAAB9wMBAAAAAf4DAQAAAAGBBEAAAAABggRAAAAAAQMAAAAlACA8AADtDAAgPQAA8wwAIBMAAAAlACAVAACpCwAgGQAApwsAIB4AAKgLACAjAACqCwAgLAAAqwsAIC0AAKwLACAvAACtCwAgNQAA8wwAILsDAQDwBgAhwQNAAPMGACHiA0AA8wYAIZAEAQDwBgAhowQAAKILowQiqwQBAPAGACGsBAEA8AYAIa0EAQDwBgAhrgQBAPEGACGvBCAA8gYAIREVAACpCwAgGQAApwsAIB4AAKgLACAjAACqCwAgLAAAqwsAIC0AAKwLACAvAACtCwAguwMBAPAGACHBA0AA8wYAIeIDQADzBgAhkAQBAPAGACGjBAAAogujBCKrBAEA8AYAIawEAQDwBgAhrQQBAPAGACGuBAEA8QYAIa8EIADyBgAhFQkAAJELACAhAACWCwAgJAAAkAsAICUAAJILACAmAACTCwAgKAAAlQsAICkAAJcLACAqAACYCwAguwMBAAAAAb8DAAAAlwQCwQNAAAAAAdsDAAAA6wMC4gNAAAAAAeMDAQAAAAHsAwEAAAABlQQBAAAAAZcEAQAAAAGYBAEAAAABmQQCAAAAAZoEIAAAAAGbBIAAAAABAgAAALoBACA8AAD0DAAgCQMAAOsIACAZAADtCAAguwMBAAAAAcEDQAAAAAHTAwEAAAAB2wMAAACFBALiA0AAAAAB9wMBAAAAAYMEAQAAAAECAAAABQAgPAAA9gwAIAMAAAC9AQAgPAAA9AwAID0AAPoMACAXAAAAvQEAIAkAALQKACAhAAC5CgAgJAAAswoAICUAALUKACAmAAC2CgAgKAAAuAoAICkAALoKACAqAAC7CgAgNQAA-gwAILsDAQDwBgAhvwMAALEKlwQiwQNAAPMGACHbAwAAqAfrAyLiA0AA8wYAIeMDAQDwBgAh7AMBAPAGACGVBAEA8AYAIZcEAQDxBgAhmAQBAPEGACGZBAIAsgoAIZoEIADyBgAhmwSAAAAAARUJAAC0CgAgIQAAuQoAICQAALMKACAlAAC1CgAgJgAAtgoAICgAALgKACApAAC6CgAgKgAAuwoAILsDAQDwBgAhvwMAALEKlwQiwQNAAPMGACHbAwAAqAfrAyLiA0AA8wYAIeMDAQDwBgAh7AMBAPAGACGVBAEA8AYAIZcEAQDxBgAhmAQBAPEGACGZBAIAsgoAIZoEIADyBgAhmwSAAAAAAQMAAAADACA8AAD2DAAgPQAA_QwAIAsAAAADACADAADQCAAgGQAA0ggAIDUAAP0MACC7AwEA8AYAIcEDQADzBgAh0wMBAPEGACHbAwAAzwiFBCLiA0AA8wYAIfcDAQDwBgAhgwQBAPAGACEJAwAA0AgAIBkAANIIACC7AwEA8AYAIcEDQADzBgAh0wMBAPEGACHbAwAAzwiFBCLiA0AA8wYAIfcDAQDwBgAhgwQBAPAGACERFQAA_wsAIB4AAP4LACAjAACADAAgKwAA_AsAICwAAIEMACAtAACCDAAgLwAAgwwAILsDAQAAAAHBA0AAAAAB4gNAAAAAAZAEAQAAAAGjBAAAAKMEAqsEAQAAAAGsBAEAAAABrQQBAAAAAa4EAQAAAAGvBCAAAAABAgAAAAEAIDwAAP4MACAJAwAA6wgAIB0AAOwIACC7AwEAAAABwQNAAAAAAdMDAQAAAAHbAwAAAIUEAuIDQAAAAAH3AwEAAAABgwQBAAAAAQIAAAAFACA8AACADQAgCxsAANoJACC7AwEAAAABwQNAAAAAAdsDAAAA6wMC4gNAAAAAAeMDAQAAAAGPBAEAAAABkAQBAAAAAZEEAQAAAAGSBAEAAAABkwQBAAAAAQIAAACYAgAgPAAAgg0AIAa7AwEAAAABzgMBAAAAAesDEAAAAAHsAwEAAAAB_AMQAAAAAf0DEAAAAAEHuwMBAAAAAcEDQAAAAAHTAwEAAAAB2wMAAAD7AwL3AwEAAAAB-QMBAAAAAfsDQAAAAAEDAAAAJQAgPAAA_gwAID0AAIgNACATAAAAJQAgFQAAqQsAIB4AAKgLACAjAACqCwAgKwAApgsAICwAAKsLACAtAACsCwAgLwAArQsAIDUAAIgNACC7AwEA8AYAIcEDQADzBgAh4gNAAPMGACGQBAEA8AYAIaMEAACiC6MEIqsEAQDwBgAhrAQBAPAGACGtBAEA8AYAIa4EAQDxBgAhrwQgAPIGACERFQAAqQsAIB4AAKgLACAjAACqCwAgKwAApgsAICwAAKsLACAtAACsCwAgLwAArQsAILsDAQDwBgAhwQNAAPMGACHiA0AA8wYAIZAEAQDwBgAhowQAAKILowQiqwQBAPAGACGsBAEA8AYAIa0EAQDwBgAhrgQBAPEGACGvBCAA8gYAIQMAAAADACA8AACADQAgPQAAiw0AIAsAAAADACADAADQCAAgHQAA0QgAIDUAAIsNACC7AwEA8AYAIcEDQADzBgAh0wMBAPEGACHbAwAAzwiFBCLiA0AA8wYAIfcDAQDwBgAhgwQBAPAGACEJAwAA0AgAIB0AANEIACC7AwEA8AYAIcEDQADzBgAh0wMBAPEGACHbAwAAzwiFBCLiA0AA8wYAIfcDAQDwBgAhgwQBAPAGACEDAAAAmwIAIDwAAIINACA9AACODQAgDQAAAJsCACAbAADDCQAgNQAAjg0AILsDAQDwBgAhwQNAAPMGACHbAwAAqAfrAyLiA0AA8wYAIeMDAQDwBgAhjwQBAPEGACGQBAEA8QYAIZEEAQDxBgAhkgQBAPEGACGTBAEA8QYAIQsbAADDCQAguwMBAPAGACHBA0AA8wYAIdsDAACoB-sDIuIDQADzBgAh4wMBAPAGACGPBAEA8QYAIZAEAQDxBgAhkQQBAPEGACGSBAEA8QYAIZMEAQDxBgAhFQkAAJELACAhAACWCwAgJAAAkAsAICUAAJILACAmAACTCwAgJwAAlAsAICkAAJcLACAqAACYCwAguwMBAAAAAb8DAAAAlwQCwQNAAAAAAdsDAAAA6wMC4gNAAAAAAeMDAQAAAAHsAwEAAAABlQQBAAAAAZcEAQAAAAGYBAEAAAABmQQCAAAAAZoEIAAAAAGbBIAAAAABAgAAALoBACA8AACPDQAgDwQAAL8IACAOAADACAAgGgAAvggAIB4AAMIIACC7AwEAAAABwQNAAAAAAdMDAQAAAAHbAwAAAIEEAuADAQAAAAHiA0AAAAAB9wMBAAAAAf4DAQAAAAH_AwEAAAABgQRAAAAAAYIEQAAAAAECAAAARgAgPAAAkQ0AIAMAAAC9AQAgPAAAjw0AID0AAJUNACAXAAAAvQEAIAkAALQKACAhAAC5CgAgJAAAswoAICUAALUKACAmAAC2CgAgJwAAtwoAICkAALoKACAqAAC7CgAgNQAAlQ0AILsDAQDwBgAhvwMAALEKlwQiwQNAAPMGACHbAwAAqAfrAyLiA0AA8wYAIeMDAQDwBgAh7AMBAPAGACGVBAEA8AYAIZcEAQDxBgAhmAQBAPEGACGZBAIAsgoAIZoEIADyBgAhmwSAAAAAARUJAAC0CgAgIQAAuQoAICQAALMKACAlAAC1CgAgJgAAtgoAICcAALcKACApAAC6CgAgKgAAuwoAILsDAQDwBgAhvwMAALEKlwQiwQNAAPMGACHbAwAAqAfrAyLiA0AA8wYAIeMDAQDwBgAh7AMBAPAGACGVBAEA8AYAIZcEAQDxBgAhmAQBAPEGACGZBAIAsgoAIZoEIADyBgAhmwSAAAAAAQMAAABEACA8AACRDQAgPQAAmA0AIBEAAABEACAEAACiCAAgDgAAowgAIBoAAKEIACAeAAClCAAgNQAAmA0AILsDAQDwBgAhwQNAAPMGACHTAwEA8QYAIdsDAACgCIEEIuADAQDwBgAh4gNAAPMGACH3AwEA8AYAIf4DAQDwBgAh_wMBAPEGACGBBEAA-gYAIYIEQAD6BgAhDwQAAKIIACAOAACjCAAgGgAAoQgAIB4AAKUIACC7AwEA8AYAIcEDQADzBgAh0wMBAPEGACHbAwAAoAiBBCLgAwEA8AYAIeIDQADzBgAh9wMBAPAGACH-AwEA8AYAIf8DAQDxBgAhgQRAAPoGACGCBEAA-gYAIREVAAD_CwAgGQAA_QsAICMAAIAMACArAAD8CwAgLAAAgQwAIC0AAIIMACAvAACDDAAguwMBAAAAAcEDQAAAAAHiA0AAAAABkAQBAAAAAaMEAAAAowQCqwQBAAAAAawEAQAAAAGtBAEAAAABrgQBAAAAAa8EIAAAAAECAAAAAQAgPAAAmQ0AIA8EAAC_CAAgDgAAwAgAIBoAAL4IACAdAADBCAAguwMBAAAAAcEDQAAAAAHTAwEAAAAB2wMAAACBBALgAwEAAAAB4gNAAAAAAfcDAQAAAAH-AwEAAAAB_wMBAAAAAYEEQAAAAAGCBEAAAAABAgAAAEYAIDwAAJsNACAFuwMBAAAAAc4DAQAAAAHPAwEAAAAB6wMQAAAAAewDAQAAAAEDAAAAJQAgPAAAmQ0AID0AAKANACATAAAAJQAgFQAAqQsAIBkAAKcLACAjAACqCwAgKwAApgsAICwAAKsLACAtAACsCwAgLwAArQsAIDUAAKANACC7AwEA8AYAIcEDQADzBgAh4gNAAPMGACGQBAEA8AYAIaMEAACiC6MEIqsEAQDwBgAhrAQBAPAGACGtBAEA8AYAIa4EAQDxBgAhrwQgAPIGACERFQAAqQsAIBkAAKcLACAjAACqCwAgKwAApgsAICwAAKsLACAtAACsCwAgLwAArQsAILsDAQDwBgAhwQNAAPMGACHiA0AA8wYAIZAEAQDwBgAhowQAAKILowQiqwQBAPAGACGsBAEA8AYAIa0EAQDwBgAhrgQBAPEGACGvBCAA8gYAIQMAAABEACA8AACbDQAgPQAAow0AIBEAAABEACAEAACiCAAgDgAAowgAIBoAAKEIACAdAACkCAAgNQAAow0AILsDAQDwBgAhwQNAAPMGACHTAwEA8QYAIdsDAACgCIEEIuADAQDwBgAh4gNAAPMGACH3AwEA8AYAIf4DAQDwBgAh_wMBAPEGACGBBEAA-gYAIYIEQAD6BgAhDwQAAKIIACAOAACjCAAgGgAAoQgAIB0AAKQIACC7AwEA8AYAIcEDQADzBgAh0wMBAPEGACHbAwAAoAiBBCLgAwEA8AYAIeIDQADzBgAh9wMBAPAGACH-AwEA8AYAIf8DAQDxBgAhgQRAAPoGACGCBEAA-gYAIQwFAACzCQAgCQAAtAkAIBUAALUJACAjAAC3CQAguwMBAAAAAcEDQAAAAAHOAwEAAAAB0wMBAAAAAdsDAAAAjwQCiwQBAAAAAYwEQAAAAAGNBEAAAAABAgAAAA0AIDwAAKQNACAVCQAAkQsAICQAAJALACAlAACSCwAgJgAAkwsAICcAAJQLACAoAACVCwAgKQAAlwsAICoAAJgLACC7AwEAAAABvwMAAACXBALBA0AAAAAB2wMAAADrAwLiA0AAAAAB4wMBAAAAAewDAQAAAAGVBAEAAAABlwQBAAAAAZgEAQAAAAGZBAIAAAABmgQgAAAAAZsEgAAAAAECAAAAugEAIDwAAKYNACAKHAAAkQgAIB8AAJIIACC7AwEAAAABwQNAAAAAAdMDAQAAAAHbAwAAAPsDAvcDAQAAAAH4AwEAAAAB-QMBAAAAAfsDQAAAAAECAAAAVQAgPAAAqA0AIAMAAAALACA8AACkDQAgPQAArA0AIA4AAAALACAFAACECQAgCQAAhQkAIBUAAIYJACAjAACICQAgNQAArA0AILsDAQDwBgAhwQNAAPMGACHOAwEA8AYAIdMDAQDxBgAh2wMAAIMJjwQiiwQBAPAGACGMBEAA-gYAIY0EQAD6BgAhDAUAAIQJACAJAACFCQAgFQAAhgkAICMAAIgJACC7AwEA8AYAIcEDQADzBgAhzgMBAPAGACHTAwEA8QYAIdsDAACDCY8EIosEAQDwBgAhjARAAPoGACGNBEAA-gYAIQMAAAC9AQAgPAAApg0AID0AAK8NACAXAAAAvQEAIAkAALQKACAkAACzCgAgJQAAtQoAICYAALYKACAnAAC3CgAgKAAAuAoAICkAALoKACAqAAC7CgAgNQAArw0AILsDAQDwBgAhvwMAALEKlwQiwQNAAPMGACHbAwAAqAfrAyLiA0AA8wYAIeMDAQDwBgAh7AMBAPAGACGVBAEA8AYAIZcEAQDxBgAhmAQBAPEGACGZBAIAsgoAIZoEIADyBgAhmwSAAAAAARUJAAC0CgAgJAAAswoAICUAALUKACAmAAC2CgAgJwAAtwoAICgAALgKACApAAC6CgAgKgAAuwoAILsDAQDwBgAhvwMAALEKlwQiwQNAAPMGACHbAwAAqAfrAyLiA0AA8wYAIeMDAQDwBgAh7AMBAPAGACGVBAEA8AYAIZcEAQDxBgAhmAQBAPEGACGZBAIAsgoAIZoEIADyBgAhmwSAAAAAAQMAAABTACA8AACoDQAgPQAAsg0AIAwAAABTACAcAACCCAAgHwAAgwgAIDUAALINACC7AwEA8AYAIcEDQADzBgAh0wMBAPEGACHbAwAAgQj7AyL3AwEA8AYAIfgDAQDwBgAh-QMBAPAGACH7A0AA8wYAIQocAACCCAAgHwAAgwgAILsDAQDwBgAhwQNAAPMGACHTAwEA8QYAIdsDAACBCPsDIvcDAQDwBgAh-AMBAPAGACH5AwEA8AYAIfsDQADzBgAhCLsDAQAAAAHBA0AAAAAB2wMAAAD1AwLvAwIAAAAB8AMBAAAAAfEDEAAAAAHyAwEAAAAB8wMBAAAAARUJAACRCwAgIQAAlgsAICQAAJALACAlAACSCwAgJwAAlAsAICgAAJULACApAACXCwAgKgAAmAsAILsDAQAAAAG_AwAAAJcEAsEDQAAAAAHbAwAAAOsDAuIDQAAAAAHjAwEAAAAB7AMBAAAAAZUEAQAAAAGXBAEAAAABmAQBAAAAAZkEAgAAAAGaBCAAAAABmwSAAAAAAQIAAAC6AQAgPAAAtA0AIAW7AwEAAAABwQNAAAAAAeIDQAAAAAHwAwEAAAAB9QMBAAAAAQIAAAD_AwAgPAAAtg0AIAW7AwEAAAABzgMBAAAAAesDEAAAAAHsAwEAAAAB7QMgAAAAAQ27AwEAAAABwQNAAAAAAdYDAQAAAAHYAxAAAAAB2QMQAAAAAdsDAAAA2wMC3ANAAAAAAd0DQAAAAAHeAwEAAAAB3wMBAAAAAeADAQAAAAHhAwEAAAAB4gNAAAAAAQMAAAC9AQAgPAAAtA0AID0AALwNACAXAAAAvQEAIAkAALQKACAhAAC5CgAgJAAAswoAICUAALUKACAnAAC3CgAgKAAAuAoAICkAALoKACAqAAC7CgAgNQAAvA0AILsDAQDwBgAhvwMAALEKlwQiwQNAAPMGACHbAwAAqAfrAyLiA0AA8wYAIeMDAQDwBgAh7AMBAPAGACGVBAEA8AYAIZcEAQDxBgAhmAQBAPEGACGZBAIAsgoAIZoEIADyBgAhmwSAAAAAARUJAAC0CgAgIQAAuQoAICQAALMKACAlAAC1CgAgJwAAtwoAICgAALgKACApAAC6CgAgKgAAuwoAILsDAQDwBgAhvwMAALEKlwQiwQNAAPMGACHbAwAAqAfrAyLiA0AA8wYAIeMDAQDwBgAh7AMBAPAGACGVBAEA8AYAIZcEAQDxBgAhmAQBAPEGACGZBAIAsgoAIZoEIADyBgAhmwSAAAAAAQMAAACCBAAgPAAAtg0AID0AAL8NACAHAAAAggQAIDUAAL8NACC7AwEA8AYAIcEDQADzBgAh4gNAAPMGACHwAwEA8QYAIfUDAQDwBgAhBbsDAQDwBgAhwQNAAPMGACHiA0AA8wYAIfADAQDxBgAh9QMBAPAGACEVCQAAkQsAICEAAJYLACAkAACQCwAgJgAAkwsAICcAAJQLACAoAACVCwAgKQAAlwsAICoAAJgLACC7AwEAAAABvwMAAACXBALBA0AAAAAB2wMAAADrAwLiA0AAAAAB4wMBAAAAAewDAQAAAAGVBAEAAAABlwQBAAAAAZgEAQAAAAGZBAIAAAABmgQgAAAAAZsEgAAAAAECAAAAugEAIDwAAMANACAMEQAA3QcAIBIAAN4HACAVAADgBwAguwMBAAAAAcEDQAAAAAHbAwAAAPUDAu4DAQAAAAHvAwIAAAAB8AMBAAAAAfEDEAAAAAHyAwEAAAAB8wMBAAAAAQIAAAAtACA8AADCDQAgAwAAAL0BACA8AADADQAgPQAAxg0AIBcAAAC9AQAgCQAAtAoAICEAALkKACAkAACzCgAgJgAAtgoAICcAALcKACAoAAC4CgAgKQAAugoAICoAALsKACA1AADGDQAguwMBAPAGACG_AwAAsQqXBCLBA0AA8wYAIdsDAACoB-sDIuIDQADzBgAh4wMBAPAGACHsAwEA8AYAIZUEAQDwBgAhlwQBAPEGACGYBAEA8QYAIZkEAgCyCgAhmgQgAPIGACGbBIAAAAABFQkAALQKACAhAAC5CgAgJAAAswoAICYAALYKACAnAAC3CgAgKAAAuAoAICkAALoKACAqAAC7CgAguwMBAPAGACG_AwAAsQqXBCLBA0AA8wYAIdsDAACoB-sDIuIDQADzBgAh4wMBAPAGACHsAwEA8AYAIZUEAQDwBgAhlwQBAPEGACGYBAEA8QYAIZkEAgCyCgAhmgQgAPIGACGbBIAAAAABAwAAACsAIDwAAMINACA9AADJDQAgDgAAACsAIBEAAMQHACASAADFBwAgFQAAxwcAIDUAAMkNACC7AwEA8AYAIcEDQADzBgAh2wMAAMMH9QMi7gMBAPAGACHvAwIAwgcAIfADAQDxBgAh8QMQAIYHACHyAwEA8AYAIfMDAQDwBgAhDBEAAMQHACASAADFBwAgFQAAxwcAILsDAQDwBgAhwQNAAPMGACHbAwAAwwf1AyLuAwEA8AYAIe8DAgDCBwAh8AMBAPEGACHxAxAAhgcAIfIDAQDwBgAh8wMBAPAGACENuwMBAAAAAcEDQAAAAAHWAwEAAAAB1wMBAAAAAdgDEAAAAAHZAxAAAAAB2wMAAADbAwLcA0AAAAAB3QNAAAAAAd8DAQAAAAHgAwEAAAAB4QMBAAAAAeIDQAAAAAENuwMBAAAAAcEDQAAAAAHWAwEAAAAB1wMBAAAAAdgDEAAAAAHZAxAAAAAB2wMAAADbAwLcA0AAAAAB3QNAAAAAAd4DAQAAAAHgAwEAAAAB4QMBAAAAAeIDQAAAAAEMBQAAswkAIAkAALQJACAhAAC2CQAgIwAAtwkAILsDAQAAAAHBA0AAAAABzgMBAAAAAdMDAQAAAAHbAwAAAI8EAosEAQAAAAGMBEAAAAABjQRAAAAAAQIAAAANACA8AADMDQAgERkAAP0LACAeAAD-CwAgIwAAgAwAICsAAPwLACAsAACBDAAgLQAAggwAIC8AAIMMACC7AwEAAAABwQNAAAAAAeIDQAAAAAGQBAEAAAABowQAAACjBAKrBAEAAAABrAQBAAAAAa0EAQAAAAGuBAEAAAABrwQgAAAAAQIAAAABACA8AADODQAgBLsDAQAAAAHjAwEAAAAB5AMBAAAAAeUDAQAAAAECAAAA3AQAIDwAANANACAEuwMBAAAAAdsDAAAA6wMC4wMBAAAAAekDAQAAAAECAAAAxAQAIDwAANINACAMEQAA3QcAIBIAAN4HACAUAADfBwAguwMBAAAAAcEDQAAAAAHbAwAAAPUDAu4DAQAAAAHvAwIAAAAB8AMBAAAAAfEDEAAAAAHyAwEAAAAB8wMBAAAAAQIAAAAtACA8AADUDQAgAwAAAAsAIDwAAMwNACA9AADYDQAgDgAAAAsAIAUAAIQJACAJAACFCQAgIQAAhwkAICMAAIgJACA1AADYDQAguwMBAPAGACHBA0AA8wYAIc4DAQDwBgAh0wMBAPEGACHbAwAAgwmPBCKLBAEA8AYAIYwEQAD6BgAhjQRAAPoGACEMBQAAhAkAIAkAAIUJACAhAACHCQAgIwAAiAkAILsDAQDwBgAhwQNAAPMGACHOAwEA8AYAIdMDAQDxBgAh2wMAAIMJjwQiiwQBAPAGACGMBEAA-gYAIY0EQAD6BgAhAwAAACUAIDwAAM4NACA9AADbDQAgEwAAACUAIBkAAKcLACAeAACoCwAgIwAAqgsAICsAAKYLACAsAACrCwAgLQAArAsAIC8AAK0LACA1AADbDQAguwMBAPAGACHBA0AA8wYAIeIDQADzBgAhkAQBAPAGACGjBAAAogujBCKrBAEA8AYAIawEAQDwBgAhrQQBAPAGACGuBAEA8QYAIa8EIADyBgAhERkAAKcLACAeAACoCwAgIwAAqgsAICsAAKYLACAsAACrCwAgLQAArAsAIC8AAK0LACC7AwEA8AYAIcEDQADzBgAh4gNAAPMGACGQBAEA8AYAIaMEAACiC6MEIqsEAQDwBgAhrAQBAPAGACGtBAEA8AYAIa4EAQDxBgAhrwQgAPIGACEDAAAAOwAgPAAA0A0AID0AAN4NACAGAAAAOwAgNQAA3g0AILsDAQDwBgAh4wMBAPAGACHkAwEA8AYAIeUDAQDwBgAhBLsDAQDwBgAh4wMBAPAGACHkAwEA8AYAIeUDAQDwBgAhAwAAADcAIDwAANINACA9AADhDQAgBgAAADcAIDUAAOENACC7AwEA8AYAIdsDAACoB-sDIuMDAQDwBgAh6QMBAPAGACEEuwMBAPAGACHbAwAAqAfrAyLjAwEA8AYAIekDAQDwBgAhAwAAACsAIDwAANQNACA9AADkDQAgDgAAACsAIBEAAMQHACASAADFBwAgFAAAxgcAIDUAAOQNACC7AwEA8AYAIcEDQADzBgAh2wMAAMMH9QMi7gMBAPAGACHvAwIAwgcAIfADAQDxBgAh8QMQAIYHACHyAwEA8AYAIfMDAQDwBgAhDBEAAMQHACASAADFBwAgFAAAxgcAILsDAQDwBgAhwQNAAPMGACHbAwAAwwf1AyLuAwEA8AYAIe8DAgDCBwAh8AMBAPEGACHxAxAAhgcAIfIDAQDwBgAh8wMBAPAGACERFQAA_wsAIBkAAP0LACAeAAD-CwAgKwAA_AsAICwAAIEMACAtAACCDAAgLwAAgwwAILsDAQAAAAHBA0AAAAAB4gNAAAAAAZAEAQAAAAGjBAAAAKMEAqsEAQAAAAGsBAEAAAABrQQBAAAAAa4EAQAAAAGvBCAAAAABAgAAAAEAIDwAAOUNACAMBQAAswkAIAkAALQJACAVAAC1CQAgIQAAtgkAILsDAQAAAAHBA0AAAAABzgMBAAAAAdMDAQAAAAHbAwAAAI8EAosEAQAAAAGMBEAAAAABjQRAAAAAAQIAAAANACA8AADnDQAgFQkAAJELACAhAACWCwAgJAAAkAsAICUAAJILACAmAACTCwAgJwAAlAsAICgAAJULACAqAACYCwAguwMBAAAAAb8DAAAAlwQCwQNAAAAAAdsDAAAA6wMC4gNAAAAAAeMDAQAAAAHsAwEAAAABlQQBAAAAAZcEAQAAAAGYBAEAAAABmQQCAAAAAZoEIAAAAAGbBIAAAAABAgAAALoBACA8AADpDQAgAwAAACUAIDwAAOUNACA9AADtDQAgEwAAACUAIBUAAKkLACAZAACnCwAgHgAAqAsAICsAAKYLACAsAACrCwAgLQAArAsAIC8AAK0LACA1AADtDQAguwMBAPAGACHBA0AA8wYAIeIDQADzBgAhkAQBAPAGACGjBAAAogujBCKrBAEA8AYAIawEAQDwBgAhrQQBAPAGACGuBAEA8QYAIa8EIADyBgAhERUAAKkLACAZAACnCwAgHgAAqAsAICsAAKYLACAsAACrCwAgLQAArAsAIC8AAK0LACC7AwEA8AYAIcEDQADzBgAh4gNAAPMGACGQBAEA8AYAIaMEAACiC6MEIqsEAQDwBgAhrAQBAPAGACGtBAEA8AYAIa4EAQDxBgAhrwQgAPIGACEDAAAACwAgPAAA5w0AID0AAPANACAOAAAACwAgBQAAhAkAIAkAAIUJACAVAACGCQAgIQAAhwkAIDUAAPANACC7AwEA8AYAIcEDQADzBgAhzgMBAPAGACHTAwEA8QYAIdsDAACDCY8EIosEAQDwBgAhjARAAPoGACGNBEAA-gYAIQwFAACECQAgCQAAhQkAIBUAAIYJACAhAACHCQAguwMBAPAGACHBA0AA8wYAIc4DAQDwBgAh0wMBAPEGACHbAwAAgwmPBCKLBAEA8AYAIYwEQAD6BgAhjQRAAPoGACEDAAAAvQEAIDwAAOkNACA9AADzDQAgFwAAAL0BACAJAAC0CgAgIQAAuQoAICQAALMKACAlAAC1CgAgJgAAtgoAICcAALcKACAoAAC4CgAgKgAAuwoAIDUAAPMNACC7AwEA8AYAIb8DAACxCpcEIsEDQADzBgAh2wMAAKgH6wMi4gNAAPMGACHjAwEA8AYAIewDAQDwBgAhlQQBAPAGACGXBAEA8QYAIZgEAQDxBgAhmQQCALIKACGaBCAA8gYAIZsEgAAAAAEVCQAAtAoAICEAALkKACAkAACzCgAgJQAAtQoAICYAALYKACAnAAC3CgAgKAAAuAoAICoAALsKACC7AwEA8AYAIb8DAACxCpcEIsEDQADzBgAh2wMAAKgH6wMi4gNAAPMGACHjAwEA8AYAIewDAQDwBgAhlQQBAPAGACGXBAEA8QYAIZgEAQDxBgAhmQQCALIKACGaBCAA8gYAIZsEgAAAAAERFQAA_wsAIBkAAP0LACAeAAD-CwAgIwAAgAwAICsAAPwLACAsAACBDAAgLQAAggwAILsDAQAAAAHBA0AAAAAB4gNAAAAAAZAEAQAAAAGjBAAAAKMEAqsEAQAAAAGsBAEAAAABrQQBAAAAAa4EAQAAAAGvBCAAAAABAgAAAAEAIDwAAPQNACADAAAAJQAgPAAA9A0AID0AAPgNACATAAAAJQAgFQAAqQsAIBkAAKcLACAeAACoCwAgIwAAqgsAICsAAKYLACAsAACrCwAgLQAArAsAIDUAAPgNACC7AwEA8AYAIcEDQADzBgAh4gNAAPMGACGQBAEA8AYAIaMEAACiC6MEIqsEAQDwBgAhrAQBAPAGACGtBAEA8AYAIa4EAQDxBgAhrwQgAPIGACERFQAAqQsAIBkAAKcLACAeAACoCwAgIwAAqgsAICsAAKYLACAsAACrCwAgLQAArAsAILsDAQDwBgAhwQNAAPMGACHiA0AA8wYAIZAEAQDwBgAhowQAAKILowQiqwQBAPAGACGsBAEA8AYAIa0EAQDwBgAhrgQBAPEGACGvBCAA8gYAIQkKACUVew0ZeRkeehgjfCArBgIsfQYtfgYvggEkBAMAAQoAIxl2GR0KAwIEAAIFAAQKCWUGCgAiIWoXJA4FJWYRJmcOJ2gDKGkdKWsgKmwbBgUABAkSBgoAIRUqDSFDFyNeIAYFAAQGEwUHAAcNJAkOAAEPJgEECSAGCgAMCx8JDBcIAwcABwoACwsbCQQHAAcIAAgJHAYKAAoBCR0AAQseAAMJIwALIgAMIQAFDgABEwAOFjgTFzwVGD8FBQoAEhEADxIABBQzERU0DQIKABAQLg4BEC8AAgUABBMADgIUNQAVNgACCgAUFTkNARU6AAIKABYVPQ0BFT4AAwUABAYABSAAGAQKAB8cABkdWRcfAAEGBE4CCgAeDgABGgAaHVIdHlYYAwoAHBlHGRtLGwIFAAQaABoCGUwAG00AAgUABBwAGQIdVwAeWAABHVoAAwUABAZfBSJgAQQJYQAVYgAhYwAjZAAJCW4AIXMAJG0AJW8AJnAAJ3EAKHIAKXQAKnUAAhl4AB13AAEuAAEIFYYBABmEAQAehQEAI4cBACuDAQAsiAEALYkBAC-KAQAAAAADCgAqQgArQwAsAAAAAwoAKkIAK0MALAAAAAMKADJCADNDADQAAAADCgAyQgAzQwA0AAAFCgA5QgA8QwA9ZAA6ZQA7AAAAAAAFCgA5QgA8QwA9ZAA6ZQA7AAADCgBCQgBDQwBEAAAAAwoAQkIAQ0MARAEHAAcBBwAHAwoASUIASkMASwAAAAMKAElCAEpDAEsCBwAHCAAIAgcABwgACAMKAFBCAFFDAFIAAAADCgBQQgBRQwBSAAADCgBXQgBYQwBZAAAAAwoAV0IAWEMAWQIFAAQaABoCBQAEGgAaAwoAXkIAX0MAYAAAAAMKAF5CAF9DAGABBQAEAQUABAMKAGVCAGZDAGcAAAADCgBlQgBmQwBnBgUABAbnAgUHAAcN6AIJDgABD-kCAQYFAAQG7wIFBwAHDfACCQ4AAQ_xAgEFCgBsQgBvQwBwZABtZQBuAAAAAAAFCgBsQgBvQwBwZABtZQBuAQMAAQEDAAEDCgB1QgB2QwB3AAAAAwoAdUIAdkMAdwIEAAIFAAQCBAACBQAEBQoAfEIAf0MAgAFkAH1lAH4AAAAAAAUKAHxCAH9DAIABZAB9ZQB-AwSvAwIOAAEaABoDBLUDAg4AARoAGgMKAIUBQgCGAUMAhwEAAAADCgCFAUIAhgFDAIcBAgUABBwAGQIFAAQcABkFCgCMAUIAjwFDAJABZACNAWUAjgEAAAAAAAUKAIwBQgCPAUMAkAFkAI0BZQCOAQIcABkfAAECHAAZHwABAwoAlQFCAJYBQwCXAQAAAAMKAJUBQgCWAUMAlwEDBQAEBgAFIAAYAwUABAYABSAAGAUKAJwBQgCfAUMAoAFkAJ0BZQCeAQAAAAAABQoAnAFCAJ8BQwCgAWQAnQFlAJ4BAAADCgClAUIApgFDAKcBAAAAAwoApQFCAKYBQwCnAQIRAA8SAAQCEQAPEgAEBQoArAFCAK8BQwCwAWQArQFlAK4BAAAAAAAFCgCsAUIArwFDALABZACtAWUArgECBQAEEwAOAgUABBMADgUKALUBQgC4AUMAuQFkALYBZQC3AQAAAAAABQoAtQFCALgBQwC5AWQAtgFlALcBAAADCgC-AUIAvwFDAMABAAAAAwoAvgFCAL8BQwDAAQAAAwoAxQFCAMYBQwDHAQAAAAMKAMUBQgDGAUMAxwEFDgABEwAOFv4EExf_BBUYgAUFBQ4AARMADhaGBRMXhwUVGIgFBQUKAMwBQgDPAUMA0AFkAM0BZQDOAQAAAAAABQoAzAFCAM8BQwDQAWQAzQFlAM4BAwUABAaaBQUimwUBAwUABAahBQUiogUBAwoA1QFCANYBQwDXAQAAAAMKANUBQgDWAUMA1wEBLgABAS4AAQMKANwBQgDdAUMA3gEAAAADCgDcAUIA3QFDAN4BMAIBMYsBATKNAQEzjgEBNI8BATaRAQE3kwEmOJQBJzmWAQE6mAEmO5kBKD6aAQE_mwEBQJwBJkSfASlFoAEtRqIBLkejAS5IpgEuSacBLkqoAS5LqgEuTKwBJk2tAS9OrwEuT7EBJlCyATBRswEuUrQBLlO1ASZUuAExVbkBNVa7AQRXvAEEWL8BBFnAAQRawQEEW8MBBFzFASZdxgE2XsgBBF_KASZgywE3YcwBBGLNAQRjzgEmZtEBOGfSAT5o1AEHadUBB2rYAQdr2QEHbNoBB23cAQdu3gEmb98BP3DhAQdx4wEmcuQBQHPlAQd05gEHdecBJnbqAUF36wFFeOwBCHntAQh67gEIe-8BCHzwAQh98gEIfvQBJn_1AUaAAfcBCIEB-QEmggH6AUeDAfsBCIQB_AEIhQH9ASaGAYACSIcBgQJMiAGCAgmJAYMCCYoBhAIJiwGFAgmMAYYCCY0BiAIJjgGKAiaPAYsCTZABjQIJkQGPAiaSAZACTpMBkQIJlAGSAgmVAZMCJpYBlgJPlwGXAlOYAZkCGpkBmgIamgGdAhqbAZ4CGpwBnwIanQGhAhqeAaMCJp8BpAJUoAGmAhqhAagCJqIBqQJVowGqAhqkAasCGqUBrAImpgGvAlanAbACWqgBsQIbqQGyAhuqAbMCG6sBtAIbrAG1AhutAbcCG64BuQImrwG6AluwAbwCG7EBvgImsgG_AlyzAcACG7QBwQIbtQHCAia2AcUCXbcBxgJhuAHHAgW5AcgCBboByQIFuwHKAgW8AcsCBb0BzQIFvgHPAia_AdACYsAB0gIFwQHUAibCAdUCY8MB1gIFxAHXAgXFAdgCJsYB2wJkxwHcAmjIAd0CBskB3gIGygHfAgbLAeACBswB4QIGzQHjAgbOAeUCJs8B5gJp0AHrAgbRAe0CJtIB7gJq0wHyAgbUAfMCBtUB9AIm1gH3AmvXAfgCcdgB-QIC2QH6AgLaAfsCAtsB_AIC3AH9AgLdAf8CAt4BgQMm3wGCA3LgAYQDAuEBhgMm4gGHA3PjAYgDAuQBiQMC5QGKAybmAY0DdOcBjgN46AGPAwPpAZADA-oBkQMD6wGSAwPsAZMDA-0BlQMD7gGXAybvAZgDefABmgMD8QGcAybyAZ0DevMBngMD9AGfAwP1AaADJvYBowN79wGkA4EB-AGlAxn5AaYDGfoBpwMZ-wGoAxn8AakDGf0BqwMZ_gGtAyb_Aa4DggGAArEDGYECswMmggK0A4MBgwK2AxmEArcDGYUCuAMmhgK7A4QBhwK8A4gBiAK9Ax2JAr4DHYoCvwMdiwLAAx2MAsEDHY0CwwMdjgLFAyaPAsYDiQGQAsgDHZECygMmkgLLA4oBkwLMAx2UAs0DHZUCzgMmlgLRA4sBlwLSA5EBmALTAxiZAtQDGJoC1QMYmwLWAxicAtcDGJ0C2QMYngLbAyafAtwDkgGgAt4DGKEC4AMmogLhA5MBowLiAxikAuMDGKUC5AMmpgLnA5QBpwLoA5gBqALpAxepAuoDF6oC6wMXqwLsAxesAu0DF60C7wMXrgLxAyavAvIDmQGwAvQDF7EC9gMmsgL3A5oBswL4Axe0AvkDF7UC-gMmtgL9A5sBtwL-A6EBuAKABA-5AoEED7oChAQPuwKFBA-8AoYED70CiAQPvgKKBCa_AosEogHAAo0ED8ECjwQmwgKQBKMBwwKRBA_EApIED8UCkwQmxgKWBKQBxwKXBKgByAKYBA7JApkEDsoCmgQOywKbBA7MApwEDs0CngQOzgKgBCbPAqEEqQHQAqMEDtECpQQm0gKmBKoB0wKnBA7UAqgEDtUCqQQm1gKsBKsB1wKtBLEB2AKuBBHZAq8EEdoCsAQR2wKxBBHcArIEEd0CtAQR3gK2BCbfArcEsgHgArkEEeECuwQm4gK8BLMB4wK9BBHkAr4EEeUCvwQm5gLCBLQB5wLDBLoB6ALFBBPpAsYEE-oCyAQT6wLJBBPsAsoEE-0CzAQT7gLOBCbvAs8EuwHwAtEEE_EC0wQm8gLUBLwB8wLVBBP0AtYEE_UC1wQm9gLaBL0B9wLbBMEB-ALdBBX5At4EFfoC4AQV-wLhBBX8AuIEFf0C5AQV_gLmBCb_AucEwgGAA-kEFYED6wQmggPsBMMBgwPtBBWEA-4EFYUD7wQmhgPyBMQBhwPzBMgBiAP0BA2JA_UEDYoD9gQNiwP3BA2MA_gEDY0D-gQNjgP8BCaPA_0EyQGQA4IFDZEDhAUmkgOFBcoBkwOJBQ2UA4oFDZUDiwUmlgOOBcsBlwOPBdEBmAOQBSCZA5EFIJoDkgUgmwOTBSCcA5QFIJ0DlgUgngOYBSafA5kF0gGgA50FIKEDnwUmogOgBdMBowOjBSCkA6QFIKUDpQUmpgOoBdQBpwOpBdgBqAOqBSSpA6sFJKoDrAUkqwOtBSSsA64FJK0DsAUkrgOyBSavA7MF2QGwA7UFJLEDtwUmsgO4BdoBswO5BSS0A7oFJLUDuwUmtgO-BdsBtwO_Bd8B"
};
async function decodeBase64AsWasm(wasmBase64) {
  const { Buffer: Buffer2 } = await import("node:buffer");
  const wasmArray = Buffer2.from(wasmBase64, "base64");
  return new WebAssembly.Module(wasmArray);
}
config.compilerWasm = {
  getRuntime: async () => await import("@prisma/client/runtime/query_compiler_fast_bg.postgresql.mjs"),
  getQueryCompilerWasmModule: async () => {
    const { wasm } = await import("@prisma/client/runtime/query_compiler_fast_bg.postgresql.wasm-base64.mjs");
    return await decodeBase64AsWasm(wasm);
  },
  importName: "./query_compiler_fast_bg.js"
};
function getPrismaClientClass() {
  return runtime.getPrismaClient(config);
}

// src/generated/prisma/internal/prismaNamespace.ts
import * as runtime2 from "@prisma/client/runtime/client";
var getExtensionContext = runtime2.Extensions.getExtensionContext;
var NullTypes2 = {
  DbNull: runtime2.NullTypes.DbNull,
  JsonNull: runtime2.NullTypes.JsonNull,
  AnyNull: runtime2.NullTypes.AnyNull
};
var TransactionIsolationLevel = runtime2.makeStrictEnum({
  ReadUncommitted: "ReadUncommitted",
  ReadCommitted: "ReadCommitted",
  RepeatableRead: "RepeatableRead",
  Serializable: "Serializable"
});
var defineExtension = runtime2.Extensions.defineExtension;

// src/generated/prisma/enums.ts
var LedgerEventType = {
  PO_RECEIPT: "PO_RECEIPT",
  PROD_CONSUMPTION: "PROD_CONSUMPTION",
  PROD_OUTPUT: "PROD_OUTPUT",
  WASTE: "WASTE",
  ADJUSTMENT: "ADJUSTMENT",
  TRANSFER_IN: "TRANSFER_IN",
  TRANSFER_OUT: "TRANSFER_OUT"
};

// src/generated/prisma/client.ts
globalThis["__dirname"] = path.dirname(fileURLToPath(import.meta.url));
var PrismaClient = getPrismaClientClass();

// src/lib/db.ts
import { PrismaPg } from "@prisma/adapter-pg";
var adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
var prisma = new PrismaClient({ adapter });

// src/routes/index.ts
import { Router as Router10 } from "express";

// src/routes/auth.ts
import { Router } from "express";
import { createClient } from "@supabase/supabase-js";

// src/lib/verifyToken.ts
import crypto from "crypto";
import jwt from "jsonwebtoken";
var JWKS_CACHE_TTL_MS = 5 * 60 * 1e3;
var cachedKeys = null;
var cacheFetchedAt = 0;
async function getPemKeys() {
  if (cachedKeys && Date.now() - cacheFetchedAt < JWKS_CACHE_TTL_MS) {
    return cachedKeys;
  }
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) throw new Error("SUPABASE_URL is not configured");
  const res = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const map = {};
  for (const key of data.keys) {
    const pub = crypto.createPublicKey({ key, format: "jwk" });
    map[key.kid] = pub.export({ type: "spki", format: "pem" });
  }
  cachedKeys = map;
  cacheFetchedAt = Date.now();
  return map;
}
async function verifySupabaseToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  const alg = header.alg ?? "HS256";
  if (alg === "ES256") {
    const keys = await getPemKeys();
    const kid = header.kid;
    const pem = kid && keys[kid] || Object.values(keys)[0];
    if (!pem) throw new Error("No matching JWKS key for token");
    return jwt.verify(token, pem, { algorithms: ["ES256"] });
  }
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new Error("SUPABASE_JWT_SECRET is not configured");
  return jwt.verify(token, secret, { algorithms: ["HS256"] });
}

// src/middleware/auth.ts
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: Missing token" });
  }
  const token = authHeader.split(" ")[1];
  let decoded;
  try {
    decoded = await verifySupabaseToken(token);
  } catch {
    return res.status(403).json({ error: "Forbidden: Invalid token" });
  }
  const supabaseUserId = decoded.sub;
  if (!supabaseUserId) {
    return res.status(403).json({ error: "Forbidden: Token has no subject" });
  }
  try {
    const user = await prisma.user.findUnique({ where: { id: supabaseUserId } });
    if (!user || !user.isActive) {
      return res.status(403).json({ error: "Forbidden: User not found or inactive" });
    }
    req.user = user;
    req.tokenClaims = decoded;
    next();
  } catch (error) {
    console.error("requireAuth db error:", error);
    return res.status(500).json({ error: "Database error" });
  }
}

// src/middleware/rbac.ts
function requirePermission(module, action) {
  const fieldMap = {
    create: "canCreate",
    read: "canRead",
    update: "canUpdate",
    delete: "canDelete",
    approve: "canApprove"
  };
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized: Not authenticated" });
    }
    try {
      const permission = await prisma.rolePermission.findUnique({
        where: { role_module: { role: req.user.role, module } }
      });
      const allowed = permission?.[fieldMap[action]] ?? false;
      if (!allowed) {
        return res.status(403).json({ error: `Forbidden: Missing ${action} permission on ${module}` });
      }
      next();
    } catch (error) {
      console.error("requirePermission db error:", error);
      return res.status(500).json({ error: "Database error" });
    }
  };
}

// src/routes/auth.ts
var router = Router();
router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});
router.get("/users", requireAuth, requirePermission("admin", "read"), async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        role: true,
        isActive: true,
        createdAt: true
      },
      orderBy: { createdAt: "desc" }
    });
    res.json({ users });
  } catch (error) {
    console.error("GET /auth/users error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router.post("/users", requireAuth, requirePermission("admin", "create"), async (req, res) => {
  try {
    const { firstName, lastName, email, role } = req.body;
    if (!firstName || !lastName || !email || !role) {
      return res.status(400).json({ error: "firstName, lastName, email and role are required" });
    }
    const fullName = `${firstName} ${lastName}`.trim();
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
      return res.status(500).json({ error: "Supabase admin credentials not configured" });
    }
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let tempPass = "KIB-";
    for (let i = 0; i < 6; i++) tempPass += chars[Math.floor(Math.random() * chars.length)];
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password: tempPass,
      email_confirm: true,
      user_metadata: { full_name: fullName }
    });
    if (createErr) {
      return res.status(400).json({ error: createErr.message });
    }
    const profile = await prisma.user.create({
      data: {
        id: created.user.id,
        email,
        username: email.split("@")[0],
        passwordHash: "managed-by-supabase-auth",
        fullName,
        role
      },
      select: { id: true, email: true, username: true, fullName: true, role: true, isActive: true, createdAt: true }
    });
    res.status(201).json({ user: profile, tempPass });
  } catch (error) {
    console.error("POST /auth/users error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});
router.get("/profile", requireAuth, async (req, res) => {
  try {
    const profile = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        role: true,
        phoneNumber: true,
        isActive: true,
        createdAt: true
      }
    });
    res.json({ profile });
  } catch (error) {
    console.error("GET /auth/profile error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
var auth_default = router;

// src/routes/master-data.ts
import { Router as Router2 } from "express";
var router2 = Router2();
router2.use(requireAuth);
router2.get("/warehouses", requirePermission("master_data", "read"), async (_req, res) => {
  try {
    const warehouses = await prisma.warehouse.findMany({
      orderBy: { createdAt: "asc" },
      include: {
        zones: { include: { bins: true }, orderBy: { name: "asc" } }
      }
    });
    res.json({ warehouses });
  } catch (error) {
    console.error("GET /master-data/warehouses error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router2.post("/warehouses", requirePermission("master_data", "create"), async (req, res) => {
  try {
    const { name, code, address, status } = req.body;
    if (!name || !code) {
      return res.status(400).json({ error: "name and code are required" });
    }
    const warehouse = await prisma.warehouse.create({
      data: { name, code, address, status: status ?? "ACTIVE" }
    });
    res.status(201).json({ warehouse });
  } catch (error) {
    if (error?.code === "P2002") return res.status(409).json({ error: `Warehouse code "${req.body.code}" already exists` });
    console.error("POST /master-data/warehouses error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router2.patch("/warehouses/:id", requirePermission("master_data", "update"), async (req, res) => {
  try {
    const { name, address, status } = req.body;
    const warehouse = await prisma.warehouse.update({
      where: { id: req.params.id },
      data: { name, address, status }
    });
    res.json({ warehouse });
  } catch (error) {
    console.error("PATCH /master-data/warehouses/:id error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router2.delete("/warehouses/:id", requirePermission("master_data", "delete"), async (req, res) => {
  try {
    await prisma.warehouse.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (error) {
    if (error?.code === "P2003") return res.status(409).json({ error: "Cannot delete: warehouse has zones/bins or transactions" });
    console.error("DELETE /master-data/warehouses/:id error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router2.post("/zones", requirePermission("master_data", "create"), async (req, res) => {
  try {
    const { warehouseId, name, code } = req.body;
    if (!warehouseId || !name || !code) {
      return res.status(400).json({ error: "warehouseId, name and code are required" });
    }
    const zone = await prisma.zone.create({
      data: { warehouseId, name, code }
    });
    res.status(201).json({ zone });
  } catch (error) {
    console.error("POST /master-data/zones error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router2.patch("/zones/:id", requirePermission("master_data", "update"), async (req, res) => {
  try {
    const { name, code, status } = req.body;
    const zone = await prisma.zone.update({
      where: { id: req.params.id },
      data: { name, code, status }
    });
    res.json({ zone });
  } catch (error) {
    console.error("PATCH /master-data/zones/:id error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router2.delete("/zones/:id", requirePermission("master_data", "delete"), async (req, res) => {
  try {
    await prisma.zone.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (error) {
    console.error("DELETE /master-data/zones/:id error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router2.post("/bins", requirePermission("master_data", "create"), async (req, res) => {
  try {
    const { zoneId, warehouseId, name, code } = req.body;
    if (!zoneId || !warehouseId || !name || !code) {
      return res.status(400).json({ error: "zoneId, warehouseId, name and code are required" });
    }
    const bin = await prisma.warehouseBin.create({
      data: { zoneId, warehouseId, name, code }
    });
    res.status(201).json({ bin });
  } catch (error) {
    console.error("POST /master-data/bins error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router2.patch("/bins/:id", requirePermission("master_data", "update"), async (req, res) => {
  try {
    const { name, code, status } = req.body;
    const bin = await prisma.warehouseBin.update({
      where: { id: req.params.id },
      data: { name, code, status }
    });
    res.json({ bin });
  } catch (error) {
    console.error("PATCH /master-data/bins/:id error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router2.delete("/bins/:id", requirePermission("master_data", "delete"), async (req, res) => {
  try {
    await prisma.warehouseBin.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (error) {
    console.error("DELETE /master-data/bins/:id error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router2.get("/materials", requirePermission("master_data", "read"), async (req, res) => {
  try {
    const { type, status, q, supplierId } = req.query;
    const materials = await prisma.material.findMany({
      where: {
        ...type ? { type } : {},
        ...status ? { status } : {},
        ...supplierId ? { suppliers: { some: { supplierId } } } : {},
        ...q ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { sku: { contains: q, mode: "insensitive" } },
            { barcode: { contains: q, mode: "insensitive" } }
          ]
        } : {}
      },
      include: {
        suppliers: { include: { supplier: { select: { id: true, name: true } } } }
      },
      orderBy: { createdAt: "desc" }
    });
    res.json({ materials });
  } catch (error) {
    console.error("GET /master-data/materials error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router2.post("/materials", requirePermission("master_data", "create"), async (req, res) => {
  try {
    const { name, sku, type, category, unitOfMeasure, barcode, shelfLifeDays, requiresLot, attachments, supplierIds } = req.body;
    if (!name || !sku || !type || !unitOfMeasure) {
      return res.status(400).json({ error: "name, sku, type and unitOfMeasure are required" });
    }
    const material = await prisma.material.create({
      data: {
        name,
        sku,
        type,
        category: category ?? null,
        unitOfMeasure,
        barcode: barcode ?? null,
        shelfLifeDays: shelfLifeDays ? Number(shelfLifeDays) : null,
        requiresLot: requiresLot ?? true,
        attachments: attachments ?? [],
        suppliers: Array.isArray(supplierIds) && supplierIds.length ? { create: supplierIds.map((sid) => ({ supplierId: sid })) } : void 0
      }
    });
    res.status(201).json({ material });
  } catch (error) {
    if (error?.code === "P2002") return res.status(409).json({ error: `SKU "${req.body.sku}" already exists` });
    console.error("POST /master-data/materials error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router2.patch("/materials/:id", requirePermission("master_data", "update"), async (req, res) => {
  try {
    const { name, category, unitOfMeasure, barcode, shelfLifeDays, requiresLot, attachments, status, supplierIds } = req.body;
    const material = await prisma.material.update({
      where: { id: req.params.id },
      data: {
        name,
        category,
        unitOfMeasure,
        barcode,
        shelfLifeDays: shelfLifeDays !== void 0 ? Number(shelfLifeDays) : void 0,
        requiresLot,
        attachments,
        status,
        ...Array.isArray(supplierIds) ? {
          suppliers: {
            deleteMany: {},
            create: supplierIds.map((sid) => ({ supplierId: sid }))
          }
        } : {}
      }
    });
    res.json({ material });
  } catch (error) {
    console.error("PATCH /master-data/materials/:id error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router2.get("/suppliers", requirePermission("master_data", "read"), async (req, res) => {
  try {
    const { q, status } = req.query;
    const suppliers = await prisma.supplier.findMany({
      where: {
        ...status ? { status } : {},
        ...q ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { contactPerson: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } }
          ]
        } : {}
      },
      orderBy: { createdAt: "desc" }
    });
    res.json({ suppliers });
  } catch (error) {
    console.error("GET /master-data/suppliers error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router2.post("/suppliers", requirePermission("master_data", "create"), async (req, res) => {
  try {
    const { name, contactPerson, email, phone, address, taxId } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const supplier = await prisma.supplier.create({
      data: { name, contactPerson, email, phone, address, taxId }
    });
    res.status(201).json({ supplier });
  } catch (error) {
    console.error("POST /master-data/suppliers error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router2.patch("/suppliers/:id", requirePermission("master_data", "update"), async (req, res) => {
  try {
    const { name, contactPerson, email, phone, address, taxId, status } = req.body;
    const supplier = await prisma.supplier.update({
      where: { id: req.params.id },
      data: { name, contactPerson, email, phone, address, taxId, status }
    });
    res.json({ supplier });
  } catch (error) {
    console.error("PATCH /master-data/suppliers/:id error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
var master_data_default = router2;

// src/routes/procurement.ts
import { Router as Router3 } from "express";
var router3 = Router3();
router3.use(requireAuth);
router3.get("/requisitions", requirePermission("procurement", "read"), async (req, res) => {
  try {
    const { status } = req.query;
    const requisitions = await prisma.requisition.findMany({
      where: status ? { status } : {},
      include: {
        requestedBy: { select: { id: true, fullName: true, email: true } },
        items: { include: { material: { select: { id: true, name: true, sku: true, unitOfMeasure: true } } } },
        purchaseOrders: { select: { id: true, number: true, status: true } }
      },
      orderBy: { createdAt: "desc" }
    });
    res.json({ requisitions });
  } catch (error) {
    console.error("GET /procurement/requisitions error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router3.post("/requisitions", requirePermission("procurement", "create"), async (req, res) => {
  try {
    const { notes, items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "At least one item is required" });
    }
    for (const it of items) {
      if (!it.materialId || !it.quantity || !it.unitOfMeasure) {
        return res.status(400).json({ error: "Each item needs materialId, quantity and unitOfMeasure" });
      }
    }
    const number = `REQ-${Date.now().toString().slice(-8)}`;
    const requisition = await prisma.requisition.create({
      data: {
        number,
        requestedById: req.user.id,
        notes,
        status: "DRAFT",
        items: {
          create: items.map((it) => ({
            materialId: it.materialId,
            quantity: it.quantity,
            unitOfMeasure: it.unitOfMeasure
          }))
        }
      },
      include: { items: true }
    });
    res.status(201).json({ requisition });
  } catch (error) {
    console.error("POST /procurement/requisitions error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router3.patch("/requisitions/:id/submit", requirePermission("procurement", "update"), async (req, res) => {
  try {
    const requisition = await prisma.requisition.update({
      where: { id: req.params.id },
      data: { status: "PENDING_APPROVAL" }
    });
    res.json({ requisition });
  } catch (error) {
    console.error("PATCH /procurement/requisitions/:id/submit error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router3.patch("/requisitions/:id/approve", requirePermission("procurement", "approve"), async (req, res) => {
  try {
    const requisition = await prisma.requisition.update({
      where: { id: req.params.id },
      data: { status: "APPROVED" }
    });
    res.json({ requisition });
  } catch (error) {
    console.error("PATCH /procurement/requisitions/:id/approve error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router3.patch("/requisitions/:id/reject", requirePermission("procurement", "approve"), async (req, res) => {
  try {
    const requisition = await prisma.requisition.update({
      where: { id: req.params.id },
      data: { status: "REJECTED" }
    });
    res.json({ requisition });
  } catch (error) {
    console.error("PATCH /procurement/requisitions/:id/reject error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router3.get("/purchase-orders", requirePermission("procurement", "read"), async (req, res) => {
  try {
    const { status } = req.query;
    const purchaseOrders = await prisma.purchaseOrder.findMany({
      where: status ? { status } : {},
      include: {
        supplier: { select: { id: true, name: true } },
        requisition: { select: { id: true, number: true, status: true } },
        createdBy: { select: { id: true, fullName: true } },
        items: { include: { material: { select: { id: true, name: true, sku: true, unitOfMeasure: true } } } }
      },
      orderBy: { createdAt: "desc" }
    });
    res.json({ purchaseOrders });
  } catch (error) {
    console.error("GET /procurement/purchase-orders error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router3.post("/purchase-orders", requirePermission("procurement", "create"), async (req, res) => {
  try {
    const { supplierId, requisitionId, notes, expectedDelivery, items } = req.body;
    if (!supplierId) return res.status(400).json({ error: "supplierId is required" });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "At least one item is required" });
    }
    let poItems = items;
    if (requisitionId) {
      const req2 = await prisma.requisition.findUnique({
        where: { id: requisitionId },
        include: { items: true }
      });
      if (!req2) return res.status(404).json({ error: "Requisition not found" });
      if (req2.status !== "APPROVED") return res.status(400).json({ error: "Requisition must be APPROVED first" });
      poItems = req2.items.map((it) => ({
        materialId: it.materialId,
        quantity: it.quantity,
        unitCost: 0,
        // set by procurement officer
        unitOfMeasure: it.unitOfMeasure
      }));
    }
    const number = `PO-${Date.now().toString().slice(-8)}`;
    const purchaseOrder = await prisma.purchaseOrder.create({
      data: {
        number,
        supplierId,
        requisitionId: requisitionId ?? null,
        createdById: req.user.id,
        status: "DRAFT",
        notes,
        expectedDelivery: expectedDelivery ? new Date(expectedDelivery) : null,
        items: {
          create: poItems.map((it) => ({
            materialId: it.materialId,
            quantity: it.quantity,
            unitCost: it.unitCost ?? 0,
            unitOfMeasure: it.unitOfMeasure
          }))
        }
      },
      include: { items: true }
    });
    res.status(201).json({ purchaseOrder });
  } catch (error) {
    console.error("POST /procurement/purchase-orders error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router3.patch("/purchase-orders/:id/status", requirePermission("procurement", "update"), async (req, res) => {
  try {
    const { status } = req.body;
    if (!["DRAFT", "SENT", "PARTIAL", "RECEIVED", "CLOSED"].includes(status)) {
      return res.status(400).json({ error: "Invalid PO status" });
    }
    const purchaseOrder = await prisma.purchaseOrder.update({
      where: { id: req.params.id },
      data: { status }
    });
    res.json({ purchaseOrder });
  } catch (error) {
    console.error("PATCH /procurement/purchase-orders/:id/status error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
var procurement_default = router3;

// src/routes/grn.ts
import { Router as Router4 } from "express";

// src/lib/ledger.ts
async function postLedgerEntry(tx, input) {
  if (input.quantity === 0) throw new Error("Ledger entries cannot have zero quantity");
  return tx.inventoryTransaction.create({
    data: {
      eventType: input.eventType,
      materialId: input.materialId,
      batchLotId: input.batchLotId ?? null,
      warehouseId: input.warehouseId,
      binId: input.binId ?? null,
      quantity: input.quantity,
      unitOfMeasure: input.unitOfMeasure,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      createdById: input.createdById,
      approvedById: input.approvedById ?? null,
      notes: input.notes ?? null
    }
  });
}
async function getStock(prisma2, filters) {
  const where = {};
  if (filters?.materialId) where.materialId = filters.materialId;
  if (filters?.warehouseId) where.warehouseId = filters.warehouseId;
  if (filters?.batchLotId) where.batchLotId = filters.batchLotId;
  const grouped = await prisma2.inventoryTransaction.groupBy({
    by: ["materialId", "warehouseId", "batchLotId", "binId", "unitOfMeasure"],
    where,
    _sum: { quantity: true }
  });
  const materialIds = [...new Set(grouped.map((g) => g.materialId))];
  const warehouseIds = [...new Set(grouped.map((g) => g.warehouseId))];
  const batchIds = [...new Set(grouped.map((g) => g.batchLotId).filter(Boolean))];
  const [materials, warehouses, batches] = await Promise.all([
    prisma2.material.findMany({ where: { id: { in: materialIds } }, select: { id: true, name: true, sku: true, unitOfMeasure: true } }),
    prisma2.warehouse.findMany({ where: { id: { in: warehouseIds } }, select: { id: true, name: true } }),
    batchIds.length ? prisma2.batchLot.findMany({ where: { id: { in: batchIds } }, select: { id: true, batchNumber: true } }) : Promise.resolve([])
  ]);
  const matMap = new Map(materials.map((m) => [m.id, m]));
  const whMap = new Map(warehouses.map((w) => [w.id, w]));
  const batchMap = new Map(batches.map((b) => [b.id, b]));
  return grouped.filter((g) => (g._sum.quantity ?? 0) !== 0).map((g) => ({
    materialId: g.materialId,
    materialName: matMap.get(g.materialId)?.name ?? g.materialId,
    sku: matMap.get(g.materialId)?.sku ?? "",
    unitOfMeasure: g.unitOfMeasure,
    batchLotId: g.batchLotId,
    batchNumber: g.batchLotId ? batchMap.get(g.batchLotId)?.batchNumber ?? null : null,
    warehouseId: g.warehouseId,
    warehouseName: whMap.get(g.warehouseId)?.name ?? g.warehouseId,
    binId: g.binId,
    quantity: Number(g._sum.quantity ?? 0)
  })).sort((a, b) => a.quantity < b.quantity ? 1 : -1);
}
async function getLedgerHistory(prisma2, filters) {
  return prisma2.inventoryTransaction.findMany({
    where: {
      ...filters?.materialId ? { materialId: filters.materialId } : {},
      ...filters?.batchLotId ? { batchLotId: filters.batchLotId } : {}
    },
    include: {
      material: { select: { name: true, sku: true } },
      batchLot: { select: { batchNumber: true } },
      warehouse: { select: { name: true } },
      createdBy: { select: { fullName: true, email: true } },
      approvedBy: { select: { fullName: true } }
    },
    orderBy: { createdAt: "desc" }
  });
}

// src/routes/grn.ts
var router4 = Router4();
router4.use(requireAuth);
router4.get("/", requirePermission("procurement", "read"), async (req, res) => {
  try {
    const { status } = req.query;
    const grns = await prisma.goodsReceipt.findMany({
      where: status ? { status } : {},
      include: {
        po: { select: { id: true, number: true, status: true, supplier: { select: { name: true } } } },
        receivedBy: { select: { fullName: true, email: true } },
        items: {
          include: {
            material: { select: { name: true, sku: true } },
            batchLot: { select: { id: true, batchNumber: true, expiryDate: true, status: true } }
          }
        }
      },
      orderBy: { receivedAt: "desc" }
    });
    res.json({ grns });
  } catch (error) {
    console.error("GET /grn error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router4.post("/grn", requirePermission("procurement", "create"), async (req, res) => {
  try {
    const { poId, notes, items } = req.body;
    if (!poId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "poId and items are required" });
    }
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: { items: true }
    });
    if (!po) return res.status(404).json({ error: "Purchase order not found" });
    if (po.status === "CLOSED") return res.status(400).json({ error: "PO is already closed" });
    const number = `GRN-${Date.now().toString().slice(-8)}`;
    const grn = await prisma.$transaction(async (tx) => {
      const receipt = await tx.goodsReceipt.create({
        data: {
          number,
          poId,
          receivedById: req.user.id,
          status: "PENDING_QA",
          receivedAt: /* @__PURE__ */ new Date(),
          notes
        }
      });
      for (const it of items) {
        const { materialId, quantity, unitOfMeasure, batchNumber, expiryDate, manufacturingDate, warehouseId } = it;
        if (!materialId || !quantity || !unitOfMeasure || !batchNumber || !warehouseId) {
          throw new Error("Each item needs materialId, quantity, unitOfMeasure, batchNumber and warehouseId");
        }
        const batchLot = await tx.batchLot.upsert({
          where: { materialId_batchNumber: { materialId, batchNumber } },
          update: {},
          create: {
            materialId,
            batchNumber,
            expiryDate: expiryDate ? new Date(expiryDate) : null,
            manufacturingDate: manufacturingDate ? new Date(manufacturingDate) : null
          }
        });
        await tx.goodsReceiptItem.create({
          data: {
            grnId: receipt.id,
            materialId,
            batchLotId: batchLot.id,
            quantity,
            unitOfMeasure
          }
        });
        await postLedgerEntry(tx, {
          eventType: LedgerEventType.PO_RECEIPT,
          materialId,
          batchLotId: batchLot.id,
          warehouseId,
          quantity: Number(quantity),
          unitOfMeasure,
          referenceType: "GRN",
          referenceId: receipt.id,
          createdById: req.user.id,
          notes: `GRN ${number} against PO ${po.number}`
        });
        await tx.inspectionRecord.create({
          data: {
            inspectionType: "GRN",
            materialId,
            batchLotId: batchLot.id,
            referenceId: receipt.id,
            result: "PENDING"
          }
        });
        const poItem = po.items.find((p) => p.materialId === materialId);
        if (poItem) {
          await tx.purchaseOrderItem.update({
            where: { id: poItem.id },
            data: { receivedQty: { increment: Number(quantity) } }
          });
        }
      }
      const allReceived = po.items.every((p) => {
        const item = items.filter((i) => i.materialId === p.materialId);
        return item.reduce((s, i) => s + Number(i.quantity), 0) >= Number(p.quantity);
      });
      await tx.purchaseOrder.update({
        where: { id: poId },
        data: { status: allReceived ? "RECEIVED" : "PARTIAL" }
      });
      return receipt;
    });
    res.status(201).json({ grn });
  } catch (error) {
    console.error("POST /grn error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});
var grn_default = router4;

// src/routes/inventory.ts
import { Router as Router5 } from "express";
var router5 = Router5();
router5.use(requireAuth);
router5.get("/stock", requirePermission("inventory", "read"), async (req, res) => {
  try {
    const stock = await getStock(prisma, {
      materialId: req.query.materialId || void 0,
      warehouseId: req.query.warehouseId || void 0,
      batchLotId: req.query.batchLotId || void 0
    });
    res.json({ stock });
  } catch (error) {
    console.error("GET /stock error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router5.get("/stock/history", requirePermission("inventory", "read"), async (req, res) => {
  try {
    const history = await getLedgerHistory(prisma, {
      materialId: req.query.materialId || void 0,
      batchLotId: req.query.batchLotId || void 0
    });
    res.json({ history });
  } catch (error) {
    console.error("GET /stock/history error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router5.post("/stock/transfer", requirePermission("inventory", "create"), async (req, res) => {
  try {
    const { materialId, batchLotId, quantity, unitOfMeasure, fromWarehouseId, toWarehouseId, fromBinId, toBinId, notes } = req.body;
    if (!materialId || !quantity || !unitOfMeasure || !fromWarehouseId || !toWarehouseId) {
      return res.status(400).json({ error: "materialId, quantity, unitOfMeasure, fromWarehouseId and toWarehouseId are required" });
    }
    if (fromWarehouseId === toWarehouseId) {
      return res.status(400).json({ error: "Source and destination warehouses must differ" });
    }
    const result = await prisma.$transaction(async (tx) => {
      await postLedgerEntry(tx, {
        eventType: LedgerEventType.TRANSFER_OUT,
        materialId,
        batchLotId: batchLotId ?? null,
        warehouseId: fromWarehouseId,
        binId: fromBinId ?? null,
        quantity: -Number(quantity),
        unitOfMeasure,
        referenceType: "TRANSFER",
        createdById: req.user.id,
        notes: notes ?? null
      });
      const entry = await postLedgerEntry(tx, {
        eventType: LedgerEventType.TRANSFER_IN,
        materialId,
        batchLotId: batchLotId ?? null,
        warehouseId: toWarehouseId,
        binId: toBinId ?? null,
        quantity: Number(quantity),
        unitOfMeasure,
        referenceType: "TRANSFER",
        createdById: req.user.id,
        notes: notes ?? null
      });
      return entry;
    });
    res.status(201).json({ transaction: result });
  } catch (error) {
    console.error("POST /stock/transfer error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});
router5.post("/stock/adjustment", requirePermission("inventory", "create"), async (req, res) => {
  try {
    const { materialId, batchLotId, warehouseId, quantity, unitOfMeasure, reason } = req.body;
    if (!materialId || !quantity || !unitOfMeasure || !warehouseId) {
      return res.status(400).json({ error: "materialId, quantity, unitOfMeasure and warehouseId are required" });
    }
    if (quantity === 0) return res.status(400).json({ error: "Adjustment quantity cannot be zero" });
    const material = await prisma.material.findUnique({ where: { id: materialId } });
    if (!material) return res.status(404).json({ error: "Material not found" });
    const entry = await postLedgerEntry(prisma, {
      eventType: LedgerEventType.ADJUSTMENT,
      materialId,
      batchLotId: batchLotId ?? null,
      warehouseId,
      quantity: Number(quantity),
      unitOfMeasure,
      referenceType: "ADJUSTMENT",
      createdById: req.user.id,
      notes: reason ?? null
    });
    res.status(201).json({ adjustment: entry, requiresApproval: req.user.role === "STORE_OFFICER" });
  } catch (error) {
    console.error("POST /stock/adjustment error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});
router5.get("/finished-goods", requirePermission("inventory", "read"), async (req, res) => {
  try {
    const finishedMaterials = await prisma.material.findMany({
      where: { type: "FINISHED" },
      select: { id: true }
    });
    const ids = finishedMaterials.map((m) => m.id);
    const grouped = ids.length ? await prisma.inventoryTransaction.groupBy({
      by: ["materialId", "warehouseId", "batchLotId"],
      where: { materialId: { in: ids }, batchLotId: { not: null } },
      _sum: { quantity: true }
    }) : [];
    const materialIds = [...new Set(grouped.map((g) => g.materialId))];
    const warehouseIds = [...new Set(grouped.map((g) => g.warehouseId))];
    const batchIds = [...new Set(grouped.map((g) => g.batchLotId).filter(Boolean))];
    const [materials, warehouses, batchLots, prodOrders] = await Promise.all([
      materialIds.length ? prisma.material.findMany({ where: { id: { in: materialIds } }, select: { id: true, name: true, sku: true, unitOfMeasure: true } }) : Promise.resolve([]),
      warehouseIds.length ? prisma.warehouse.findMany({ where: { id: { in: warehouseIds } }, select: { id: true, name: true, code: true } }) : Promise.resolve([]),
      batchIds.length ? prisma.batchLot.findMany({ where: { id: { in: batchIds } }, select: { id: true, batchNumber: true, status: true, manufacturingDate: true, expiryDate: true } }) : Promise.resolve([]),
      batchIds.length ? prisma.productionOrder.findMany({ where: { finishedBatchId: { in: batchIds } }, select: { id: true, orderNumber: true, finishedBatchId: true } }) : Promise.resolve([])
    ]);
    const materialMap = new Map(materials.map((m) => [m.id, m]));
    const warehouseMap = new Map(warehouses.map((w) => [w.id, w]));
    const batchMap = new Map(batchLots.map((b) => [b.id, b]));
    const orderMap = new Map(prodOrders.map((o) => [o.finishedBatchId, o]));
    const rows = grouped.map((g) => {
      const material = materialMap.get(g.materialId);
      const warehouse = warehouseMap.get(g.warehouseId);
      const batch = batchMap.get(g.batchLotId ?? "");
      const order = orderMap.get(g.batchLotId ?? "");
      return {
        materialId: g.materialId,
        materialName: material?.name ?? "\u2014",
        sku: material?.sku ?? "",
        unitOfMeasure: material?.unitOfMeasure ?? "",
        warehouseId: g.warehouseId,
        warehouseName: warehouse?.name ?? "\u2014",
        warehouseCode: warehouse?.code ?? "",
        batchLotId: g.batchLotId,
        batchNumber: batch?.batchNumber ?? "\u2014",
        batchStatus: batch?.status ?? "\u2014",
        manufacturingDate: batch?.manufacturingDate ?? null,
        expiryDate: batch?.expiryDate ?? null,
        quantity: Number(g._sum.quantity ?? 0),
        orderNumber: order?.orderNumber ?? null
      };
    });
    res.json({ finishedGoods: rows });
  } catch (error) {
    console.error("GET /finished-goods error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
var inventory_default = router5;

// src/routes/production.ts
import { Router as Router6 } from "express";
var router6 = Router6();
router6.use(requireAuth);
router6.get("/boms", requirePermission("production", "read"), async (_req, res) => {
  try {
    const boms = await prisma.bom.findMany({
      include: {
        versions: {
          orderBy: { version: "desc" },
          include: {
            finishedSku: { select: { id: true, name: true, sku: true } },
            ingredients: {
              include: { material: { select: { id: true, name: true, sku: true, unitOfMeasure: true } } }
            }
          }
        }
      },
      orderBy: { updatedAt: "desc" }
    });
    res.json({ boms });
  } catch (error) {
    console.error("GET /production/boms error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router6.post("/boms", requirePermission("production", "create"), async (req, res) => {
  try {
    const { productName, description, version, expectedYield, yieldUnit, finishedSkuId, ingredients } = req.body;
    if (!productName || !finishedSkuId || !expectedYield || !yieldUnit) {
      return res.status(400).json({ error: "productName, finishedSkuId, expectedYield and yieldUnit are required" });
    }
    if (!Array.isArray(ingredients) || ingredients.length === 0) {
      return res.status(400).json({ error: "At least one ingredient is required" });
    }
    const bom = await prisma.$transaction(async (tx) => {
      const created = await tx.bom.create({
        data: { productName, description: description ?? null }
      });
      await tx.bomVersion.create({
        data: {
          bomId: created.id,
          version: version ?? 1,
          description: description ?? null,
          expectedYield: Number(expectedYield),
          yieldUnit,
          finishedSkuId,
          ingredients: {
            create: ingredients.map((ing) => ({
              materialId: ing.materialId,
              quantity: Number(ing.quantity),
              unitOfMeasure: ing.unitOfMeasure,
              isPercentage: ing.isPercentage ?? false
            }))
          }
        }
      });
      return created;
    });
    res.status(201).json({ bom });
  } catch (error) {
    console.error("POST /production/boms error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router6.patch("/boms/:id/versions/:version/status", requirePermission("production", "approve"), async (req, res) => {
  try {
    const { status } = req.body;
    if (!["DRAFT", "ACTIVE", "APPROVED", "ARCHIVED"].includes(status)) {
      return res.status(400).json({ error: "Invalid BOM status" });
    }
    const bomVersion = await prisma.bomVersion.update({
      where: { bomId_version: { bomId: req.params.id, version: Number(req.params.version) } },
      data: { status }
    });
    res.json({ bomVersion });
  } catch (error) {
    console.error("PATCH /production/boms/:id/versions/:version/status error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router6.get("/machines", requirePermission("production", "read"), async (_req, res) => {
  try {
    const machines = await prisma.machine.findMany({ orderBy: { name: "asc" } });
    res.json({ machines });
  } catch (error) {
    console.error("GET /production/machines error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router6.post("/machines", requirePermission("production", "create"), async (req, res) => {
  try {
    const { name, code } = req.body;
    if (!name || !code) return res.status(400).json({ error: "name and code are required" });
    const machine = await prisma.machine.create({ data: { name, code } });
    res.status(201).json({ machine });
  } catch (error) {
    console.error("POST /production/machines error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router6.get("/shifts", requirePermission("production", "read"), async (_req, res) => {
  try {
    const shifts = await prisma.shift.findMany({ orderBy: { startTime: "asc" } });
    res.json({ shifts });
  } catch (error) {
    console.error("GET /production/shifts error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router6.get("/production-orders", requirePermission("production", "read"), async (req, res) => {
  try {
    const { status } = req.query;
    const orders = await prisma.productionOrder.findMany({
      where: status ? { status } : {},
      include: {
        bomVersion: { include: { bom: true, finishedSku: { select: { name: true, sku: true } } } },
        machine: { select: { name: true, code: true } },
        shift: { select: { name: true } },
        createdBy: { select: { fullName: true } },
        finishedBatch: { select: { batchNumber: true, status: true } }
      },
      orderBy: { createdAt: "desc" }
    });
    res.json({ productionOrders: orders });
  } catch (error) {
    console.error("GET /production/production-orders error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router6.post("/production-orders", requirePermission("production", "create"), async (req, res) => {
  try {
    const { bomVersionId, targetQuantity, scheduledStart, machineId, shiftId } = req.body;
    if (!bomVersionId || !targetQuantity) {
      return res.status(400).json({ error: "bomVersionId and targetQuantity are required" });
    }
    const bomVersion = await prisma.bomVersion.findUnique({
      where: { id: bomVersionId },
      include: { ingredients: true }
    });
    if (!bomVersion) return res.status(404).json({ error: "BOM version not found" });
    if (bomVersion.status === "DRAFT") {
      return res.status(400).json({ error: "BOM must be APPROVED/ACTIVE before creating a production order" });
    }
    const orderNumber = `PRD-${Date.now().toString().slice(-8)}`;
    const productionOrder = await prisma.productionOrder.create({
      data: {
        orderNumber,
        bomVersionId,
        targetQuantity: Number(targetQuantity),
        status: "SCHEDULED",
        scheduledStart: scheduledStart ? new Date(scheduledStart) : null,
        machineId: machineId ?? null,
        shiftId: shiftId ?? null,
        createdById: req.user.id
      },
      include: { bomVersion: true }
    });
    res.status(201).json({ productionOrder });
  } catch (error) {
    console.error("POST /production/production-orders error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router6.post("/production-orders/:id/start", requirePermission("production", "update"), async (req, res) => {
  try {
    const order = await prisma.productionOrder.findUnique({
      where: { id: req.params.id },
      include: { bomVersion: { include: { ingredients: true } } }
    });
    if (!order) return res.status(404).json({ error: "Production order not found" });
    if (order.status !== "SCHEDULED") return res.status(400).json({ error: "Order must be SCHEDULED to start" });
    const { warehouseId } = req.body;
    if (!warehouseId) return res.status(400).json({ error: "warehouseId is required (issue raw materials from this warehouse)" });
    await prisma.$transaction(async (tx) => {
      for (const ing of order.bomVersion.ingredients) {
        const scale = Number(order.targetQuantity) / Number(order.bomVersion.expectedYield);
        const qty = ing.isPercentage ? Number(ing.quantity) / 100 * scale * Number(order.bomVersion.expectedYield) : Number(ing.quantity) * scale;
        await postLedgerEntry(tx, {
          eventType: LedgerEventType.PROD_CONSUMPTION,
          materialId: ing.materialId,
          warehouseId,
          quantity: -qty,
          unitOfMeasure: ing.unitOfMeasure,
          referenceType: "PROD_ORDER",
          referenceId: order.id,
          createdById: req.user.id,
          notes: `Auto-consumption for ${order.orderNumber}`
        });
      }
      await tx.productionOrder.update({
        where: { id: order.id },
        data: { status: "PROCESSING" }
      });
    });
    res.json({ ok: true, message: `Consumed raw materials for ${order.orderNumber}` });
  } catch (error) {
    console.error("POST /production-orders/:id/start error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});
router6.post("/production-orders/:id/complete", requirePermission("production", "update"), async (req, res) => {
  try {
    const { batchNumber, warehouseId, actualYield } = req.body;
    if (!batchNumber || !warehouseId) {
      return res.status(400).json({ error: "batchNumber and warehouseId are required" });
    }
    const order = await prisma.productionOrder.findUnique({
      where: { id: req.params.id },
      include: { bomVersion: true }
    });
    if (!order) return res.status(404).json({ error: "Production order not found" });
    if (order.status !== "PROCESSING") return res.status(400).json({ error: "Order must be PROCESSING to complete" });
    const finishedSkuId = order.bomVersion.finishedSkuId;
    const yieldQty = actualYield ?? order.targetQuantity;
    const result = await prisma.$transaction(async (tx) => {
      const batchLot = await tx.batchLot.create({
        data: {
          materialId: finishedSkuId,
          batchNumber,
          status: "QUARANTINE"
          // QA must release before it's usable
        }
      });
      await postLedgerEntry(tx, {
        eventType: LedgerEventType.PROD_OUTPUT,
        materialId: finishedSkuId,
        batchLotId: batchLot.id,
        warehouseId,
        quantity: Number(yieldQty),
        unitOfMeasure: order.bomVersion.yieldUnit,
        referenceType: "PROD_ORDER",
        referenceId: order.id,
        createdById: req.user.id,
        notes: `Output for ${order.orderNumber} (batch ${batchNumber})`
      });
      await tx.inspectionRecord.create({
        data: {
          inspectionType: "FINISHED_BATCH",
          materialId: finishedSkuId,
          batchLotId: batchLot.id,
          referenceId: order.id,
          result: "PENDING"
        }
      });
      await tx.productionOrder.update({
        where: { id: order.id },
        data: { status: "COMPLETED", actualEnd: /* @__PURE__ */ new Date(), actualYield: Number(yieldQty), finishedBatchId: batchLot.id }
      });
      return batchLot;
    });
    res.json({ ok: true, batchLot: result, message: `Batch ${batchNumber} produced and sent to QA (QUARANTINE)` });
  } catch (error) {
    console.error("POST /production-orders/:id/complete error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});
async function getBatchInbound(batchLotId) {
  const grnItem = await prisma.goodsReceiptItem.findFirst({
    where: { batchLotId },
    include: {
      grn: {
        include: {
          po: { include: { supplier: { select: { id: true, name: true, contactPerson: true } } } }
        }
      }
    }
  });
  if (!grnItem) return null;
  return {
    grnNumber: grnItem.grn.number,
    receivedAt: grnItem.grn.receivedAt,
    quantity: Number(grnItem.quantity),
    unitOfMeasure: grnItem.unitOfMeasure,
    poNumber: grnItem.grn.po.number,
    orderDate: grnItem.grn.po.orderDate,
    supplier: grnItem.grn.po.supplier
  };
}
async function buildTraceTree(batchId) {
  const batch = await prisma.batchLot.findUnique({
    where: { id: batchId },
    include: {
      material: { select: { id: true, name: true, sku: true, type: true, unitOfMeasure: true } }
    }
  });
  if (!batch) return null;
  const inbound = await getBatchInbound(batch.id);
  const prodOrder = await prisma.productionOrder.findFirst({
    where: { finishedBatchId: batch.id },
    include: {
      bomVersion: {
        include: {
          bom: { select: { id: true, productName: true } },
          ingredients: {
            include: { material: { select: { id: true, name: true, sku: true, type: true } } }
          }
        }
      }
    }
  });
  let producedBy = null;
  let ingredients = [];
  if (prodOrder) {
    producedBy = {
      orderNumber: prodOrder.orderNumber,
      targetQuantity: Number(prodOrder.targetQuantity),
      actualYield: prodOrder.actualYield ? Number(prodOrder.actualYield) : null,
      completedAt: prodOrder.actualEnd,
      bomId: prodOrder.bomVersion.bom.id,
      bomProductName: prodOrder.bomVersion.bom.productName,
      bomVersion: prodOrder.bomVersion.version
    };
    const consumption = await prisma.inventoryTransaction.findMany({
      where: {
        referenceType: "PROD_ORDER",
        referenceId: prodOrder.id,
        eventType: LedgerEventType.PROD_CONSUMPTION,
        batchLotId: { not: null }
      },
      select: { materialId: true, batchLotId: true }
    });
    ingredients = await Promise.all(
      prodOrder.bomVersion.ingredients.map(async (ing) => {
        const rawBatchIds = consumption.filter((t) => t.materialId === ing.materialId).map((t) => t.batchLotId);
        const distinct = [...new Set(rawBatchIds)];
        const rawBatches = distinct.length ? await prisma.batchLot.findMany({
          where: { id: { in: distinct } },
          select: { id: true, batchNumber: true, status: true, expiryDate: true, manufacturingDate: true }
        }) : [];
        const rawBatchesWithInbound = await Promise.all(
          rawBatches.map(async (rb) => ({ batch: rb, inbound: await getBatchInbound(rb.id) }))
        );
        return {
          materialId: ing.materialId,
          materialName: ing.material.name,
          sku: ing.material.sku,
          type: ing.material.type,
          quantity: Number(ing.quantity),
          unitOfMeasure: ing.unitOfMeasure,
          isPercentage: ing.isPercentage,
          rawBatches: rawBatchesWithInbound
        };
      })
    );
  }
  return {
    batch: {
      id: batch.id,
      batchNumber: batch.batchNumber,
      status: batch.status,
      manufacturingDate: batch.manufacturingDate,
      expiryDate: batch.expiryDate,
      material: batch.material
    },
    inbound,
    producedBy,
    ingredients
  };
}
router6.get("/trace/:batchId", requirePermission("production", "read"), async (req, res) => {
  try {
    const tree = await buildTraceTree(req.params.batchId);
    if (!tree) return res.status(404).json({ error: "Batch not found" });
    res.json({ tree });
  } catch (error) {
    console.error("GET /production/trace/:batchId error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router6.get("/trace", requirePermission("production", "read"), async (req, res) => {
  try {
    const { batchNumber } = req.query;
    if (!batchNumber) return res.status(400).json({ error: "batchNumber query is required" });
    const batch = await prisma.batchLot.findFirst({ where: { batchNumber: String(batchNumber) } });
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    const tree = await buildTraceTree(batch.id);
    res.json({ tree });
  } catch (error) {
    console.error("GET /production/trace error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router6.post("/waste", requirePermission("production", "update"), async (req, res) => {
  try {
    const { materialId, warehouseId, quantity, unitOfMeasure, batchLotId, notes } = req.body;
    if (!materialId || !warehouseId || !quantity || !unitOfMeasure) {
      return res.status(400).json({ error: "materialId, warehouseId, quantity and unitOfMeasure are required" });
    }
    const qty = Number(quantity);
    if (!qty || qty <= 0) return res.status(400).json({ error: "quantity must be a positive number" });
    await postLedgerEntry(prisma, {
      eventType: LedgerEventType.WASTE,
      materialId,
      warehouseId,
      batchLotId: batchLotId ?? null,
      quantity: -qty,
      unitOfMeasure,
      referenceType: "PRODUCTION_WASTE",
      createdById: req.user.id,
      notes: notes ?? "Production waste"
    });
    res.json({ ok: true, message: `Waste of ${qty} ${unitOfMeasure} recorded` });
  } catch (error) {
    console.error("POST /production/waste error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});
var production_default = router6;

// src/routes/qa.ts
import { Router as Router7 } from "express";
var router7 = Router7();
router7.use(requireAuth);
router7.get("/inspections", requirePermission("qa", "read"), async (req, res) => {
  try {
    const { result, type } = req.query;
    const where = {};
    if (result) where.result = result;
    if (type) where.inspectionType = type;
    const inspections = await prisma.inspectionRecord.findMany({
      where,
      include: {
        material: { select: { id: true, name: true, sku: true, unitOfMeasure: true } },
        batchLot: { select: { id: true, batchNumber: true, status: true, expiryDate: true } },
        inspector: { select: { fullName: true } }
      },
      orderBy: { createdAt: "desc" }
    });
    const grnIds = inspections.filter((i) => i.inspectionType === "GRN").map((i) => i.referenceId).filter(Boolean);
    const prodIds = inspections.filter((i) => i.inspectionType === "FINISHED_BATCH").map((i) => i.referenceId).filter(Boolean);
    const [grns, prodOrders] = await Promise.all([
      grnIds.length ? prisma.goodsReceipt.findMany({ where: { id: { in: grnIds } }, select: { id: true, number: true } }) : Promise.resolve([]),
      prodIds.length ? prisma.productionOrder.findMany({ where: { id: { in: prodIds } }, select: { id: true, orderNumber: true } }) : Promise.resolve([])
    ]);
    const grnMap = new Map(grns.map((g) => [g.id, g.number]));
    const prodMap = new Map(prodOrders.map((p) => [p.id, p.orderNumber]));
    const rows = inspections.map((i) => ({
      ...i,
      referenceLabel: i.inspectionType === "GRN" ? grnMap.get(i.referenceId ?? "") ?? i.referenceId : prodMap.get(i.referenceId ?? "") ?? i.referenceId
    }));
    res.json({ inspections: rows });
  } catch (error) {
    console.error("GET /qa/inspections error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router7.post("/inspections/:id/release", requirePermission("qa", "approve"), async (req, res) => {
  try {
    const { notes } = req.body;
    const inspection = await prisma.inspectionRecord.findUnique({
      where: { id: req.params.id },
      include: { batchLot: true }
    });
    if (!inspection) return res.status(404).json({ error: "Inspection record not found" });
    if (inspection.result !== "PENDING") {
      return res.status(400).json({ error: "Only PENDING inspections can be released" });
    }
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.inspectionRecord.update({
        where: { id: inspection.id },
        data: { result: "PASSED", notes: notes ?? inspection.notes, inspectedById: req.user.id, inspectedAt: /* @__PURE__ */ new Date() }
      });
      if (inspection.batchLot) {
        await tx.batchLot.update({
          where: { id: inspection.batchLot.id },
          data: { status: "ACTIVE" }
        });
      }
      return updated;
    });
    res.json({ ok: true, inspection: result, message: `Batch ${inspection.batchLot?.batchNumber ?? ""} released to stock` });
  } catch (error) {
    console.error("POST /qa/inspections/:id/release error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});
router7.post("/inspections/:id/reject", requirePermission("qa", "approve"), async (req, res) => {
  try {
    const { notes } = req.body;
    const inspection = await prisma.inspectionRecord.findUnique({
      where: { id: req.params.id },
      include: { batchLot: true }
    });
    if (!inspection) return res.status(404).json({ error: "Inspection record not found" });
    if (inspection.result !== "PENDING") {
      return res.status(400).json({ error: "Only PENDING inspections can be rejected" });
    }
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.inspectionRecord.update({
        where: { id: inspection.id },
        data: { result: "FAILED", notes: notes ?? inspection.notes, inspectedById: req.user.id, inspectedAt: /* @__PURE__ */ new Date() }
      });
      if (inspection.batchLot) {
        await tx.batchLot.update({
          where: { id: inspection.batchLot.id },
          data: { status: "REJECTED" }
        });
        const incoming = await tx.inventoryTransaction.findMany({
          where: { batchLotId: inspection.batchLot.id, quantity: { gt: 0 } },
          select: { quantity: true, unitOfMeasure: true, warehouseId: true }
        });
        const totalIn = incoming.reduce((sum, t) => sum + Number(t.quantity), 0);
        if (totalIn > 0) {
          await postLedgerEntry(tx, {
            eventType: LedgerEventType.WASTE,
            materialId: inspection.materialId,
            batchLotId: inspection.batchLot.id,
            warehouseId: incoming[0].warehouseId,
            quantity: -totalIn,
            unitOfMeasure: incoming[0].unitOfMeasure,
            referenceType: "QA_REJECT",
            referenceId: inspection.id,
            createdById: req.user.id,
            notes: `Rejected batch ${inspection.batchLot.batchNumber} (${notes ?? "failed inspection"})`
          });
        }
      }
      return updated;
    });
    res.json({ ok: true, inspection: result, message: `Batch ${inspection.batchLot?.batchNumber ?? ""} rejected and quarantined stock reversed` });
  } catch (error) {
    console.error("POST /qa/inspections/:id/reject error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});
var qa_default = router7;

// src/routes/notifications.ts
import { Router as Router8 } from "express";
var router8 = Router8();
router8.use(requireAuth);
router8.post("/generate", async (req, res) => {
  try {
    const alerts = [];
    const thirtyDays = /* @__PURE__ */ new Date();
    thirtyDays.setDate(thirtyDays.getDate() + 30);
    const expiring = await prisma.batchLot.findMany({
      where: { status: "ACTIVE", expiryDate: { lte: thirtyDays } },
      include: { material: { select: { name: true, sku: true } } },
      orderBy: { expiryDate: "asc" }
    });
    for (const b of expiring.slice(0, 20)) {
      const days = b.expiryDate ? Math.ceil((b.expiryDate.getTime() - Date.now()) / 864e5) : 0;
      alerts.push({
        type: "EXPIRY",
        title: `Batch ${b.batchNumber} expiring${days < 0 ? " (expired)" : ` in ${days} days`}`,
        body: `${b.material.name} (${b.material.sku}) \u2014 expiry ${b.expiryDate?.toISOString().slice(0, 10)}`
      });
    }
    const stock = await getStock(prisma);
    const depleted = stock.filter((s) => Number(s.quantity) <= 0);
    for (const s of depleted.slice(0, 20)) {
      alerts.push({
        type: "LOW_STOCK",
        title: `${s.materialName} is out of stock`,
        body: `${s.sku} \xB7 ${s.warehouseName} \xB7 on hand ${Number(s.quantity)} ${s.unitOfMeasure}`
      });
    }
    const [pendingReqs, pendingInspections] = await Promise.all([
      prisma.requisition.count({ where: { status: "PENDING_APPROVAL" } }),
      prisma.inspectionRecord.count({ where: { result: "PENDING" } })
    ]);
    if (pendingReqs > 0) {
      alerts.push({
        type: "APPROVAL",
        title: `${pendingReqs} requisition(s) awaiting approval`,
        body: "Review and approve pending purchase requisitions in the Procurement module."
      });
    }
    if (pendingInspections > 0) {
      alerts.push({
        type: "APPROVAL",
        title: `${pendingInspections} batch(es) awaiting QA inspection`,
        body: "Release or reject quarantined batches in the QA Inspections module."
      });
    }
    const users = await prisma.user.findMany({ select: { id: true, role: true } });
    let created = 0;
    for (const user of users) {
      for (const alert of alerts) {
        const exists = await prisma.notification.findFirst({
          where: { userId: user.id, type: alert.type, title: alert.title, isRead: false }
        });
        if (exists) continue;
        await prisma.notification.create({
          data: { userId: user.id, type: alert.type, title: alert.title, body: alert.body }
        });
        created++;
      }
    }
    res.json({ ok: true, created, alertsScanned: alerts.length });
  } catch (error) {
    console.error("POST /notifications/generate error:", error);
    res.status(500).json({ error: error?.message || "Database error" });
  }
});
router8.get("/", async (req, res) => {
  try {
    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: "desc" },
        take: 100
      }),
      prisma.notification.count({ where: { userId: req.user.id, isRead: false } })
    ]);
    res.json({ notifications, unreadCount });
  } catch (error) {
    console.error("GET /notifications error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router8.post("/:id/read", async (req, res) => {
  try {
    const notification = await prisma.notification.updateMany({
      where: { id: req.params.id, userId: req.user.id },
      data: { isRead: true }
    });
    res.json({ ok: true, updated: notification.count });
  } catch (error) {
    console.error("POST /notifications/:id/read error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router8.post("/read-all", async (req, res) => {
  try {
    const result = await prisma.notification.updateMany({
      where: { userId: req.user.id, isRead: false },
      data: { isRead: true }
    });
    res.json({ ok: true, updated: result.count });
  } catch (error) {
    console.error("POST /notifications/read-all error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
var notifications_default = router8;

// src/routes/reports.ts
import { Router as Router9 } from "express";
var router9 = Router9();
router9.use(requireAuth);
router9.get("/production-efficiency", requirePermission("reports", "read"), async (req, res) => {
  try {
    const orders = await prisma.productionOrder.findMany({
      include: {
        bomVersion: {
          include: {
            bom: { select: { productName: true } },
            finishedSku: { select: { name: true, sku: true } }
          }
        }
      },
      orderBy: { createdAt: "desc" }
    });
    const rows = orders.map((o) => {
      const target = Number(o.targetQuantity);
      const actual = o.actualYield ? Number(o.actualYield) : null;
      const yieldPct = actual !== null && target > 0 ? Math.round(actual / target * 1e3) / 10 : null;
      return {
        orderNumber: o.orderNumber,
        productName: o.bomVersion.finishedSku?.name ?? o.bomVersion.bom.productName,
        sku: o.bomVersion.finishedSku?.sku ?? "",
        bomVersion: o.bomVersion.version,
        status: o.status,
        targetQuantity: target,
        actualYield: actual,
        yieldPct,
        completedAt: o.actualEnd ?? null
      };
    });
    const completed = rows.filter((r) => r.yieldPct !== null);
    const summary = {
      totalOrders: rows.length,
      completedOrders: completed.length,
      avgYieldPct: completed.length ? Math.round(completed.reduce((sum, r) => sum + (r.yieldPct ?? 0), 0) / completed.length * 10) / 10 : null,
      inProgress: rows.filter((r) => r.status === "PROCESSING").length,
      scheduled: rows.filter((r) => r.status === "SCHEDULED").length
    };
    res.json({ rows, summary });
  } catch (error) {
    console.error("GET /reports/production-efficiency error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
router9.get("/inventory-valuation", requirePermission("reports", "read"), async (req, res) => {
  try {
    const stock = await getStock(prisma);
    const materialIds = [...new Set(stock.map((s) => s.materialId))];
    const poItems = materialIds.length ? await prisma.purchaseOrderItem.findMany({
      where: { materialId: { in: materialIds } },
      include: { po: { select: { orderDate: true } } }
    }) : [];
    const costMap = /* @__PURE__ */ new Map();
    for (const item of poItems) {
      const existing = costMap.get(item.materialId);
      const itemDate = item.po.orderDate ?? null;
      if (!existing || itemDate && (!existing.date || itemDate > existing.date)) {
        costMap.set(item.materialId, { cost: Number(item.unitCost), date: itemDate });
      }
    }
    const byMaterial = /* @__PURE__ */ new Map();
    for (const s of stock) {
      const existing = byMaterial.get(s.materialId) ?? {
        materialId: s.materialId,
        materialName: s.materialName,
        sku: s.sku,
        unitOfMeasure: s.unitOfMeasure,
        quantity: 0
      };
      existing.quantity += Number(s.quantity);
      byMaterial.set(s.materialId, existing);
    }
    const rows = [...byMaterial.values()].map((m) => {
      const cost = costMap.get(m.materialId)?.cost ?? 0;
      return {
        materialId: m.materialId,
        materialName: m.materialName,
        sku: m.sku,
        unitOfMeasure: m.unitOfMeasure,
        quantity: Math.round(m.quantity * 1e4) / 1e4,
        unitCost: cost,
        value: Math.round(m.quantity * cost * 100) / 100
      };
    });
    const totalValue = Math.round(rows.reduce((sum, r) => sum + r.value, 0) * 100) / 100;
    res.json({ rows, summary: { totalValue, materials: rows.length } });
  } catch (error) {
    console.error("GET /reports/inventory-valuation error:", error);
    res.status(500).json({ error: "Database error" });
  }
});
var reports_default = router9;

// src/routes/index.ts
var router10 = Router10();
router10.use("/auth", auth_default);
router10.use("/master-data", master_data_default);
router10.use("/procurement", procurement_default);
router10.use("/grn", grn_default);
router10.use("/inventory", inventory_default);
router10.use("/production", production_default);
router10.use("/qa", qa_default);
router10.use("/notifications", notifications_default);
router10.use("/reports", reports_default);
var routes_default = router10;

// src/app.ts
var app = express();
app.use(cors());
app.use(express.json());
app.get("/health", async (_req, res) => {
  let dbStatus = "down";
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbStatus = "up";
  } catch {
    dbStatus = "down";
  }
  res.json({ status: "ok", db: dbStatus, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
});
app.use("/api", routes_default);

// api/index.ts
var index_default = app;
export {
  index_default as default
};
