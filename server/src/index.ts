// Load environment variables before loading application modules
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';

import documentRoutes from './routes/document.routes';
import chatRoutes from './routes/chat.routes';
import agentRoutes from './routes/agent.routes';
import preferenceRoutes from './routes/preference.routes';

import { preferenceStore } from './services/preference.service';
import { vectorStoreService } from './services/vectorStore.service';
import { ollamaService } from './services/ollama.service';
import { logger } from './utils/logger';
import { handleControllerError } from './utils/errorHandler';
import { env, validateEnvConfig } from './config/env';

validateEnvConfig();

const app = express();
const PORT = env.port;

async function checkDependencies() {
  const [sqlite, lancedb, ollama] = await Promise.all([
    Promise.resolve(preferenceStore.checkHealth()),
    vectorStoreService.checkHealth(),
    ollamaService.checkHealth(),
  ]);

  const allHealthy = sqlite.ok && lancedb.ok && ollama.ok;
  return { allHealthy, services: { sqlite, lancedb, ollama } };
}

// ──────────────────────────────────────────────────────────────────────
// 1. Core Middlewares
// ──────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: env.clientOrigin,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  })
);

app.use(express.json({ limit: '1mb' }));

// ──────────────────────────────────────────────────────────────────────
// 2. Health / Readiness Check
// ──────────────────────────────────────────────────────────────────────
app.get('/api/health', async (_req: Request, res: Response) => {
  const readiness = await checkDependencies();
  res.status(readiness.allHealthy ? 200 : 503).json({
    status: readiness.allHealthy ? 'online' : 'degraded',
    uptime: `${Math.floor(process.uptime())} seconds`,
    timestamp: new Date().toISOString(),
    services: readiness.services,
  });
});

// ──────────────────────────────────────────────────────────────────────
// 3. Route Mounting
// ──────────────────────────────────────────────────────────────────────
app.use('/api/documents', documentRoutes);
app.use('/api/chat/agent', agentRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/preferences', preferenceRoutes);

// ──────────────────────────────────────────────────────────────────────
// 4. 404 Handler
// ──────────────────────────────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Route not found.', code: 'NOT_FOUND' });
});

// ──────────────────────────────────────────────────────────────────────
// 5. Global Error Handler (single, centralized handler)
// ──────────────────────────────────────────────────────────────────────
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    return next(err);
  }
  handleControllerError(res, err, 'UnhandledError');
});

// ──────────────────────────────────────────────────────────────────────
// 6. Server Start
// ──────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, async () => {
  logger.info('Server', '=========================================');
  logger.info('Server', `Running at: http://localhost:${PORT}`);
  logger.info('Server', `Upload endpoint: POST http://localhost:${PORT}/api/documents/upload`);
  logger.info('Server', `RAG stream:      POST http://localhost:${PORT}/api/chat/rag/stream`);
  logger.info('Server', `Agent stream:    POST http://localhost:${PORT}/api/chat/agent/stream`);
  logger.info('Server', '=========================================');

  const readiness = await checkDependencies();
  if (readiness.allHealthy) {
    logger.info('Server', 'All dependencies (SQLite, LanceDB, Ollama) are ready.');
  } else {
    logger.warn('Server', 'Started in degraded state; unavailable dependencies:', readiness.services);
  }
});

// ──────────────────────────────────────────────────────────────────────
// 7. Graceful Shutdown Handler
// ──────────────────────────────────────────────────────────────────────
const handleGracefulShutdown = (signal: string) => {
  logger.info('Server', `Received ${signal}. Shutting down gracefully...`);

  server.close(async () => {
    logger.info('Server', 'HTTP server stopped accepting new requests.');
    preferenceStore.close();
    await vectorStoreService.close();
    logger.info('Server', 'Cleanup complete. Exiting process.');
    process.exit(0);
  });

  setTimeout(() => {
    logger.warn('Server', 'Forced shutdown after 5s timeout.');
    process.exit(1);
  }, 5000).unref();
};

process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));
process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));