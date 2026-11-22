
export type ChunkContentType =
  | 'paragraph'
  | 'table'
  | 'question-answer'
  | 'list'
  | 'definition';

export interface TelemetryMetrics {
  ttftMs: number;
  totalDurationMs: number;
  totalTokens: number;
  tps: number;
}

// Alias retained for compatibility with existing code using MetricData.
export type MetricData = TelemetryMetrics;

export interface Citation {
  fileName: string;
  pageNumber?: number;
  endPageNumber?: number;
  chunkIndex?: number;
  /** Non-probabilistic retrieval ranking score (not answer confidence). */
  retrievalScore?: number;
  /** @deprecated Alias for retrievalScore kept for backward compatibility. */
  score?: number;
  snippet: string;
  sectionTitle?: string;
  contentType?: ChunkContentType;
}

export interface UploadedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  chunkCount?: number;
  uploadedAt: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  metrics?: TelemetryMetrics;
  citations?: Citation[];
  toolCall?: {
    toolName: string;
    args: Record<string, unknown>;
    result?: unknown;
    status: 'pending' | 'approved' | 'denied' | 'executed';
  };
}

// Alias retained for compatibility with existing code using ChatMessage.
export type ChatMessage = Message;

export type ConversationMode = 'general' | 'document' | 'agent';

export interface ChatSession {
  id: string;
  title: string;
  mode: ConversationMode;
  messages: Message[];
  files: UploadedFile[];
  lastQuery?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PendingToolCall {
  toolName: string;
  args: Record<string, unknown>;
  reason?: string;
  messageId: string;
}

export interface UserPreferences {
  temperature: number;
  responseStyle: 'concise' | 'balanced' | 'detailed';
  defaultModel: 'qwen2.5:1.5b' | 'qwen2.5:3b';
  maxContextTurns: number;
}