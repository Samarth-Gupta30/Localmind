import React, { useState, useRef, useEffect, useMemo } from 'react';
import { 
  Bot, 
  User, 
  Send, 
  Square, 
  MessageSquare, 
  FileText, 
  Sparkles,
  Zap,
  Quote,
  Loader2,
  Wrench,
  ShieldCheck
} from 'lucide-react';
import { useSSEStream } from './hooks/useSSEStream';
import { TelemetryHUD } from './components/TelemetryHUD';
import { Sidebar } from './components/Sidebar';
import { MarkdownRenderer } from './components/MarkdownRenderer';
import { FileUploadZone } from './components/FileUploadZone';
import { CitationModal } from './components/CitationModal';
import { ActionApprovalModal } from './components/ActionApprovalModal';
import type { ChatSession, ConversationMode, UploadedFile, Citation } from './types/chat';
import { API_BASE } from './config';
import { SettingsModal } from './components/SettingsModal';
import type { UserPreferences,Message } from './types/chat';


const makeTitle = (text: string) =>
  text.slice(0, 26) + (text.length > 26 ? '...' : '');

export default function App() {
  const [input, setInput] = useState('');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [selectedCitation, setSelectedCitation] = useState<Citation | null>(null);
  
  // Multi-Model Selection State
  const [selectedModel, setSelectedModel] = useState<'qwen2.5:1.5b' | 'qwen2.5:3b'>('qwen2.5:1.5b');

// Preferences state
const [preferences, setPreferences] = useState<UserPreferences>({
  temperature: 0.7,
  responseStyle: 'balanced',
  defaultModel: 'qwen2.5:1.5b',
  maxContextTurns: 10,
});

const [savedPreferences, setSavedPreferences] =
  useState<UserPreferences | null>(null);

const [isSettingsOpen, setIsSettingsOpen] = useState(false);
const [isSavingPreferences, setIsSavingPreferences] = useState(false);
const [preferencesError, setPreferencesError] = useState<string | null>(null);

useEffect(() => {
  const loadPreferences = async () => {
    try {
      const response = await fetch(`${API_BASE}/api/preferences`);

      if (!response.ok) {
        throw new Error('Unable to load preferences.');
      }

      const data: UserPreferences = await response.json();

      setPreferences(data);
      setSavedPreferences(data);
      setSelectedModel(data.defaultModel);

    } catch (error) {
      console.error('[Preferences] Load failed:', error);
      setPreferencesError('Could not load saved preferences.');
    }
  };

  loadPreferences();
}, []);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 1. Load Sessions from LocalStorage
  const [storedSessions, setSessions] = useState<ChatSession[]>(() => {
    const saved = localStorage.getItem('offline_ai_sessions');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch (e) {
        console.error('Failed to parse saved sessions:', e);
      }
    }
    const initialSession: ChatSession = {
      id: crypto.randomUUID(),
      title: 'New Conversation',
      mode: 'agent',
      messages: [],
      files: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return [initialSession];
  });

  const [currentSessionId, setCurrentSessionId] = useState<string>(() => {
    const saved = localStorage.getItem('offline_ai_sessions');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed[0]?.id) return parsed[0].id;
      } catch (e) {
        console.warn('Failed to parse saved current session id:', e);
      }
    }
    return storedSessions[0]?.id || '';
  });

  const {
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
  } = useSSEStream();

  const sessions = useMemo(
    () =>
      storedSessions.map((session) => {
        const isActive = session.id === currentSessionId && messages.length > 0;
        const msgs = isActive ? messages : session.messages;

        const firstUserMsg = msgs.find((m) => m.role === 'user');
        const title =
          firstUserMsg && (!session.title || session.title === 'New Conversation')
            ? makeTitle(firstUserMsg.content)
            : session.title;

        return isActive
          ? { ...session, title, messages, updatedAt: new Date().toISOString() }
          : { ...session, title };
      }),
    [storedSessions, currentSessionId, messages]
  );

  const currentSession = sessions.find((s) => s.id === currentSessionId) || sessions[0];

  useEffect(() => {
    const active = sessions.find((s) => s.id === currentSessionId);
    if (active && active.messages.length > 0 && messages.length === 0) {
      setMessages(active.messages);
    }
  }, [currentSessionId, messages.length, sessions, setMessages]);

  useEffect(() => {
    localStorage.setItem('offline_ai_sessions', JSON.stringify(sessions));
  }, [sessions]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleModeChange = (newMode: ConversationMode) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === currentSessionId ? { ...s, mode: newMode } : s))
    );
  };

  const handleSelectSession = (sessionId: string) => {
    if (sessionId === currentSessionId) return;
    stopStreaming();
    setSessions(sessions);
    setCurrentSessionId(sessionId);
    const targetSession = sessions.find((s) => s.id === sessionId);
    setMessages(targetSession ? targetSession.messages : []);
    setInput(targetSession?.lastQuery ?? '');
  };

  const handleNewSession = () => {
    stopStreaming();
    const newSession: ChatSession = {
      id: crypto.randomUUID(),
      title: 'New Conversation',
      mode: currentSession.mode,
      messages: [],
      files: currentSession.files,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setSessions([newSession, ...sessions]);
    setCurrentSessionId(newSession.id);
    clearChat();
    setInput('');
  };

const handleSavePreferences = async () => {
  setIsSavingPreferences(true);
  setPreferencesError(null);

  try {
    const response = await fetch(`${API_BASE}/api/preferences`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(preferences),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Failed to save preferences.');
    }

    const updatedPreferences: UserPreferences = result;

    setPreferences(updatedPreferences);
    setSavedPreferences(updatedPreferences);
    setSelectedModel(updatedPreferences.defaultModel);
    setIsSettingsOpen(false);

  } catch (error) {
    setPreferencesError(
      error instanceof Error ? error.message : 'Something went wrong.'
    );

  } finally {
    setIsSavingPreferences(false);
  }
};

const handleResetPreferences = async () => {
  setIsSavingPreferences(true);
  setPreferencesError(null);

  try {
    const response = await fetch(`${API_BASE}/api/preferences`, {
      method: 'DELETE',
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Failed to reset preferences.');
    }

    const defaults: UserPreferences = result;

    setPreferences(defaults);
    setSavedPreferences(defaults);
    setSelectedModel(defaults.defaultModel);

  } catch (error) {
    setPreferencesError(
      error instanceof Error ? error.message : 'Unable to reset preferences.'
    );

  } finally {
    setIsSavingPreferences(false);
  }
};


  const handleDeleteSession = (sessionId: string) => {
    if (sessionId === currentSessionId) stopStreaming();
    const filtered = sessions.filter((s) => s.id !== sessionId);
    if (filtered.length > 0) {
      setSessions(filtered);
      if (sessionId === currentSessionId) {
        setCurrentSessionId(filtered[0].id);
        setMessages(filtered[0].messages);
      }
    } else {
      handleNewSession();
    }
  };

  


const handleApproveTool = async () => {
  if (!pendingAction) return;

  try {
    const response = await fetch(
      `${API_BASE}/api/chat/agent/tools/execute`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          approvalToken: pendingAction.approvalToken,
        }),
      }
    );

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error || 'Tool execution failed.');
    }

    const data: unknown = await response.json();

    // Validate the backend response before displaying its result.
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid tool execution response.');
    }

    const payload = data as Record<string, unknown>;

    if (
      payload.success !== true ||
      payload.toolName !== pendingAction.toolName ||
      !Object.prototype.hasOwnProperty.call(payload, 'result')
    ) {
      throw new Error('Tool execution response validation failed.');
    }

    const resultJson =
      JSON.stringify(payload.result, null, 2) ?? String(payload.result);

    if (
      !pendingAction.args ||
      typeof pendingAction.args !== 'object' ||
      Array.isArray(pendingAction.args)
    ) {
      throw new Error('Invalid tool arguments.');
    }

    const toolArgs = pendingAction.args as Record<string, unknown>;

    const resultMessage: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: `**Tool executed successfully: ${pendingAction.toolName}**\n\n\`\`\`json\n${resultJson}\n\`\`\``,
      timestamp: new Date().toISOString(),
      toolCall: {
        toolName: pendingAction.toolName,
        args: toolArgs,
        result: payload.result,
        status: 'executed',
      },
    };

    // Display the actual result; do not send it back to the LLM.
    setMessages((prev) => [...prev, resultMessage]);

    setPendingAction(null);

  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : String(err);

    alert(`Tool execution failed: ${message}`);
  }
};


  const handleDenyTool = () => {
    if (!pendingAction) return;
    const toolName = pendingAction.toolName;
    setPendingAction(null);
    const activeFileNames = currentSession.files.map((f) => f.name);

    sendMessage(
      `[SECURITY NOTICE]: The user denied permission to execute '${toolName}'. Acknowledge the denial politely.`,
      'general',
      selectedModel,
      activeFileNames
    );
  };

  const handleFileUpload = async (file: File) => {
    setIsUploading(true);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch(`${API_BASE}/api/documents/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to index file.');
      }

      const result = await response.json();
      const newFile: UploadedFile = {
        id: crypto.randomUUID(),
        name: result.fileName,
        size: result.size,
        type: file.type,
        chunkCount: result.chunkCount,
        uploadedAt: new Date().toISOString(),
      };

      setSessions((prev) =>
        prev.map((s) =>
          s.id === currentSessionId ? { ...s, files: [...s.files, newFile] } : s
        )
      );
    } catch (err: unknown) {
      alert(`File upload failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsUploading(false);
    }
  };

  const handleFileRemove = async (fileId: string) => {
    const fileToRemove = currentSession.files.find((f) => f.id === fileId);
    if (fileToRemove) {
      try {
        const response = await fetch(
          `${API_BASE}/api/documents/${encodeURIComponent(fileToRemove.name)}`,
          { method: 'DELETE' }
        );
        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || `Failed to remove "${fileToRemove.name}" (${response.status})`);
        }
      } catch (error) {
        console.error('Failed to delete uploaded file:', error);
        alert(`Failed to remove "${fileToRemove.name}": ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }

    setSessions((prev) =>
      prev.map((s) =>
        s.id === currentSessionId
          ? { ...s, files: s.files.filter((f) => f.id !== fileId) }
          : s
      )
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;

    const activeFileNames = currentSession.files.map((f) => f.name);
    sendMessage(input, currentSession.mode, selectedModel, activeFileNames);

    setInput('');
    setSessions((prev) =>
      prev.map((s) =>
        s.id === currentSessionId ? { ...s, lastQuery: '' } : s
      )
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const approvalArgs = (pendingAction?.args ?? {}) as Record<string, unknown>;

  return (
    <div className="flex h-screen bg-mesh-glow text-slate-100 font-sans antialiased overflow-hidden">
      
      {/* 1. Left Sidebar */}
      <Sidebar
        sessions={sessions}
        currentSessionId={currentSessionId}
        isOpen={isSidebarOpen}
        selectedModel={selectedModel}
        onSelectModel={setSelectedModel}
        onToggle={() => setIsSidebarOpen(!isSidebarOpen)}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        onDeleteSession={handleDeleteSession}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      {/* 2. Main Workspace */}
      <div className="flex-1 flex flex-col h-screen min-w-0 relative">
        
        {/* Top Header */}
        <header className="flex items-center justify-between px-6 py-3 border-b border-white/10 bg-slate-950/40 backdrop-blur-xl z-10">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 shadow-[0_0_12px_rgba(99,102,241,0.15)]">
              <Bot className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-wide flex items-center gap-2">
                <span className="bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-transparent font-bold">
                  LocalMind 
                </span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">
                  {selectedModel}
                </span>
                {/* <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3 text-emerald-400" />
                  Sandboxed Agent
                </span> */}

          {currentSession.mode === 'agent' && (
  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
    <ShieldCheck className="w-3 h-3 text-emerald-400" />
    Sandboxed Agent
  </span>
)}

              </h1>
              <p className="text-[11px] text-slate-400">Offline AI · Document Intelligence · Local Agents</p>
            </div>
          </div>

          {/* 3-Mode Switcher */}
          <div className="flex items-center bg-slate-950/70 p-1 rounded-xl border border-white/10 backdrop-blur-md">
            <button
              onClick={() => handleModeChange('general')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                currentSession.mode === 'general'
                  ? 'bg-indigo-600/80 text-white shadow-[0_0_10px_rgba(79,70,229,0.4)] border border-indigo-400/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
              }`}
            >
              <MessageSquare className="w-3.5 h-3.5" />
              General
            </button>

            <button
              onClick={() => handleModeChange('document')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                currentSession.mode === 'document'
                  ? 'bg-rose-600/80 text-white shadow-[0_0_10px_rgba(225,29,72,0.4)] border border-rose-400/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              Document RAG
            </button>

            <button
              onClick={() => handleModeChange('agent')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                currentSession.mode === 'agent'
                  ? 'bg-amber-600/80 text-white shadow-[0_0_10px_rgba(217,119,6,0.4)] border border-amber-400/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
              }`}
            >
              <Wrench className="w-3.5 h-3.5" />
              Agent Tools
            </button>
          </div>
        </header>

        {/* Telemetry HUD */}
        <div className="px-6 py-2.5 border-b border-white/5">
          <TelemetryHUD metrics={currentMetrics} isStreaming={isStreaming} />
        </div>

        {/* Messages Stream */}
        <main className="flex-1 overflow-y-auto px-6 py-6 space-y-5">
          
          {currentSession.mode === 'document' && (
            <div className="relative mb-4">
              {isUploading && (
                <div className="absolute inset-0 z-10 bg-slate-950/80 backdrop-blur-md rounded-xl flex items-center justify-center gap-2 text-indigo-400 text-xs font-medium border border-indigo-500/30">
                  <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
                  Generating 768-dim embeddings offline...
                </div>
              )}
              <FileUploadZone
                files={currentSession.files}
                onFileUpload={handleFileUpload}
                onFileRemove={handleFileRemove}
              />
            </div>
          )}

          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center max-w-lg mx-auto space-y-5 py-12">
              <div className="p-4 rounded-2xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 shadow-[0_0_20px_rgba(99,102,241,0.15)]">
                <Sparkles className="w-8 h-8 animate-pulse" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-slate-100 tracking-wide">
                  {currentSession.mode === 'agent'
                    ? 'Autonomous Sandboxed Agent'
                    : currentSession.mode === 'document'
                    ? 'Document Context Assistant'
                    : 'Offline Edge Intelligence'}
                </h2>
                <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                  {currentSession.mode === 'agent'
                    ? 'Equipped with live system tools: Inspect RAM/CPU, list files, and execute math.'
                    : currentSession.mode === 'document'
                    ? 'Query uploaded files with strict citation grounding.'
                    : 'Fast offline reasoning powered by local Qwen LLM.'}
                </p>
              </div>

              <div className="grid grid-cols-1 gap-2.5 w-full pt-2">
                {(currentSession.mode === 'agent'
                  ? [
                      'Check my laptop free RAM and CPU cores right now.',
                      'List the files in the "data" directory.',
                      'Calculate (48000 / 12) * 1.18 safely.'
                    ]
                  : [
                      'Compare QuickSort vs MergeSort with time complexity.',
                      'Explain the CAP theorem in distributed systems.',
                      'Write a thread-safe Singleton pattern in TypeScript.'
                    ]
                ).map((prompt, idx) => (
                  <button
                    key={idx}
                    onClick={() => {
                      const activeFileNames = currentSession.files.map((f) => f.name);
                      sendMessage(prompt, currentSession.mode, selectedModel, activeFileNames);
                    }}
                    className="text-left text-xs p-3.5 rounded-xl glass-panel hover:bg-white/10 text-slate-300 hover:text-white transition-all hover:border-indigo-500/30"
                  >
                    "{prompt}"
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg) => {
              if (
                msg.content.startsWith('[VERIFIED SYSTEM DATA') || 
                msg.content.startsWith('[TOOL RESULT') ||
                msg.content.startsWith('[SECURITY NOTICE')
              ) {
                return null;
              }

              const isToolCall = msg.content.includes('"action": "call_tool"');
              let parsedToolName = 'system_tool';
              if (isToolCall) {
                try {
                  const match = msg.content.match(/\{[\s\S]*"action"\s*:\s*"call_tool"[\s\S]*\}/);
                  if (match) {
                    const parsed = JSON.parse(match[0]);
                    parsedToolName = parsed.toolName;
                  }
                } catch {
                  // Fallback
                }
              }

              return (
                <div
                  key={msg.id}
                  className={`flex gap-3.5 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  {msg.role === 'assistant' && (
                    <div className="w-8 h-8 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 shrink-0 mt-1 shadow-md">
                      <Bot className="w-4 h-4" />
                    </div>
                  )}

                  <div
                    className={`max-w-[85%] rounded-2xl px-5 py-4 text-sm leading-relaxed ${
                      msg.role === 'user'
                        ? 'glow-button-accent text-white rounded-tr-xs'
                        : 'glass-panel text-slate-200 rounded-tl-xs shadow-lg'
                    }`}
                  >
                    {isToolCall ? (
                      <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-slate-950/80 border border-amber-500/30 text-xs font-mono shadow-sm">
                        <div className="flex items-center gap-2 text-amber-400">
                          <Wrench className="w-4 h-4 text-amber-400 animate-pulse" />
                          <span>Tool Invoked: <strong>{parsedToolName}()</strong></span>
                        </div>
                        <span className="text-[10px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full font-bold">
                          Executed ✓
                        </span>
                      </div>
                    ) : msg.role === 'assistant' ? (
                      <MarkdownRenderer content={msg.content} />
                    ) : (
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                    )}

                    {isStreaming && msg.role === 'assistant' && msg.id === messages[messages.length - 1].id && (
                      <span className="inline-block w-1.5 h-4 ml-1 bg-indigo-400 animate-pulse align-middle shadow-[0_0_8px_#6366f1]" />
                    )}

                    {msg.citations && msg.citations.length > 0 && (
                      <div className="mt-3.5 pt-3 border-t border-white/10">
                        <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-semibold mb-2">
                          <Quote className="w-3.5 h-3.5 text-indigo-400" />
                          Verified Grounded Sources:
                        </div>
                                               <div className="flex flex-wrap gap-2">
                          {msg.citations.map((c, i) => (
                            <button
                              key={i}
                              onClick={() => setSelectedCitation(c)}
                              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-950/40 hover:bg-indigo-900/60 border border-indigo-500/30 text-indigo-300 text-xs font-mono transition-all hover:scale-105 active:scale-95"
                              title={`View citation excerpt from ${c.fileName}`}
                            >
                              <FileText className="w-3.5 h-3.5 text-indigo-400" />
                              <span className="truncate max-w-[140px]">{c.fileName}</span>
                              {c.pageNumber != null && (
                                <span className="text-[10px] text-indigo-400/80 font-normal">
                                  p.{c.pageNumber}
                                </span>
                              )}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {msg.metrics && !isToolCall && (
                      <div className="mt-3 pt-2.5 border-t border-white/10 flex items-center gap-3 text-[10px] text-slate-400 font-mono">
                        <span className="flex items-center gap-1 text-cyan-400">
                          <Zap className="w-3 h-3 text-cyan-400" />
                          {msg.metrics.tps} tok/s
                        </span>
                        <span>•</span>
                        <span>TTFT: {msg.metrics.ttftMs}ms</span>
                        <span>•</span>
                        <span>{(msg.metrics.totalDurationMs / 1000).toFixed(2)}s</span>
                      </div>
                    )}
                  </div>

                  {msg.role === 'user' && (
                    <div className="w-8 h-8 rounded-xl bg-slate-800 border border-white/10 flex items-center justify-center text-slate-300 shrink-0 mt-1 shadow-md">
                      <User className="w-4 h-4" />
                    </div>
                  )}
                </div>
              );
            })
          )}

          {error && (
            <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs backdrop-blur-md">
              {error}
            </div>
          )}

          <div ref={messagesEndRef} />
        </main>

        {/* Input Bar */}
        <footer className="p-4 border-t border-white/10 bg-slate-950/50 backdrop-blur-xl">
          <form onSubmit={handleSubmit} className="max-w-4xl mx-auto flex items-end gap-3">
            <div className="relative flex-1">
              <textarea
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setSessions((prev) =>
                    prev.map((s) =>
                      s.id === currentSessionId ? { ...s, lastQuery: e.target.value } : s
                    )
                  );
                }}
                onKeyDown={handleKeyDown}
                placeholder={
                  currentSession.mode === 'agent'
                    ? 'Ask the Agent (e.g. "Check my laptop RAM and CPU stats")...'
                    : currentSession.mode === 'document'
                    ? 'Ask about uploaded documents (Strict citation mode)...'
                    : 'Ask anything offline... (Enter to send, Shift+Enter for newline)'
                }
                rows={1}
                className="w-full resize-none rounded-xl glass-panel px-4 py-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 transition-all max-h-32 shadow-inner"
              />
            </div>

            {isStreaming ? (
              <button
                type="button"
                onClick={stopStreaming}
                className="p-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-white transition-all shadow-[0_0_12px_rgba(225,29,72,0.4)] flex items-center justify-center active:scale-95"
                title="Stop Generating"
              >
                <Square className="w-4 h-4 fill-current" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="p-3 rounded-xl glow-button-accent text-white transition-all flex items-center justify-center active:scale-95 disabled:opacity-40 disabled:shadow-none disabled:cursor-not-allowed"
                title="Send Message"
              >
                <Send className="w-4 h-4" />
              </button>
            )}
          </form>
        </footer>

      </div>

      <CitationModal
        citation={selectedCitation}
        onClose={() => setSelectedCitation(null)}
      />

      <ActionApprovalModal
        isOpen={Boolean(pendingAction)}
        toolName={pendingAction?.toolName || ''}
        args={approvalArgs}
        reason={pendingAction?.reason}
        onApprove={handleApproveTool}
        onDeny={handleDenyTool}
      />

      {isSettingsOpen && (
  <SettingsModal
    preferences={preferences}
    onChange={setPreferences}
    onSave={handleSavePreferences}
    onReset={handleResetPreferences}
    onClose={() => {
      setPreferences(savedPreferences ?? preferences);
      setPreferencesError(null);
      setIsSettingsOpen(false);
    }}
    isSaving={isSavingPreferences}
    error={preferencesError}
  />
)}

    </div>
  );
}
