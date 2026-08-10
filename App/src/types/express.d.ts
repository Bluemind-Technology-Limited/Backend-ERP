import type { User } from "../generated/prisma/client";

declare global {
  namespace Express {
    interface Request {
      /** Attached by requireAuth after JWT verification + Prisma user load. */
      user?: User;
      /** Raw Supabase JWT claims (sub, email, role, app_metadata...). */
      tokenClaims?: Record<string, unknown>;
    }
  }
}

export {};
