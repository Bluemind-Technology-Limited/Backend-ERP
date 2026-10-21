import "dotenv/config";
import { PutBucketCorsCommand } from "@aws-sdk/client-s3";
import { getR2Bucket, getR2Client, isR2Configured } from "../lib/r2.js";

/**
 * Configure the R2 bucket CORS policy so browsers can PUT presigned uploads
 * directly. Run once per bucket (and again if the frontend origins change):
 *
 *   pnpm r2:cors
 *
 * Set R2_ALLOWED_ORIGINS to a comma-separated list to restrict origins, e.g.
 *   R2_ALLOWED_ORIGINS="http://localhost:5173,https://your-erp.vercel.app"
 */
async function main() {
  if (!isR2Configured()) {
    throw new Error("R2 is not configured — check the R2_* variables in .env");
  }

  const origins = (process.env.R2_ALLOWED_ORIGINS || "*")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  const client = getR2Client();
  const bucket = getR2Bucket();

  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: origins,
            AllowedMethods: ["PUT", "GET", "HEAD"],
            AllowedHeaders: ["*"],
            ExposeHeaders: ["ETag"],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    })
  );

  console.log(`✓ R2 CORS configured on bucket "${bucket}" for: ${origins.join(", ")}`);
}

main().catch((error) => {
  console.error("R2 CORS setup failed:", error);
  process.exit(1);
});
