import React from 'react';
import { X, FileText, BookOpen } from 'lucide-react';
import type { Citation } from '../types/chat';

interface CitationModalProps {
  citation: Citation | null;
  onClose: () => void;
}

export const CitationModal: React.FC<CitationModalProps> = ({
  citation,
  onClose,
}) => {
  if (!citation) return null;

  const pageDisplay =
    citation.endPageNumber != null &&
    citation.pageNumber != null &&
    citation.endPageNumber !== citation.pageNumber
      ? `Pages ${citation.pageNumber} – ${citation.endPageNumber}`
      : citation.pageNumber != null
        ? `Page ${citation.pageNumber}`
        : 'Page unavailable';

  const retrievalScore = citation.retrievalScore ?? citation.score;

  const getContentTypeBadge = (type?: string) => {
    switch (type) {
      case 'table':
        return (
          <span className="px-2 py-0.5 text-xs font-semibold rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">
            📊 Table
          </span>
        );
      case 'question-answer':
        return (
          <span className="px-2 py-0.5 text-xs font-semibold rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
            ❓ Q&A Block
          </span>
        );
      case 'list':
        return (
          <span className="px-2 py-0.5 text-xs font-semibold rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
            📝 List
          </span>
        );
      case 'definition':
        return (
          <span className="px-2 py-0.5 text-xs font-semibold rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
            📖 Glossary Term
          </span>
        );
      case 'paragraph':
      default:
        return (
          <span className="px-2 py-0.5 text-xs font-semibold rounded bg-blue-500/20 text-blue-300 border border-blue-500/30">
            📄 Text Paragraph
          </span>
        );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-5 shadow-2xl space-y-4 max-h-[85vh] overflow-y-auto">

        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2 min-w-0">
            <div className="p-2 rounded-xl bg-indigo-500/20 text-indigo-400 flex-shrink-0">
              <FileText className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3
                className="text-sm font-semibold text-white truncate max-w-[280px]"
                title={citation.fileName}
              >
                {citation.fileName}
              </h3>
              <p className="text-[11px] text-slate-400">
                Retrieved Document Excerpt
              </p>

              {/* Page range and chunk metadata */}
              <p className="text-[11px] text-slate-500 mt-1">
                {pageDisplay}
                {citation.chunkIndex != null && (
                  <> · Chunk #{citation.chunkIndex}</>
                )}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            aria-label="Close citation modal"
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Source Location & Content Type */}
        <div className="flex items-center justify-between gap-2 p-3 rounded-xl bg-slate-950 border border-slate-800/80 text-xs">
          <span className="text-slate-300 flex items-center gap-2 font-medium">
            <BookOpen className="w-4 h-4 text-indigo-400 flex-shrink-0" />
            Source Location
          </span>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] font-semibold px-2 py-0.5 rounded text-slate-200 bg-slate-800 border border-slate-700">
              {pageDisplay}
            </span>
            {getContentTypeBadge(citation.contentType)}
          </div>
        </div>

        {/* Optional Retrieval Score (plain ranking score, never a confidence %) */}
        {typeof retrievalScore === 'number' && Number.isFinite(retrievalScore) && (
          <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-slate-950/60 border border-slate-800/60 text-xs">
            <span className="text-slate-400">Retrieval Score (ranking only)</span>
            <span className="font-mono text-[11px] text-slate-300">
              {retrievalScore.toFixed(4)}
            </span>
          </div>
        )}

        {/* Section Title */}
        {citation.sectionTitle && (
          <div className="p-3 rounded-xl bg-indigo-500/10 border border-indigo-500/20">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-indigo-400 mb-1">
              📍 Section
            </p>
            <p className="text-xs text-indigo-200 leading-relaxed">
              {citation.sectionTitle}
            </p>
          </div>
        )}

        {/* Excerpt from Document */}
        <div className="space-y-1.5">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Retrieved Excerpt Snippet
          </label>

          <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-300 font-mono leading-relaxed max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
            {citation.snippet}
          </div>
        </div>

        {/* Footer */}
        <div className="pt-2 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-semibold transition-all"
          >
            Close Inspector
          </button>
        </div>
      </div>
    </div>
  );
};