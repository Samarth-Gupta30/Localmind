import type { ChatMessage } from '../services/ollama.service';
import { logger } from './logger';

/**
 * Sliding Window Context Manager
 *
 * Guarantees that:
 * 1. The system prompt is always preserved at index 0.
 * 2. The latest user prompt is always preserved at the end.
 * 3. History is pruned in complete (user + assistant) pairs.
 * 4. The oldest retained history turn always begins with a 'user' message.
 * 5. Total estimated tokens stay within `maxTokens` (truncating oversized
 *    system/latest messages when needed to prevent context overflow).
 *
 * NOTE: Token counts are fast heuristic estimates (not exact model/BPE token counts).
 */

const CHARS_PER_TOKEN = 3.3;
const MESSAGE_OVERHEAD_TOKENS = 4;
const TRUNCATION_MARKER = '\n...[truncated]';

export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  const charBased = Math.ceil(text.length / CHARS_PER_TOKEN);
  const wordBased = Math.ceil(text.trim().split(/\s+/).length * 1.3);
  return Math.max(charBased, wordBased);
}

export function estimateMessageTokens(msg: ChatMessage): number {
  return estimateTokens(msg.content) + MESSAGE_OVERHEAD_TOKENS;
}

function truncateMessageToBudget(msg: ChatMessage, tokenBudget: number): ChatMessage {
  if (estimateMessageTokens(msg) <= tokenBudget) {
    return msg;
  }

  const contentBudget = Math.max(1, tokenBudget - MESSAGE_OVERHEAD_TOKENS);
  let maxChars = Math.max(0, Math.floor(contentBudget * CHARS_PER_TOKEN) - TRUNCATION_MARKER.length);
  let candidate = msg.content.slice(0, maxChars).trimEnd() + TRUNCATION_MARKER;

  while (estimateTokens(candidate) + MESSAGE_OVERHEAD_TOKENS > tokenBudget && maxChars > 0) {
    maxChars = Math.floor(maxChars * 0.8);
    candidate =
      maxChars > 0
        ? msg.content.slice(0, maxChars).trimEnd() + TRUNCATION_MARKER
        : TRUNCATION_MARKER.trim();
  }

  return { ...msg, content: candidate };
}

export interface SlidingWindowOptions {
  /** Maximum conversation turn-pairs to keep (default: 10) */
  maxTurns?: number;
  /** Maximum total estimated tokens for the prompt payload (default: 2800) */
  maxTokens?: number;
}

export function applySlidingWindow(
  messages: ChatMessage[],
  options: SlidingWindowOptions = {}
): ChatMessage[] {
  const maxTurns = options.maxTurns ?? 10;
  const maxTokens = Math.max(32, options.maxTokens ?? 2800);

  if (!Array.isArray(messages) || messages.length === 0) return [];

  let systemMessage = messages.find((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');

  if (nonSystemMessages.length === 0) {
    return systemMessage ? [truncateMessageToBudget(systemMessage, maxTokens)] : [];
  }

  let latestMessage = nonSystemMessages[nonSystemMessages.length - 1];
  const priorHistory = nonSystemMessages.slice(0, -1);

  let candidateHistory = priorHistory.slice(-Math.max(0, maxTurns * 2));

  while (candidateHistory.length > 0 && candidateHistory[0].role !== 'user') {
    candidateHistory.shift();
  }

  let systemBudget = systemMessage ? estimateMessageTokens(systemMessage) : 0;
  let latestBudget = estimateMessageTokens(latestMessage);

  if (systemBudget + latestBudget > maxTokens) {
    candidateHistory = [];

    if (systemMessage) {
      const minLatestTarget = Math.min(latestBudget, Math.max(16, Math.floor(maxTokens * 0.5)));
      const systemTarget = Math.min(systemBudget, Math.max(16, maxTokens - minLatestTarget));
      const latestTarget = Math.max(16, maxTokens - systemTarget);

      if (systemBudget > systemTarget) {
        systemMessage = truncateMessageToBudget(systemMessage, systemTarget);
      }
      if (latestBudget > latestTarget) {
        latestMessage = truncateMessageToBudget(latestMessage, latestTarget);
      }
    } else {
      latestMessage = truncateMessageToBudget(latestMessage, maxTokens);
    }

    systemBudget = systemMessage ? estimateMessageTokens(systemMessage) : 0;
    latestBudget = estimateMessageTokens(latestMessage);
  }

  const availableForHistory = Math.max(0, maxTokens - systemBudget - latestBudget);

  while (candidateHistory.length > 0) {
    const historyTokens = candidateHistory.reduce(
      (sum, m) => sum + estimateMessageTokens(m),
      0
    );

    if (historyTokens <= availableForHistory) {
      break;
    }

    if (
      candidateHistory.length >= 2 &&
      candidateHistory[0].role === 'user' &&
      candidateHistory[1].role === 'assistant'
    ) {
      candidateHistory.splice(0, 2);
    } else {
      candidateHistory.shift();
    }

    while (candidateHistory.length > 0 && candidateHistory[0].role !== 'user') {
      candidateHistory.shift();
    }
  }

  const result: ChatMessage[] = [];
  if (systemMessage) result.push(systemMessage);
  result.push(...candidateHistory);
  result.push(latestMessage);

  const totalEstimatedTokens = result.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

  if (messages.length !== result.length || totalEstimatedTokens > maxTokens) {
    logger.info(
      'ContextWindow',
      `Trimmed ${messages.length - result.length} messages. Retained: ${result.length} msgs (~${totalEstimatedTokens} est. tokens / budget ${maxTokens}).`
    );
  }

  return result;
}