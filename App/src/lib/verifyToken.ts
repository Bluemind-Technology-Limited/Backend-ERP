import crypto from "crypto";
import jwt from "jsonwebtoken";

/**
 * Offline JWT verification for Supabase-issued tokens.
 *
 * Newer Supabase projects sign access tokens with ES256 (asymmetric) and expose
 * the public key via `/auth/v1/.well-known/jwks.json`. Legacy projects sign
 * with HS256 using the project JWT secret. We support both:
 *
 *  - ES256 -> verify against the cached JWKS public key (PEM built from JWK)
 *  - HS256 -> verify with SUPABASE_JWT_SECRET
 *
 * The JWKS result is cached for 5 minutes to avoid a network round-trip on
 * every request.
 */

const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedKeys: Record<string, string> | null = null;
let cacheFetchedAt = 0;

async function getPemKeys(): Promise<Record<string, string>> {
  if (cachedKeys && Date.now() - cacheFetchedAt < JWKS_CACHE_TTL_MS) {
    return cachedKeys;
  }
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) throw new Error("SUPABASE_URL is not configured");

  const res = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { keys: Array<{ kid: string; kty: string }> };

  const map: Record<string, string> = {};
  for (const key of data.keys) {
    const pub = crypto.createPublicKey({ key: key as unknown as crypto.JsonWebKey, format: "jwk" });
    map[key.kid] = pub.export({ type: "spki", format: "pem" }) as string;
  }
  cachedKeys = map;
  cacheFetchedAt = Date.now();
  return map;
}

export async function verifySupabaseToken(token: string): Promise<jwt.JwtPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");

  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as {
    alg?: string;
    kid?: string;
  };
  const alg = header.alg ?? "HS256";

  if (alg === "ES256") {
    const keys = await getPemKeys();
    const kid = header.kid;
    const pem = (kid && keys[kid]) || Object.values(keys)[0];
    if (!pem) throw new Error("No matching JWKS key for token");
    return jwt.verify(token, pem, { algorithms: ["ES256"] }) as jwt.JwtPayload;
  }

  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new Error("SUPABASE_JWT_SECRET is not configured");
  return jwt.verify(token, secret, { algorithms: ["HS256"] }) as jwt.JwtPayload;
}
