import { TelemetryTracker, TelemetryMetrics } from '../utils/telemetry';
import { preferenceStore, PreferenceStore } from './preference.service';
import { logger } from '../utils/logger';
import { env } from '../config/env';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onDone: (metrics: TelemetryMetrics) => void;
  onError: (error: Error) => void;
}

export interface ModelProfile {
  name: string;
  isFastMode: boolean;
  systemPromptModifier: string;
  temperature: number;
  topP: number;
  topK: number;
}

function normalizeModelTag(modelName: string): string {
  const trimmed = modelName.trim().toLowerCase();
  if (!trimmed) return '';
  const colonIndex = trimmed.indexOf(':');
  if (colonIndex === -1) {
    return `${trimmed}:latest`;
  }
  const base = trimmed.slice(0, colonIndex);
  const tag = trimmed.slice(colonIndex + 1) || 'latest';
  return `${base}:${tag}`;
}

export function matchesOllamaModel(installedName: string, requiredName: string): boolean {
  const cleanRequired = requiredName.trim();
  if (!cleanRequired) return true;
  const cleanInstalled = installedName.trim();
  if (!cleanInstalled) return false;
  return normalizeModelTag(cleanInstalled) === normalizeModelTag(cleanRequired);
}

export function getModelProfile(modelName?: string): ModelProfile {
  const isFast = !modelName || modelName.includes('1.5b');

  if (isFast) {
    return {
      name: modelName || 'qwen2.5:1.5b',
      isFastMode: true,
      systemPromptModifier: `MODE: FAST INFERENCE (1.5B Speed Mode)
- Prioritize direct answers and efficient reasoning.
- Focus on accuracy and avoid unnecessary computation.`,
      temperature: 0.1,
      topP: 0.8,
      topK: 20,
    };
  }

  return {
    name: modelName || 'qwen2.5:3b',
    isFastMode: false,
    systemPromptModifier: `MODE: DEEP ANALYSIS (3B Comprehensive Mode)
- Carefully check assumptions and account for relevant nuances.
- Use the model's stronger reasoning capabilities where the request requires them.`,
    temperature: 0.6,
    topP: 0.9,
    topK: 40,
  };
}

export function buildSystemPrompt(
  basePrompt?: string,
  modelName?: string
): string {
  const now = new Date();

  const formattedDateTime = now.toLocaleString('en-IN', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  });

  const profile = getModelProfile(modelName);

  return `${basePrompt || 'You are LocalMind, an offline AI assistant.'}

Current Time (Internal System Clock): ${formattedDateTime}

${profile.systemPromptModifier}

OUTPUT RULES:
1. Answer the user request directly according to the current mode.
2. Do NOT mention or output the Current Time unless the user explicitly asks for the date, day, or time.
3. If executing a tool, output ONLY the JSON tool payload without conversational filler text.`;
}

function getResponseStyleModifier(
  style: 'concise' | 'balanced' | 'detailed'
): string {
  const styles = {
    concise: `RESPONSE STYLE: CONCISE
- Answer directly in 1-3 sentences or a few compact bullets.
- Include only essential details; omit background and repetition.`,

    balanced: `RESPONSE STYLE: BALANCED
- Give a clear explanation with the key supporting details.
- Add brief context or an example when useful, without overexplaining.`,

    detailed: `RESPONSE STYLE: DETAILED
- Explain the relevant concepts thoroughly and include useful context, examples,
  implications, and steps where appropriate.
- Use headings or bullets to make longer answers easy to follow.`,
  };

  return styles[style] ?? styles.balanced;
}

export class OllamaService {
  private baseUrl: string;
  private defaultModel: string;
  private preferenceStore: PreferenceStore;

  constructor() {
    this.baseUrl = env.ollamaBaseUrl;
    this.defaultModel = env.defaultModel;
    this.preferenceStore = preferenceStore;
  }

  /**
   * Verifies that the local Ollama daemon is reachable and that the configured
   * default chat model and embedding model are installed with matching tags.
   */
  public async checkHealth(
    timeoutMs: number = 2500
  ): Promise<{
    ok: boolean;
    daemonReachable: boolean;
    modelCount?: number;
    hasDefaultModel?: boolean;
    hasEmbeddingModel?: boolean;
    missingModels?: string[];
    error?: string;
  }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: ac.signal,
      });

      if (!response.ok) {
        return {
          ok: false,
          daemonReachable: false,
          error: `Ollama returned HTTP ${response.status}`,
        };
      }

      const data = (await response.json()) as { models?: Array<{ name?: string }> };
      const models = Array.isArray(data?.models) ? data.models : [];
      const names = models
        .map((m) => (typeof m?.name === 'string' ? m.name.trim() : ''))
        .filter((n) => n.length > 0);

      const hasDefaultModel = names.some((installed) =>
        matchesOllamaModel(installed, this.defaultModel)
      );
      const hasEmbeddingModel = names.some((installed) =>
        matchesOllamaModel(installed, env.embeddingModel)
      );
      const missingModels: string[] = [];
      if (!hasDefaultModel) missingModels.push(this.defaultModel);
      if (!hasEmbeddingModel) missingModels.push(env.embeddingModel);

      if (missingModels.length > 0) {
        return {
          ok: false,
          daemonReachable: true,
          modelCount: names.length,
          hasDefaultModel,
          hasEmbeddingModel,
          missingModels,
          error: `Missing Ollama model(s): ${missingModels.join(', ')}`,
        };
      }

      return {
        ok: true,
        daemonReachable: true,
        modelCount: names.length,
        hasDefaultModel,
        hasEmbeddingModel,
        missingModels: [],
      };
    } catch (err) {
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? `Ollama health check timed out after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      return { ok: false, daemonReachable: false, error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  public async streamChat(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    modelOverride?: string,
    signal?: AbortSignal
  ): Promise<void> {
    const telemetry = new TelemetryTracker();
    const modelToUse = modelOverride || this.defaultModel;
    const profile = getModelProfile(modelToUse);

    const savedTemperature = this.preferenceStore.get('temperature');
    const temperature =
      Number.isFinite(savedTemperature)
        ? Math.min(1, Math.max(0, savedTemperature))
        : profile.temperature;

    logger.info('OllamaService', `Model: ${modelToUse} | Temperature: ${temperature}`);

    const hasSystemMessage = messages.some((msg) => msg.role === 'system');
    const finalMessages: ChatMessage[] = hasSystemMessage
      ? [...messages]
      : [
          {
            role: 'system',
            content: buildSystemPrompt(undefined, modelToUse),
          },
          ...messages,
        ];

    const responseStyle = this.preferenceStore.get('responseStyle');
    const styleModifier = getResponseStyleModifier(responseStyle);
    const numPredict = {
      concise: 200,
      balanced: 512,
      detailed: 1024,
    }[responseStyle];

    const systemMessageIndex = finalMessages.findIndex(
      (message) => message.role === 'system'
    );

    if (systemMessageIndex !== -1) {
      finalMessages[systemMessageIndex] = {
        ...finalMessages[systemMessageIndex],
        content: `${finalMessages[systemMessageIndex].content}

USER RESPONSE STYLE PREFERENCE (follow this over conflicting model-mode length or formatting guidance):
${styleModifier}

Do not let generic model-mode instructions override this style. Preserve document
grounding, tool protocols, factual accuracy, and explicit task-specific constraints.`,
      };
    }

    logger.info('OllamaService', `Response Style: ${responseStyle}`);

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelToUse,
          messages: finalMessages,
          stream: true,
          keep_alive: '15m',
          options: {
            temperature,
            num_ctx: 4096,
            num_predict: numPredict,
            top_p: profile.topP,
            top_k: profile.topK,
          },
        }),
        signal,
      });

      if (!response.ok) {
        throw new Error(
          `Ollama API responded with status ${response.status}: ${response.statusText}`
        );
      }

      if (!response.body) {
        throw new Error('Ollama response body is empty or unreadable.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      const onAbort = () => {
        reader.cancel().catch(() => {});
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      const handleLine = (parsed: any): boolean => {
        if (signal?.aborted) {
          return true;
        }

        if (typeof parsed?.error === 'string') {
          const failed = telemetry.finish(undefined, 'failed');
          logger.error('OllamaService', `Generation failed (${failed.status}): ${parsed.error}`);
          callbacks.onError(new Error(parsed.error));
          return true;
        }

        if (parsed?.message?.content) {
          telemetry.recordToken();
          callbacks.onToken(parsed.message.content);
        }

        if (parsed?.done) {
          if (signal?.aborted) return true;
          callbacks.onDone(telemetry.finish(parsed, 'completed'));
          return true;
        }
        return false;
      };

      const processLine = (line: string): boolean => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          logger.warn('OllamaService', 'Skipping malformed NDJSON line:', err);
          return false;
        }
        return handleLine(parsed);
      };

      try {
        while (true) {
          if (signal?.aborted) {
            const cancelled = telemetry.finish(undefined, 'cancelled');
            logger.info('OllamaService', `Generation ${cancelled.status} by client after ${cancelled.totalDurationMs}ms.`);
            return;
          }

          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (processLine(trimmed)) return;
          }
        }

        buffer += decoder.decode();
        if (!signal?.aborted && buffer.trim() && processLine(buffer.trim())) return;

        if (signal?.aborted) {
          telemetry.finish(undefined, 'cancelled');
          return;
        }
        telemetry.finish(undefined, 'failed');
        callbacks.onError(new Error('Ollama stream ended before generation completed.'));
      } finally {
        signal?.removeEventListener('abort', onAbort);
        try {
          await reader.cancel();
        } catch {
          // Stream might already be closed
        }
        try {
          reader.releaseLock();
        } catch {
          // Lock might already be released
        }
      }
    } catch (error: unknown) {
      if (
        signal?.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        telemetry.finish(undefined, 'cancelled');
        logger.info('OllamaService', 'Stream aborted cleanly by client.');
      } else {
        telemetry.finish(undefined, 'failed');
        callbacks.onError(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }
  }
}

export const ollamaService = new OllamaService();