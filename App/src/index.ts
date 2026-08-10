import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { prisma } from './lib/db';
import apiRouter from './routes';

const app = express();
const PORT = Number(process.env.PORT) || 3002;

// Middleware
app.use(cors());
app.use(express.json());

// Health check — includes DB connectivity probe
app.get('/health', async (_req: Request, res: Response) => {
  let dbStatus = 'down';
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbStatus = 'up';
  } catch {
    dbStatus = 'down';
  }
  res.json({ status: 'ok', db: dbStatus, timestamp: new Date().toISOString() });
});

// API routes
app.use('/api', apiRouter);

app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
});
