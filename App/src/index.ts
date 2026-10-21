import "dotenv/config";
import { app } from "./app.js";
import { prisma } from "./lib/db.js";

const PORT = Number(process.env.PORT) || 3002;

// Warm the pool at boot so the first request doesn't pay for DNS/connection setup.
prisma
  .$queryRawUnsafe("SELECT 1")
  .then(() => console.log("Database connection OK"))
  .catch((error: any) => {
    console.error(
      "Database connection warning:",
      error?.cause?.code ?? error?.code ?? error?.message
    );
  });

// Only listen if we are running locally (just like Vibe Audit!)
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`API server running on http://localhost:${PORT}`);
  });
}

// Export for Vercel (just like Vibe Audit!)
export default app;