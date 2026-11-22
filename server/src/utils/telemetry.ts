export interface OllamaGenerationMetadata {
  total_duration?: number;       // Total time in nanoseconds
  load_duration?: number;        // Model load time in nanoseconds
  prompt_eval_count?: number;    // Tokens in prompt
  prompt_eval_duration?: number; // Prompt evaluation time in nanoseconds
  eval_count?: number;           // Actual tokens generated
  eval_duration?: number;        // Token generation time in nanoseconds
}

/** How a generation ended. Only 'completed' metrics may be shown as a normal result. */
export type GenerationStatus = 'completed' | 'cancelled' | 'failed';

export interface TelemetryMetrics {
  startTime: number;
  firstTokenTime: number | null;
  endTime: number | null;
  ttftMs: number;              // Time to First Token (ms), measured by this server. 0 = no token arrived
  totalDurationMs: number;     // Total round-trip time (ms)
  totalTokens: number;         // Generated tokens (Ollama eval_count). 0 = unavailable, never guessed
  tps: number;                 // Generated tokens / generation seconds. 0 = unavailable
  promptTokens?: number;       // Input context tokens (from Ollama)
  status: GenerationStatus;
}

/** Returns the value only if it is a finite number > 0; otherwise null. */
function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export class TelemetryTracker {
  private startTime: number;
  private firstTokenTime: number | null = null;
  private endTime: number | null = null;

  constructor() {
    this.startTime = performance.now();
  }

  /** Called when a token chunk arrives. Only the FIRST call matters (TTFT). */
  public recordToken(): void {
    if (this.firstTokenTime === null) {
      this.firstTokenTime = performance.now();
    }
  }

  /**
   * Finalizes metrics. Token counts and TPS come ONLY from Ollama's own metadata.
   * Anything missing or invalid becomes 0 ("unavailable") instead of a guess.
   * `status` tells the caller whether this was a real completion.
   */
  public finish(
    metadata?: OllamaGenerationMetadata,
    status: GenerationStatus = 'completed'
  ): TelemetryMetrics {
    this.endTime = performance.now();

    // 1. TTFT: our own measurement. No token ever arrived => 0 (not prompt_eval_duration,
    //    which excludes model load time and so is not time-to-first-token).
    const ttftMs =
      this.firstTokenTime !== null
        ? Math.max(0, Math.round(this.firstTokenTime - this.startTime))
        : 0;

    // 2. Total duration: Ollama's value if valid, else wall clock.
    const ollamaTotalNs = positiveNumber(metadata?.total_duration);
    const totalDurationMs = ollamaTotalNs
      ? Math.round(ollamaTotalNs / 1e6)
      : Math.max(0, Math.round(this.endTime - this.startTime));

    // 3. Generated tokens: eval_count only (0 is a legitimate "no tokens" value).
    const rawEval = metadata?.eval_count;
    const totalTokens =
      typeof rawEval === 'number' && Number.isFinite(rawEval) && rawEval > 0
        ? Math.round(rawEval)
        : 0;

    // 4. TPS: needs BOTH a valid token count and a valid generation duration.
    const evalDurationNs = positiveNumber(metadata?.eval_duration);
    const tps =
      totalTokens > 0 && evalDurationNs
        ? Number((totalTokens / (evalDurationNs / 1e9)).toFixed(1))
        : 0;

    const promptTokens = positiveNumber(metadata?.prompt_eval_count) ?? undefined;

    return {
      startTime: this.startTime,
      firstTokenTime: this.firstTokenTime,
      endTime: this.endTime,
      ttftMs,
      totalDurationMs,
      totalTokens,
      tps,
      promptTokens,
      status,
    };
  }
}
