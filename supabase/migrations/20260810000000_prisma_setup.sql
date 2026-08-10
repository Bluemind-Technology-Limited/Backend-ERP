-- ============================================================================
-- KIB ERP — Supabase: Prisma DB user & schema permissions
-- Run once in the Supabase SQL Editor BEFORE the first `prisma migrate dev`.
-- Docs: ../../architecture/KIB-ERP-prisma-supabase-setup.md
-- ============================================================================

-- 1. Create a dedicated Prisma DB role with full privileges on the public schema.
--    (We use Prisma as the sole data access layer, so RLS is bypassed for this
--     role — the API server enforces RBAC instead. PostgREST / Data API is
--     turned off in Supabase API Settings.)
create user "prisma" with password 'custom_password' bypassrls createdb;

-- Extend prisma's privileges to postgres (necessary to view changes in Dashboard)
grant "prisma" to "postgres";

-- Grant it necessary permissions over the relevant schemas (public)
grant usage on schema public to prisma;
grant create on schema public to prisma;
grant all on all tables in schema public to prisma;
grant all on all routines in schema public to prisma;
grant all on all sequences in schema public to prisma;
alter default privileges for role postgres in schema public grant all on tables to prisma;
alter default privileges for role postgres in schema public grant all on routines to prisma;
alter default privileges for role postgres in schema public grant all on sequences to prisma;

-- 2. Turn off Row Level Security on every table for the prisma role.
--    Prisma owns the public schema; application-level RBAC (RolePermission)
--    enforces authorization in the API layer.
alter table public.users disable row level security;
alter table public.role_permissions disable row level security;
alter table public.materials disable row level security;
alter table public.warehouses disable row level security;
alter table public.zones disable row level security;
alter table public.warehouse_bins disable row level security;
alter table public.suppliers disable row level security;
alter table public.batch_lots disable row level security;
alter table public.inventory_transactions disable row level security;
alter table public.requisitions disable row level security;
alter table public.requisition_items disable row level security;
alter table public.purchase_orders disable row level security;
alter table public.purchase_order_items disable row level security;
alter table public.goods_receipts disable row level security;
alter table public.goods_receipt_items disable row level security;
alter table public.boms disable row level security;
alter table public.bom_versions disable row level security;
alter table public.bom_ingredients disable row level security;
alter table public.machines disable row level security;
alter table public.shifts disable row level security;
alter table public.production_orders disable row level security;
alter table public.inspection_records disable row level security;
alter table public.notifications disable row level security;

-- 3. (Optional) Alter prisma password if needed:
-- alter user "prisma" with password 'new_password';
