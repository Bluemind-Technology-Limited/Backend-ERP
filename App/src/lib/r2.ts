import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * Cloudflare R2 (S3-compatible) used by the QA review document feature.
 *
 * The browser uploads directly to R2 with its own S3 client (see
 * `kib-ERP/src/lib/r2Client.ts`). The API only needs R2 access to:
 *   - validate that a submitted URL belongs to this bucket + inspection, and
 *   - delete an object when a document is replaced or removed.
 *
 * Objects are public through `R2_PUBLIC_BASE_URL` (r2.dev or a custom domain).
 */

let client: S3Client | null = null;

/** True when every credential needed to sign R2 requests is present. */
export function isR2Configured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID?.trim() &&
      process.env.R2_ACCESS_KEY_ID?.trim() &&
      process.env.R2_SECRET_ACCESS_KEY?.trim() &&
      process.env.R2_BUCKET_NAME?.trim() &&
      process.env.R2_PUBLIC_BASE_URL?.trim()
  );
}

export function getR2Bucket(): string {
  return process.env.R2_BUCKET_NAME?.trim() || "kib-qa";
}

function getR2ClientImpl(): S3Client {
  if (client) return client;
  if (!isR2Configured()) {
    throw new Error(
      "R2 storage is not configured (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME / R2_PUBLIC_BASE_URL missing)"
    );
  }

  const accountId = process.env.R2_ACCOUNT_ID!.trim();
  client = new S3Client({
    region: "auto",
    endpoint:
      process.env.R2_S3_ENDPOINT?.trim() ||
      `https://${accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!.trim(),
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!.trim(),
    },
  });
  return client;
}

/** Shared S3-compatible client (also used by the CORS setup script). */
export function getR2Client(): S3Client {
  return getR2ClientImpl();
}

/** Public URL for an object key (trailing slashes on the base are normalised). */
export function buildR2PublicUrl(key: string): string {
  const base = (process.env.R2_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  return `${base}/${key}`;
}

/** Reduce a user-supplied filename to a safe single path segment. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() || "file";
  const cleaned = base.replace(/[^a-zA-Z0-9.-]/g, "_");
  return cleaned.slice(-120) || "file";
}

/** Upload an object through the API (fallback when browser CORS blocks direct PUT). */
export async function uploadR2Object(
  key: string,
  body: Uint8Array,
  contentType: string
): Promise<string> {
  await getR2Client().send(
    new PutObjectCommand({
      Bucket: getR2Bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
  return buildR2PublicUrl(key);
}

/** Remove an object; S3 delete is idempotent, so missing keys are fine. */
export async function deleteR2Object(key: string): Promise<void> {
  await getR2Client().send(
    new DeleteObjectCommand({ Bucket: getR2Bucket(), Key: key })
  );
}
