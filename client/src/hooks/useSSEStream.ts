import { useState, useRef, useCallback, useEffect } from 'react';
import type { Message, TelemetryMetrics, ConversationMode } from '../types/chat';
import { API_BASE } from '../config';
import { createSSEParser } from '../utils/sseParser';

export function useSSEStream() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [currentMetrics, setCurrentMetrics] = useState<TelemetryMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{
    approvalToken?: string;
    toolName: string;
    args: unknown;
    reason?: string;
  } | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);

  // Stop streaming explicitly
  const stopStreaming = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsStreaming(false);
  }, []);

  // Cleanup on unmount so no zombie streams run in the background
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, []);

  const clearChat = useCallback(() => {
    stopStreaming();
    setMessages([]);
    setCurrentMetrics(null);
    setError(null);
    setPendingAction(null);
  }, [stopStreaming]);

  const sendMessage = useCallback(
    async (
      userPrompt: string,
      mode: ConversationMode = 'general',
      model: string = 'qwen2.5:1.5b',
      selectedFiles: string[] = []
    ) => {
      if (!userPrompt.trim() || isStreaming) return;

      setError(null);
      setPendingAction(null);

      // 1. User Message
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: userPrompt.trim(),
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      // 2. Assistant Message Placeholder
      const assistantMessageId = crypto.randomUUID();
      const assistantPlaceholder: Message = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      setMessages((prev) => [...prev, userMessage, assistantPlaceholder]);
      setIsStreaming(true);

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      try {
        let endpoint = `${API_BASE}/api/chat/stream`;

        let payload: Record<string, unknown> = {
          messages: [...messages, userMessage].map((m) => ({ role: m.role, content: m.content })),
          model,
        };

        if (mode === 'document') {
          endpoint = `${API_BASE}/api/chat/rag/stream`;
          payload = {
            query: userPrompt.trim(),
            conversationHistory: messages.map((m) => ({ role: m.role, content: m.content })),
            model,
            selectedFiles, // Metadata Pre-Filtering
          };
        } else if (mode === 'agent') {
          endpoint = `${API_BASE}/api/chat/agent/stream`;
          payload = {
            query: userPrompt.trim(),
            conversationHistory: messages.map((m) => ({ role: m.role, content: m.content })),
            model,
          };
        }

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: mode === 'agent' ? 'include' : 'same-origin',
          body: JSON.stringify(payload),
          signal: abortController.signal,
        });

        if (!response.ok) {
          throw new Error(`Server returned HTTP ${response.status}: ${response.statusText}`);
        }

        if (!response.body) {
          throw new Error('ReadableStream not supported or response body is empty.');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let receivedTerminalEvent = false;

        const parser = createSSEParser({
          onEvent: (data) => {
            if (abortController.signal.aborted) return;

            // 1. Intercept Action Required for Agent Tools Modal
            if (data.type === 'action_required') {
              receivedTerminalEvent = true;
              setPendingAction({
                approvalToken: data.approvalToken as string | undefined,
                toolName: String(data.toolName ?? ''),
                args: data.args,
                reason: data.reason as string | undefined,
              });
              setMessages((prev) => prev.filter((m) => m.id !== assistantMessageId));
              setIsStreaming(false);
              return;
            }

            // 2. Token arrival
            if (data.type === 'token') {
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantMessageId
                    ? { ...msg, content: msg.content + String(data.token ?? '') }
                    : msg
                )
              );
            }

            // 3. Generation completed with telemetry & citations
            if (data.type === 'done') {
              receivedTerminalEvent = true;
              setCurrentMetrics(data.metrics as TelemetryMetrics);
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantMessageId
                    ? {
                        ...msg,
                        metrics: data.metrics as TelemetryMetrics,
                        citations: (data.citations as Message['citations']) || [],
                      }
                    : msg
                )
              );
            }

            // 4. Server-side error event
            if (data.type === 'error') {
              receivedTerminalEvent = true;
              setError(String(data.error ?? 'Stream error'));
            }
          },
          onParseError: (raw, err) => {
            console.error('[useSSEStream] Failed to parse SSE event:', raw, err);
          },
        });

        try {
          while (true) {
            if (abortController.signal.aborted) break;

            const { done, value } = await reader.read();

            if (done) {
              // Flush any remaining multibyte UTF-8 characters from the decoder
              parser.feed(decoder.decode());
              break;
            }

            parser.feed(decoder.decode(value, { stream: true }));
          }

          if (!abortController.signal.aborted) {
            parser.flush();
            if (!receivedTerminalEvent) {
              setError('Stream ended unexpectedly before completion.');
            }
          }
        } finally {
          // Explicitly cancel reader and release lock to guarantee immediate network cleanup
          try {
            await reader.cancel();
          } catch {
            // Already canceled or completed
          }
          try {
            reader.releaseLock();
          } catch {
            // Already released
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          console.log('[useSSEStream] Stream stopped by user.');
        } else {
          console.error('[useSSEStream] Stream error:', err);
          setError(err instanceof Error ? err.message : 'An unexpected error occurred while streaming.');
        }
      } finally {
        if (abortControllerRef.current === abortController) {
          setIsStreaming(false);
          abortControllerRef.current = null;
        }
      }
    },
    [messages, isStreaming]
  );

  return {
    messages,
    setMessages,
    isStreaming,
    currentMetrics,
    error,
    pendingAction,
    setPendingAction,
    sendMessage,
    stopStreaming,
    clearChat,
  };
}