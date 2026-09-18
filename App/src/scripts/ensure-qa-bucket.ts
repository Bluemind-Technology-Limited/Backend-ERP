import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

/**
 * One-time setup: create the private Supabase Storage bucket used for
 * proof-of-check attachments (idempotent — safe to run repeatedly).
 *
 *   pnpm storage:setup
 */
const BUCKET = process.env.QA_ATTACHMENTS_BUCKET?.trim() || "qa-attachments";

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) throw listError;

  if (buckets?.some((bucket) => bucket.name === BUCKET)) {
    console.log(`Bucket "${BUCKET}" already exists — nothing to do.`);
    return;
  }

  const { error } = await supabase.storage.createBucket(BUCKET, { public: false });
  if (error) throw error;

  console.log(`Created private bucket "${BUCKET}".`);
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
