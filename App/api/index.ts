import { app } from "../src/app.js";

// Vercel serverless handler — exports the Express app directly.
// @vercel/node mounts the default export and routes all requests to it.
export default app;
