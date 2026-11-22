import React from 'react';
import {
  Plus,
  MessageSquare,
  FileText,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Zap,
  Brain,
  Settings,
} from 'lucide-react';
import type { ChatSession } from '../types/chat';

interface SidebarProps {
  sessions: ChatSession[];
  currentSessionId: string;
  isOpen: boolean;
  selectedModel: 'qwen2.5:1.5b' | 'qwen2.5:3b';
  onSelectModel: (model: 'qwen2.5:1.5b' | 'qwen2.5:3b') => void;
  onToggle: () => void;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onDeleteSession: (sessionId: string) => void;
  onOpenSettings?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  sessions,
  currentSessionId,
  isOpen,
  selectedModel,
  onSelectModel,
  onToggle,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onOpenSettings,
}) => {
  return (
    <aside
      className={`h-screen bg-slate-950/70 backdrop-blur-2xl border-r border-white/10 flex flex-col transition-all duration-300 z-20 ${
        isOpen ? 'w-64' : 'w-16'
      }`}
    >
      {/* 1. Header & New Chat Button */}
      <div className="p-3.5 border-b border-white/10 flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          {isOpen && (
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
              Conversations
            </span>
          )}
          <button
            onClick={onToggle}
            className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-400 hover:text-slate-200 transition-colors ml-auto border border-white/5"
            title={isOpen ? 'Collapse Sidebar' : 'Expand Sidebar'}
          >
            {isOpen ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        </div>

        <button
          onClick={onNewSession}
          className={`flex items-center justify-center gap-2 py-2.5 px-3 glow-button-accent text-white rounded-xl text-xs font-semibold transition-all active:scale-95 ${
            isOpen ? 'w-full' : 'w-10 h-10 self-center p-0'
          }`}
          title="New Chat"
        >
          <Plus className="w-4 h-4" />
          {isOpen && <span>New Conversation</span>}
        </button>
      </div>

      {/* 2. Scrollable Sessions List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {sessions.map((session) => {
          const isActive = session.id === currentSessionId;
          return (
            <div
              key={session.id}
              onClick={() => onSelectSession(session.id)}
              className={`group flex items-center justify-between p-2.5 rounded-xl cursor-pointer text-xs transition-all ${
                isActive
                  ? 'glass-panel-active text-white font-medium shadow-sm'
                  : 'text-slate-400 hover:bg-white/5 hover:text-slate-200 border border-transparent'
              }`}
              title={session.title}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                {session.mode === 'document' ? (
                  <FileText className={`w-4 h-4 shrink-0 ${isActive ? 'text-indigo-400' : 'text-slate-500'}`} />
                ) : (
                  <MessageSquare className={`w-4 h-4 shrink-0 ${isActive ? 'text-indigo-400' : 'text-slate-500'}`} />
                )}
                {isOpen && <span className="truncate">{session.title || 'Untitled Chat'}</span>}
              </div>

              {isOpen && sessions.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteSession(session.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 p-1 text-slate-500 hover:text-rose-400 rounded transition-opacity"
                  title="Delete chat"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* 3. Model Selector Toggle */}
      <div className="p-2.5 border-t border-white/10 bg-slate-950/50">
        {isOpen ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 px-1">
              Inference Model
            </span>
            <div className="grid grid-cols-2 gap-1 bg-slate-900/80 p-1 rounded-xl border border-white/10">
              <button
                type="button"
                onClick={() => onSelectModel('qwen2.5:1.5b')}
                className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-semibold transition-all ${
                  selectedModel === 'qwen2.5:1.5b'
                    ? 'bg-indigo-600/80 text-white shadow-sm border border-indigo-400/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
                }`}
                title="Fast 1.5B Model (Sub-second TTFT)"
              >
                <Zap className="w-3 h-3 text-amber-400" />
                <span>1.5B Fast</span>
              </button>
              <button
                type="button"
                onClick={() => onSelectModel('qwen2.5:3b')}
                className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-semibold transition-all ${
                  selectedModel === 'qwen2.5:3b'
                    ? 'bg-purple-600/80 text-white shadow-sm border border-purple-400/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
                }`}
                title="Deep 3B Model (Higher Accuracy & Reasoning)"
              >
                <Brain className="w-3 h-3 text-purple-300" />
                <span>3B Deep</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1 items-center">
            <button
              onClick={() => onSelectModel('qwen2.5:1.5b')}
              className={`p-2 rounded-lg text-xs transition-colors ${
                selectedModel === 'qwen2.5:1.5b' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:bg-white/5'
              }`}
              title="Switch to 1.5B Fast Model"
            >
              <Zap className="w-4 h-4 text-amber-400" />
            </button>
            <button
              onClick={() => onSelectModel('qwen2.5:3b')}
              className={`p-2 rounded-lg text-xs transition-colors ${
                selectedModel === 'qwen2.5:3b' ? 'bg-purple-600 text-white' : 'text-slate-500 hover:bg-white/5'
              }`}
              title="Switch to 3B Deep Model"
            >
              <Brain className="w-4 h-4 text-purple-300" />
            </button>
          </div>
        )}
      </div>
      {/* Settings Button */}
      <div className="px-3 py-2 border-t border-white/10">
        <button
          type="button"
          onClick={onOpenSettings}
          className={`flex items-center gap-2.5 w-full p-2.5 rounded-xl text-xs text-slate-400 hover:text-white hover:bg-white/5 transition-colors ${
            !isOpen ? 'justify-center' : ''
          }`}
          title="Settings"
        >
          <Settings className="w-4 h-4" />
          {isOpen && <span>Settings</span>}
        </button>
      </div>
    </aside>
  );
};


                   