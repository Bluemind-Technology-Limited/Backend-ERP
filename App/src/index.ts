import "dotenv/config";
import { app } from "./app.js";

const PORT = Number(process.env.PORT) || 3002;

// Only listen if we are running locally (just like Vibe Audit!)
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`API server running on http://localhost:${PORT}`);
  });
}

// Export for Vercel (just like Vibe Audit!)
export default app;