-- Work-in-progress carryover: how much of a previous batch's unused ground
-- output a finishing record drew on. Purely additive.
ALTER TABLE "production_stage_records"
  ADD COLUMN "carryover_used_quantity" DECIMAL(15,4) NOT NULL DEFAULT 0;
