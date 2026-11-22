import { Response } from 'express';
import { logger } from './logger';

export function initSSEResponse(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

export function isStreamWritable(res: Response): boolean {
  return Boolean(res.writable && !res.writableEnded && !res.destroyed);
}

export function writeSSEEvent(
  res: Response,
  data: Record<string, unknown>,
  signal?: AbortSignal
): boolean {
  if (signal?.aborted || !isStreamWritable(res)) {
    return false;
  }

  try {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch (err) {
    logger.warn('SSE', 'Failed to write event to disconnected socket:', err);
    return false;
  }
}

export function writeSSEError(res: Response, message: string, signal?: AbortSignal): void {
  if (!signal?.aborted && isStreamWritable(res)) {
    writeSSEEvent(res, { type: 'error', error: message }, signal);
    try {
      res.end();
    } catch {
      // Ignored if socket was closed simultaneously
    }
  }
}

export function createSSEAbortController(res: Response): AbortController {
  const abortController = new AbortController();

  const cleanup = () => {
    res.off('close', cleanup);
    res.off('finish', cleanup);
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
  };

  res.on('close', cleanup);
  res.on('finish', cleanup);

  return abortController;
}