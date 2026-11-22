import { AppError } from '../utils/errorHandler';
import { isValidVector, normalizeVector } from '../utils/vector';
import { env } from '../config/env';

const DEFAULT_TIMEOUT_MS = 60_000; // first call may include a cold model load

function resolveTimeoutMs(explicit?: number): number {
  const candidate = explicit ?? env.embeddingTimeoutMs;
  return Number.isFinite(candidate) && candidate > 0 ? candidate : DEFAULT_TIMEOUT_MS;
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export class EmbeddingService {
  private ollamaUrl: string;
  private model!: string;
  private readonly timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.ollamaUrl = env.ollamaBaseUrl;
    this.embeddingModel = env.embeddingModel;
    this.timeoutMs = resolveTimeoutMs(options.timeoutMs);
  }

  public get embeddingModel(): string {
    return this.model;
  }

  public set embeddingModel(modelName: string) {
    this.model = modelName;
  }

  public static isValidVector(vec: unknown): vec is number[] {
    return isValidVector(vec);
  }

  /**
   * Sends one embedding request to Ollama, honoring both caller cancellation
   * (`signal`) and the per-request timeout (`this.timeoutMs`).
   */
  private async requestEmbedding(prompt: string, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) {
      throw new AppError('[EmbeddingService] Embedding request was cancelled.', 499);
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        onExternalAbort();
      } else {
        signal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    try {
      const response = await fetch(`${this.ollamaUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new AppError(
          `[EmbeddingService] Ollama error (${response.status}): ${errorText.slice(0, 300)}`,
          502
        );
      }

      try {
        return await response.json();
      } catch (err) {
        if (signal?.aborted) {
          throw new AppError('[EmbeddingService] Embedding request was cancelled.', 499);
        }
        if (timedOut || isTimeoutError(err)) {
          throw new AppError(
            `[EmbeddingService] Ollama did not answer within ${this.timeoutMs} ms (model '${this.model}').`,
            504
          );
        }
        throw new AppError(
          `[EmbeddingService] Ollama returned a response that is not valid JSON (model '${this.model}').`,
          502
        );
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (signal?.aborted || isAbortError(err)) {
        if (timedOut) {
          throw new AppError(
            `[EmbeddingService] Ollama did not answer within ${this.timeoutMs} ms (model '${this.model}').`,
            504
          );
        }
        throw new AppError('[EmbeddingService] Embedding request was cancelled.', 499);
      }
      if (timedOut || isTimeoutError(err)) {
        throw new AppError(
          `[EmbeddingService] Ollama did not answer within ${this.timeoutMs} ms (model '${this.model}').`,
          504
        );
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new AppError(`[EmbeddingService] Failed to connect to Ollama: ${reason}`, 503);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /**
   * Generates a vector embedding for a text string and normalizes it (L2 norm = 1.0).
   */
  public async getEmbedding(
    text: string,
    taskType?: 'search_query' | 'search_document',
    signal?: AbortSignal
  ): Promise<number[]> {
    if (signal?.aborted) {
      throw new AppError('[EmbeddingService] Embedding request was cancelled.', 499);
    }

    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new AppError('[EmbeddingService] Cannot generate embedding for empty text.', 400);
    }

    const formattedPrompt = taskType ? `${taskType}: ${text}` : text;
    const data = await this.requestEmbedding(formattedPrompt, signal);

    if (signal?.aborted) {
      throw new AppError('[EmbeddingService] Embedding request was cancelled.', 499);
    }

    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new AppError(
        `[EmbeddingService] Unexpected response shape from Ollama for model '${this.model}'.`,
        502
      );
    }

    const body = data as { embedding?: unknown; error?: unknown };
    if (typeof body.error === 'string' && body.error.length > 0) {
      throw new AppError(`[EmbeddingService] Ollama reported: ${body.error.slice(0, 300)}`, 502);
    }

    const rawVector = body.embedding;
    if (!isValidVector(rawVector)) {
      throw new AppError(
        `[EmbeddingService] Received invalid vector embedding from model '${this.model}'. Vector must be a non-empty array of finite numbers.`,
        502
      );
    }

    const normalized = normalizeVector(rawVector);
    if (!normalized) {
      throw new AppError(
        `[EmbeddingService] Model '${this.model}' returned a zero-magnitude or non-finite embedding vector.`,
        502
      );
    }

    return normalized;
  }
}

export const embeddingService = new EmbeddingService();