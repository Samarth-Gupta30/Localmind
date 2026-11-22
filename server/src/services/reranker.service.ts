import type { SearchResult } from './vectorStore.service';
import { logger } from '../utils/logger';

const CTX = 'Reranker';
const MODEL_NAME = 'Xenova/ms-marco-MiniLM-L-6-v2';
const MAX_POOL = 5;
const MAX_TOKENS = 512; // hard limit of this BERT-style model (query + document together)
const MAX_QUERY_CHARS = 1000; // cheap guard so a huge query cannot eat the whole token budget

export interface RerankerRuntime {
  tokenizer: any;
  model: any;
}

/**
 * Validates the model output and returns one finite logit per input pair.
 * Throws on anything unexpected so the caller can fall back to the original ranking.
 * Exported so it can be unit-tested without loading a real model.
 */
export function extractScores(output: any, expectedCount: number): number[] {
  const logits = output?.logits;
  if (!logits || !logits.data || !Array.isArray(logits.dims)) {
    throw new Error('Reranker output has no logits tensor');
  }

  const [rows, cols] = logits.dims as number[];
  // ms-marco cross-encoders emit ONE relevance logit per pair: shape [N, 1]
  if (rows !== expectedCount || (cols !== undefined && cols !== 1)) {
    throw new Error(`Unexpected logits shape [${logits.dims.join(', ')}], expected [${expectedCount}, 1]`);
  }
  if (logits.data.length !== expectedCount) {
    throw new Error(`Logits length ${logits.data.length} does not match ${expectedCount} documents`);
  }

  const scores = Array.from(logits.data as ArrayLike<number>, Number);
  if (!scores.every(Number.isFinite)) {
    throw new Error('Reranker produced a non-finite score (NaN/Infinity)');
  }
  return scores;
}

export async function defaultLoader(): Promise<RerankerRuntime> {
  const { env, AutoTokenizer, AutoModelForSequenceClassification } = await import('@xenova/transformers');
  // Strictly disable remote Hugging Face downloads to guarantee offline-first operation.
  env.allowLocalModels = true;
  env.allowRemoteModels = false;

  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_NAME);
  const model = await AutoModelForSequenceClassification.from_pretrained(MODEL_NAME, {
    quantized: true, // 8-bit quantization for fast CPU execution
  });
  return { tokenizer, model };
}

export class RerankerService {
  private runtime: RerankerRuntime | null = null;
  private loading: Promise<RerankerRuntime> | null = null;

  /** `loader` is injectable so tests can simulate load failures without downloading a model. */
  constructor(private readonly loader: () => Promise<RerankerRuntime> = defaultLoader) {}

  private getRuntime(): Promise<RerankerRuntime> {
    if (this.runtime) return Promise.resolve(this.runtime);

    if (!this.loading) {
      logger.info(CTX, `Loading local reranker model (offline only): ${MODEL_NAME}...`);
      this.loading = this.loader()
        .then((rt) => {
          this.runtime = rt;
          logger.info(CTX, 'Model and tokenizer loaded successfully.');
          return rt;
        })
        .catch((err) => {
          // Clear failed promise so a subsequent call can retry if local assets become available.
          this.loading = null;
          throw err;
        });
    }
    return this.loading;
  }

  public async prewarm(): Promise<void> {
    try {
      await this.getRuntime();
    } catch (err) {
      logger.warn(CTX, 'Pre-warm failed (offline model unavailable), will fall back or retry on demand:', err);
    }
  }

  /**
   * Re-ranks candidates with a cross-encoder. Ordering uses the raw uncalibrated
   * relevance logit (stored in `rerankScore`, not a probability or confidence percentage).
   * The original retrieval `score` is left untouched. On any failure, returns the original order.
   */
  public async rerank(query: string, candidates: SearchResult[], topK: number = 3): Promise<SearchResult[]> {
    if (!candidates || candidates.length === 0) return [];
    const cleanQuery = (query ?? '').trim().slice(0, MAX_QUERY_CHARS);
    if (!cleanQuery) return candidates.slice(0, topK);

    // Empty chunks carry no signal; keep them out of the model.
    const pool = candidates.slice(0, MAX_POOL).filter((c) => (c.chunk?.text ?? '').trim().length > 0);
    if (pool.length === 0) return candidates.slice(0, topK);

    try {
      const { tokenizer, model } = await this.getRuntime();

      // Token-aware truncation: the tokenizer counts real tokens and cuts the
      // pair (query + document) to MAX_TOKENS. No manual character slicing.
      const inputs = tokenizer(Array(pool.length).fill(cleanQuery), {
        text_pair: pool.map((c) => c.chunk.text),
        padding: true,
        truncation: true,
        max_length: MAX_TOKENS,
      });

      const output = await model(inputs);
      const scores = extractScores(output, pool.length);

      const ranked = pool
        .map((item, i) => ({ ...item, rerankScore: scores[i] }))
        .sort((a, b) => b.rerankScore - a.rerankScore);

      logger.debug(CTX, `Re-ranked ${pool.length} candidates, returning top ${topK}.`);
      return ranked.slice(0, topK);
    } catch (error) {
      logger.error(CTX, 'Reranking failed, falling back to original ranking', error);
      return candidates.slice(0, topK);
    }
  }
}