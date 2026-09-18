import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Migrations/introspection need the direct (session) connection. The
    // transaction pooler (pgbouncer, :6543) cannot run DDL, which is why
    // `DATABASE_URL` (the pooler) fails here. App runtime is unaffected —
    // it connects through its own `pg` adapter using DATABASE_URL.
    url: env("DIRECT_URL"),
  },
});
