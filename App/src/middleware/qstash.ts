import type { Request, Response, NextFunction } from "express";
import { qstashReceiver } from "../lib/qstash.js";

/**
  * Express middleware to verify that incoming requests are authentically sent by QStash.
  */
export async function requireQStashSignature(req: Request, res: Response, next: NextFunction) {
  const signature = req.headers["upstash-signature"];
  if (!signature) {
    return res.status(401).json({ error: "Unauthorized: Missing upstash-signature header" });
  }

  try {
    // Get the request body as a string.
    // In Express, if express.json() is active, we stringify the parsed object.
    const rawBody = req.body && Object.keys(req.body).length > 0 ? JSON.stringify(req.body) : "";

    const isValid = await qstashReceiver.verify({
      signature: signature as string,
      body: rawBody,
    });

    if (!isValid) {
      return res.status(403).json({ error: "Forbidden: Invalid Upstash signature" });
    }

    next();
  } catch (error) {
    console.error("QStash signature verification failed:", error);
    return res.status(403).json({ error: "Forbidden: Verification failed" });
  }
}
