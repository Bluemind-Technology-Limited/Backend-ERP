import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Proof-of-check attachment storage (Supabase Storage, private bucket).
 *
 * The backend only mints short-lived signed URLs; binary content never passes
 * through the Express server. Files are stored under
 * `consignments/<consignmentId>/checks/<checkItemId>/<timestamp>-<rand>-<name>`
 * so a consignment's evidence can be located and purged as a tree.
 */

const READ_URL_TTL_SECONDS = 60 * 10; // 10 minutes

let client: SupabaseClient | null = null;

export function getQaBucket(): string {
  return process.env.QA_ATTACHMENTS_BUCKET?.trim() || "qa-attachments";
}

/** True when the service-role credentials needed for Storage are present. */
export function isQaStorageConfigured(): boolean {
  return Boolean(
    process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  );
}

function getClient(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error(
      "Attachment storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)"
    );
  }
  client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return client;
}

/** Reduce a user-supplied filename to a safe single path segment. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() || "file";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.slice(-120) || "file";
}

export function buildQaAttachmentPath(
  consignmentId: string,
  checkItemId: string,
  fileName: string
): string {
  const stamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 10);
  return `consignments/${consignmentId}/checks/${checkItemId}/${stamp}-${rand}-${sanitizeFileName(fileName)}`;
}

/** Mint a one-time URL the client can PUT the file body to. */
export async function createQaUploadUrl(path: string) {
  const { data, error } = await getClient()
    .storage.from(getQaBucket())
    .createSignedUploadUrl(path);

  if (error || !data) {
    throw new Error(error?.message || "Failed to create an upload URL");
  }

  return {
    signedUrl: data.signedUrl,
    token: data.token,
    path: data.path,
    bucket: getQaBucket(),
  };
}

/** Mint a short-lived read URL for a stored object (null if signing fails). */
export async function createQaReadUrl(path: string): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await getClient()
    .storage.from(getQaBucket())
    .createSignedUrl(path, READ_URL_TTL_SECONDS);

  if (error || !data) return null;
  return data.signedUrl;
}

/** Remove an object; swallows "not found" so cleanup stays idempotent. */
export async function removeQaObject(path: string): Promise<void> {
  if (!path) return;
  const { error } = await getClient().storage.from(getQaBucket()).remove([path]);
  if (error && !/not.?found/i.test(error.message)) {
    throw new Error(error.message);
  }
}
