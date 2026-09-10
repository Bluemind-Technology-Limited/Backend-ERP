-- CreateTable "machine_categories"
CREATE TABLE "machine_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "machine_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable "machine_departments"
CREATE TABLE "machine_departments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "machine_departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable "machine_locations"
CREATE TABLE "machine_locations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "machine_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable "machines"
CREATE TABLE "machines" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "serial_number" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "location_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "machines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "machine_categories_name_key" ON "machine_categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "machine_categories_code_key" ON "machine_categories"("code");

-- CreateIndex
CREATE UNIQUE INDEX "machine_departments_name_key" ON "machine_departments"("name");

-- CreateIndex
CREATE UNIQUE INDEX "machine_departments_code_key" ON "machine_departments"("code");

-- CreateIndex
CREATE UNIQUE INDEX "machine_locations_name_key" ON "machine_locations"("name");

-- CreateIndex
CREATE UNIQUE INDEX "machine_locations_code_key" ON "machine_locations"("code");

-- CreateIndex
CREATE UNIQUE INDEX "machines_code_key" ON "machines"("code");

-- CreateIndex
CREATE UNIQUE INDEX "machines_serial_number_key" ON "machines"("serial_number");

-- CreateIndex
CREATE INDEX "machines_status_idx" ON "machines"("status");

-- CreateIndex
CREATE INDEX "machines_category_id_idx" ON "machines"("category_id");

-- CreateIndex
CREATE INDEX "machines_department_id_idx" ON "machines"("department_id");

-- CreateIndex
CREATE INDEX "machines_location_id_idx" ON "machines"("location_id");

-- AddForeignKey
ALTER TABLE "machines" ADD CONSTRAINT "machines_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "machine_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machines" ADD CONSTRAINT "machines_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "machine_departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machines" ADD CONSTRAINT "machines_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "machine_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
