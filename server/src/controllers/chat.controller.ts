import { Request, Response } from 'express';
import {
  ollamaService,
  ChatMessage,
  getModelProfile,
  buildSystemPrompt,
} from '../services/ollama.service';
import { embeddingService } from '../services/embedding.service';
import { vectorStoreService, SearchResult } from '../services/vectorStore.service';
import {
  applySlidingWindow,
  estimateMessageTokens,
  estimateTokens,
} from '../utils/contextWindow';
import { reciprocalRankFusion } from '../utils/rrf';
import { RerankerService } from '../services/reranker.service';
import { bm25Service } from '../services/bm25.service';
import {
  initSSEResponse,
  writeSSEEvent,
  writeSSEError,
  createSSEAbortController,
} from '../utils/sse';
import { AppError, handleControllerError } from '../utils/errorHandler';
import { preferenceStore } from '../services/preference.service';
import { logger } from '../utils/logger';
import { env } from '../config/env';

const rerankerService = new RerankerService();
rerankerService.prewarm().catch(() => {});

const MAX_CHAT_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 32_000;
export const MAX_RAG_QUERY_CHARS = 4_000;

/* -------------------------------------------------------------------------- */
/* Helper: build SSE callbacks                                               */
/* -------------------------------------------------------------------------- */
function buildStreamCallbacks(
  res: Response,
  extraDoneData: Record<string, unknown> = {},
  signal?: AbortSignal
) {
  return {
    onToken: (token: string) => writeSSEEvent(res, { type: 'token', token }, signal),
    onDone: (metrics: unknown) => {
      if (signal?.aborted) return;
      writeSSEEvent(res, { type: 'done', metrics, ...extraDoneData }, signal);
      if (!res.writableEnded) res.end();
    },
    onError: (error: Error) => writeSSEError(res, error.message, signal),
  };
}

/* -------------------------------------------------------------------------- */
/* Helper: validate & sanitize general chat messages                          */
/* -------------------------------------------------------------------------- */
export function validateGeneralChatMessages(rawMessages: unknown): ChatMessage[] {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new AppError('Request body must contain a non-empty "messages" array.', 400);
  }

  if (rawMessages.length > MAX_CHAT_MESSAGES) {
    throw new AppError(
      `Too many messages in request (${rawMessages.length}). Maximum allowed is ${MAX_CHAT_MESSAGES}.`,
      400
    );
  }

  const validated: ChatMessage[] = [];
  let hasUserMessage = false;

  for (let i = 0; i < rawMessages.length; i++) {
    const item = rawMessages[i];
    if (!item || typeof item !== 'object') {
      throw new AppError(`Invalid message at index ${i}: expected an object.`, 400);
    }

    const { role, content } = item as { role?: unknown; content?: unknown };

    if (role === 'system') {
      throw new AppError(
        `Invalid message at index ${i}: client-supplied "system" messages are not allowed.`,
        400
      );
    }

    if (role !== 'user' && role !== 'assistant') {
      throw new AppError(
        `Invalid message role at index ${i}: must be "user" or "assistant".`,
        400
      );
    }

    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new AppError(
        `Invalid message content at index ${i}: must be a non-empty string.`,
        400
      );
    }

    if (content.length > MAX_MESSAGE_CHARS) {
      throw new AppError(
        `Message content at index ${i} exceeds maximum length of ${MAX_MESSAGE_CHARS} characters.`,
        400
      );
    }

    if (role === 'user') {
      hasUserMessage = true;
    }

    validated.push({
      role,
      content: content.trim(),
    });
  }

  if (!hasUserMessage) {
    throw new AppError('Messages must include at least one "user" message.', 400);
  }

  return validated;
}

/* -------------------------------------------------------------------------- */
/* Helper: sanitize conversation history                                      */
/* -------------------------------------------------------------------------- */
function sanitizeHistory(history: unknown, maxTurns: number): ChatMessage[] {
  if (!Array.isArray(history)) return [];

  return history
    .filter(
      (m): m is ChatMessage =>
        m !== null &&
        typeof m === 'object' &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim().length > 0 &&
        m.content.length <= MAX_MESSAGE_CHARS
    )
    .slice(-(maxTurns * 2))
    .map((m) => ({
      role: m.role,
      content: m.content.trim(),
    }));
}

/* -------------------------------------------------------------------------- */
/* Helper: context & citation building                                        */
/* -------------------------------------------------------------------------- */
function buildContextBlock(chunks: SearchResult[]): string {
  return chunks
    .map((item, index) => {
      const { chunk } = item;
      let pageInfo = '';
      if (chunk.pageNumber != null) {
        pageInfo =
          chunk.endPageNumber != null && chunk.endPageNumber !== chunk.pageNumber
            ? `Pages ${chunk.pageNumber}-${chunk.endPageNumber}`
            : `Page ${chunk.pageNumber}`;
      }
      const sourceInfo = [
        `Source: "${chunk.fileName || 'Document'}"`,
        pageInfo,
        `Chunk #${chunk.chunkIndex ?? index}`,
      ]
        .filter(Boolean)
        .join(', ');
      return `[EXCERPT ${index + 1}] ${sourceInfo}\n${chunk.text}`;
    })
    .join('\n\n---\n\n');
}

function buildCitations(chunks: SearchResult[]) {
  return chunks.map((item) => ({
    fileName: item.chunk.fileName,
    pageNumber: item.chunk.pageNumber,
    endPageNumber: item.chunk.endPageNumber,
    chunkIndex: item.chunk.chunkIndex,
    retrievalScore: item.score,
    score: item.score,
    snippet: (item.chunk.text || '').slice(0, 150) + '...',
    sectionTitle: item.chunk.sectionTitle,
    contentType: item.chunk.contentType,
  }));
}

export function alignCitationsWithFinalPrompt(
  citations: Array<
    ReturnType<typeof buildCitations>[number] & {
      id?: string;
      text?: string;
      chunk?: { id?: string; text?: string };
    }
  >,
  finalPromptOrSystem: string | Array<{ role?: string; content?: string }>
) {
  if (!Array.isArray(citations) || citations.length === 0) return [];

  const systemText = Array.isArray(finalPromptOrSystem)
    ? finalPromptOrSystem
        .filter((m) => m && m.role === 'system' && typeof m.content === 'string')
        .map((m) => m.content as string)
        .join('\n')
    : typeof finalPromptOrSystem === 'string'
      ? finalPromptOrSystem
      : '';

  const normSystem = systemText.replace(/\s+/g, ' ').trim();
  if (!normSystem) return [];

  return citations.filter((c) => {
    const rawCandidate = String(c.text ?? c.chunk?.text ?? c.snippet ?? '')
      .replace(/\.{2,}$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!rawCandidate) return false;
    if (normSystem.includes(rawCandidate)) return true;
    const prefixLen = Math.min(rawCandidate.length, 24);
    const prefix = rawCandidate.slice(0, prefixLen).trim();
    return prefix.length >= 4 && normSystem.includes(prefix);
  });
}

/* -------------------------------------------------------------------------- */
/* Helper: RAG system prompt                                                */
/* -------------------------------------------------------------------------- */
function buildRagSystemPrompt(isFastMode: boolean, contextBlock: string): ChatMessage {
  const content = isFastMode
    ? `You are LocalMind running in FAST RESPONSE MODE (1.5B Model).
Answer the user's CURRENT question directly using ONLY the provided document excerpts.

CRITICAL FAST MODE RULES:
1. Follow the user's selected response style for answer length and structure.
2. Omit conversational filler, preamble, and pleasantries.
3. Never include internal labels like [EXCERPT 1] in your output.
4. If the answer cannot be found in the excerpts, say: "I cannot find this information in the uploaded documents."
5. Never invent facts outside the excerpts.

--- DOCUMENT EXCERPTS ---
${contextBlock}
-------------------------`
    : `You are LocalMind running in DEEP ANALYSIS MODE (3B Model).
Answer the user's CURRENT question using ONLY the provided document excerpts as factual evidence.

CRITICAL DEEP MODE RULES:
1. Follow the user's selected response style for answer length and structure.
2. Use clear markdown structure when it helps readability.
3. Never include internal labels like [EXCERPT 1] in your output.
4. If the answer cannot be found in the excerpts, state clearly: "I cannot find this information in the uploaded documents."
5. Never invent facts outside the excerpts.

--- DOCUMENT EXCERPTS ---
${contextBlock}
-------------------------`;
  return { role: 'system', content };
}

/* -------------------------------------------------------------------------- */
/* Hybrid search (BM25 + vector) + RRF fusion                                */
/* -------------------------------------------------------------------------- */
async function runHybridSearch(
  uniqueQueries: string[],
  fileFilter: string[],
  candidatePool: number,
  minScore: number,
  signal?: AbortSignal
): Promise<SearchResult[][]> {
  if (signal?.aborted) return [];

  const hasDocs = await bm25Service.ensureIndex(
    () => vectorStoreService.getAllChunks(fileFilter),
    vectorStoreService.getVersion(),
    fileFilter
  );

  if (signal?.aborted) return [];

  const allQueryResults: SearchResult[][] = [];

  if (hasDocs) {
    const bm25RawByQuery = uniqueQueries.map((q) => bm25Service.search(q, candidatePool));
    const allIds = bm25RawByQuery.flat().map((hit) => hit.id);

    if (allIds.length > 0 && !signal?.aborted) {
      const fetchedChunks = await vectorStoreService.getChunksByIds(allIds);
      const chunkMap = new Map(fetchedChunks.map((c) => [c.id, c]));

      for (const raw of bm25RawByQuery) {
        const hits = raw
          .map((i) => {
            const chunk = chunkMap.get(i.id);
            return chunk ? { chunk, score: i.score } : null;
          })
          .filter((i): i is SearchResult => i !== null);
        if (hits.length > 0) allQueryResults.push(hits);
      }
    }
  }

  if (signal?.aborted) return [];

  const queryEmbeddings = await Promise.all(
    uniqueQueries.map((q) => embeddingService.getEmbedding(q, 'search_query', signal))
  );

  if (signal?.aborted) return [];

  for (const qEmb of queryEmbeddings) {
    if (signal?.aborted) return [];
    const vecHits = await vectorStoreService.search(qEmb, candidatePool, minScore, fileFilter);
    if (vecHits.length > 0) allQueryResults.push(vecHits);
  }

  return allQueryResults;
}

/* -------------------------------------------------------------------------- */
/* Rerank with graceful fallback                                            */
/* -------------------------------------------------------------------------- */
async function rerankWithFallback(
  userQuery: string,
  candidateHits: SearchResult[],
  rerankPoolSize: number,
  finalTopK: number,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  if (candidateHits.length === 0 || signal?.aborted) return [];

  try {
    const pool = candidateHits.slice(0, rerankPoolSize);
    const raw = await rerankerService.rerank(userQuery, pool, finalTopK);
    if (signal?.aborted) return [];
    const filtered = Array.isArray(raw)
      ? raw.filter((i): i is SearchResult => Boolean(i?.chunk?.text))
      : [];
    if (filtered.length > 0) return filtered;
  } catch (e) {
    if (signal?.aborted) return [];
    logger.warn('RAG Search', 'Reranker failed, falling back to top RRF hits:', e);
  }

  return signal?.aborted ? [] : candidateHits.slice(0, finalTopK);
}

/* -------------------------------------------------------------------------- */
/* Helper: fit retrieved excerpts within the RAG context budget               */
/* -------------------------------------------------------------------------- */
export function selectExcerptsForPrompt(
  rankedExcerpts: SearchResult[],
  options: {
    isFastMode: boolean;
    maxTokens: number;
    userQuery: string;
    history?: ChatMessage[];
  }
): SearchResult[] {
  if (!Array.isArray(rankedExcerpts) || rankedExcerpts.length === 0) {
    return [];
  }

  const { isFastMode, maxTokens, userQuery, history = [] } = options;
  const shellPromptTokens = estimateMessageTokens(buildRagSystemPrompt(isFastMode, ''));
  const latestQueryTokens = estimateMessageTokens({ role: 'user', content: userQuery });
  const rawHistoryTokens = history.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  const reservedHistoryTokens = Math.min(rawHistoryTokens, Math.floor(maxTokens * 0.25));

  const evidenceBudgetTokens = Math.max(
    64,
    maxTokens - shellPromptTokens - latestQueryTokens - reservedHistoryTokens
  );

  const selected: SearchResult[] = [];
  let usedTokens = 0;

  for (const item of rankedExcerpts) {
    const chunkText = item.chunk?.text ?? '';
    if (!chunkText.trim()) continue;

    const separatorTokens = selected.length > 0 ? estimateTokens('\n\n---\n\n') : 0;
    const itemTokens = estimateTokens(chunkText) + separatorTokens + 16;

    if (usedTokens + itemTokens <= evidenceBudgetTokens) {
      selected.push(item);
      usedTokens += itemTokens;
    } else if (selected.length === 0) {
      const charBudget = Math.max(80, Math.floor((evidenceBudgetTokens - 24) * 3.3));
      const trimmedText =
        chunkText.length > charBudget
          ? `${chunkText.slice(0, charBudget).trimEnd()}\n...[truncated]`
          : chunkText;
      selected.push({
        ...item,
        chunk: { ...item.chunk, text: trimmedText },
      });
      break;
    } else {
      break;
    }
  }

  return selected;
}

/* -------------------------------------------------------------------------- */
/* Controllers                                                               */
/* -------------------------------------------------------------------------- */
export async function streamGeneralChat(req: Request, res: Response): Promise<void> {
  const abort = createSSEAbortController(res);
  try {
    const { messages, model } = req.body as { messages?: unknown; model?: string };
    const validatedMessages = validateGeneralChatMessages(messages);

    const profile = getModelProfile(model);
    const maxTurns = preferenceStore.get('maxContextTurns');
    const serverSystemPrompt: ChatMessage = {
      role: 'system',
      content: buildSystemPrompt(undefined, model),
    };

    const windowed = applySlidingWindow([serverSystemPrompt, ...validatedMessages], {
      maxTurns,
      maxTokens: profile.isFastMode ? 1200 : 2400,
    });

    initSSEResponse(res);
    if (abort.signal.aborted) return;

    await ollamaService.streamChat(
      windowed,
      buildStreamCallbacks(res, {}, abort.signal),
      model,
      abort.signal
    );
  } catch (err) {
    if (abort.signal.aborted) return;
    handleControllerError(res, err, 'General Chat Controller');
  }
}

export async function streamRagChat(req: Request, res: Response): Promise<void> {
  const abort = createSSEAbortController(res);
  try {
    const {
      query,
      conversationHistory = [],
      model,
      selectedFiles = [],
    } = req.body as {
      query: string;
      conversationHistory?: ChatMessage[];
      model?: string;
      selectedFiles?: string[];
    };

    if (!query?.trim()) {
      res.status(400).json({ error: 'Query text is required.', code: 'VALIDATION_ERROR' });
      return;
    }

    if (query.trim().length > MAX_RAG_QUERY_CHARS) {
      res.status(400).json({
        error: `Query exceeds maximum length of ${MAX_RAG_QUERY_CHARS} characters.`,
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    initSSEResponse(res);
    if (abort.signal.aborted) return;

    const userQuery = query.trim();
    const minScore = env.ragMinScore;
    const profile = getModelProfile(model);
    const candidatePool = profile.isFastMode ? 6 : 10;
    const finalTopK = profile.isFastMode ? 2 : 4;

    const fileFilter = Array.isArray(selectedFiles)
      ? selectedFiles.filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
      : [];

    if (fileFilter.length === 0) {
      writeSSEEvent(
        res,
        { type: 'token', token: 'I cannot find this information in the uploaded documents.' },
        abort.signal
      );
      writeSSEEvent(
        res,
        {
          type: 'done',
          metrics: { ttftMs: 0, totalDurationMs: 0, totalTokens: 0, tps: 0 },
          citations: [],
        },
        abort.signal
      );
      if (!res.writableEnded) res.end();
      return;
    }

    const uniqueQueries = [userQuery];

    const allResults = await runHybridSearch(
      uniqueQueries,
      fileFilter,
      candidatePool,
      minScore,
      abort.signal
    );
    if (abort.signal.aborted) return;

    const fused = reciprocalRankFusion(allResults, 60);
    const candidateHits = fused.slice(0, candidatePool);

    const relevant = await rerankWithFallback(
      userQuery,
      candidateHits,
      profile.isFastMode ? 3 : 5,
      finalTopK,
      abort.signal
    );
    if (abort.signal.aborted) return;

    if (relevant.length === 0) {
      writeSSEEvent(
        res,
        { type: 'token', token: 'I cannot find this information in the uploaded documents.' },
        abort.signal
      );
      writeSSEEvent(
        res,
        {
          type: 'done',
          metrics: { ttftMs: 0, totalDurationMs: 0, totalTokens: 0, tps: 0 },
          citations: [],
        },
        abort.signal
      );
      if (!res.writableEnded) res.end();
      return;
    }

    const maxHistTurns = preferenceStore.get('maxContextTurns');
    const recent = sanitizeHistory(conversationHistory, maxHistTurns);
    const maxBudget = profile.isFastMode ? 900 : 1800;

    const fittedExcerpts = selectExcerptsForPrompt(relevant, {
      isFastMode: profile.isFastMode,
      maxTokens: maxBudget,
      userQuery,
      history: recent,
    });

    const contextBlock = buildContextBlock(fittedExcerpts);
    const rawCitations = buildCitations(fittedExcerpts);
    const ragPrompt = buildRagSystemPrompt(profile.isFastMode, contextBlock);
    const messages: ChatMessage[] = [ragPrompt, ...recent, { role: 'user', content: userQuery }];

    const finalMsg = applySlidingWindow(messages, {
      maxTurns: maxHistTurns,
      maxTokens: maxBudget,
    });

    const finalSystemContent =
      finalMsg.find((m) => m.role === 'system')?.content ?? ragPrompt.content;
    const citations = alignCitationsWithFinalPrompt(rawCitations, finalSystemContent);

    await ollamaService.streamChat(
      finalMsg,
      buildStreamCallbacks(res, { citations }, abort.signal),
      model,
      abort.signal
    );
  } catch (err) {
    if (abort.signal.aborted) return;
    handleControllerError(res, err, 'RAG Controller');
  }
}