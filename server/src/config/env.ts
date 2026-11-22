import { logger } from '../utils/logger';

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseNonNegativeNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function validateEnvConfig(source: NodeJS.ProcessEnv = process.env): string[] {
  const warnings: string[] = [];

  if (source.PORT !== undefined && source.PORT.trim() !== '') {
    const p = Number(source.PORT);
    if (!Number.isFinite(p) || p <= 0 || p > 65535) {
      warnings.push(`Invalid PORT "${source.PORT}"; falling back to 5000.`);
    }
  }

  const rawUrl = source.OLLAMA_BASE_URL || source.OLLAMA_URL;
  if (rawUrl && rawUrl.trim() !== '') {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        warnings.push(`Unsupported OLLAMA_BASE_URL protocol "${parsed.protocol}"; expected http/https.`);
      }
    } catch {
      warnings.push(`Malformed OLLAMA_BASE_URL "${rawUrl}"; using fallback.`);
    }
  }

  if (source.RAG_MIN_SCORE !== undefined && source.RAG_MIN_SCORE.trim() !== '') {
    const s = Number(source.RAG_MIN_SCORE);
    if (!Number.isFinite(s) || s < 0) {
      warnings.push(`Invalid RAG_MIN_SCORE "${source.RAG_MIN_SCORE}"; falling back to 0.05.`);
    }
  }

  if (source.EMBEDDING_TIMEOUT_MS !== undefined && source.EMBEDDING_TIMEOUT_MS.trim() !== '') {
    const t = Number(source.EMBEDDING_TIMEOUT_MS);
    if (!Number.isFinite(t) || t <= 0) {
      warnings.push(`Invalid EMBEDDING_TIMEOUT_MS "${source.EMBEDDING_TIMEOUT_MS}"; falling back to 60000.`);
    }
  }

  for (const w of warnings) {
    logger.warn('Config', w);
  }
  return warnings;
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  port: parsePositiveInt(process.env.PORT, 5000),
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',

  ollamaBaseUrl: (
    process.env.OLLAMA_BASE_URL ||
    process.env.OLLAMA_URL ||
    'http://127.0.0.1:11434'
  ).replace(/\/+$/, ''),

  defaultModel: process.env.DEFAULT_MODEL || 'qwen2.5:1.5b',
  embeddingModel: process.env.EMBEDDING_MODEL || 'nomic-embed-text',
  embeddingTimeoutMs: parsePositiveInt(process.env.EMBEDDING_TIMEOUT_MS, 60_000),
  ragMinScore: parseNonNegativeNumber(process.env.RAG_MIN_SCORE, 0.05),
} as const;