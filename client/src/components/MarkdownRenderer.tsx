import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownRendererProps {
  content: string;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content }) => {
  return (
    <div className="prose prose-invert max-w-none text-sm leading-relaxed space-y-3">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Headings (Bold, Underlined, Colored Accents)
          h1: ({ children }) => (
            <h1 className="text-xl font-bold text-white tracking-tight border-b border-indigo-500/40 pb-1.5 mt-4 mb-2 flex items-center gap-2">
              <span className="text-indigo-400">#</span> {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-base font-bold text-indigo-300 tracking-tight border-b border-slate-800 pb-1 mt-3 mb-2 flex items-center gap-1.5">
              <span className="text-indigo-400">##</span> {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-sm font-semibold text-slate-100 underline decoration-indigo-500/60 underline-offset-4 mt-2.5 mb-1.5">
              {children}
            </h3>
          ),

          // Paragraphs & Emphasis
          p: ({ children }) => <p className="text-slate-200 my-1.5">{children}</p>,
          strong: ({ children }) => (
            <strong className="font-bold text-white bg-indigo-500/10 px-1 py-0.5 rounded border border-indigo-500/20">
              {children}
            </strong>
          ),
          em: ({ children }) => <em className="italic text-indigo-200">{children}</em>,

          // Lists (Custom Colored Bullets and Indentation)
          ul: ({ children }) => (
            <ul className="list-disc pl-5 my-2 space-y-1.5 text-slate-300 marker:text-indigo-400">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-5 my-2 space-y-1.5 text-slate-300 marker:text-cyan-400 font-medium">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="pl-1 leading-normal">{children}</li>,

          // Blockquotes
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-indigo-500 bg-slate-900/60 pl-3 py-1.5 my-2 rounded-r-lg text-slate-300 italic">
              {children}
            </blockquote>
          ),

          // Code blocks & Inline code
          code: ({ inline, className, children, ...props }: React.HTMLAttributes<HTMLElement> & {
            inline?: boolean;
            className?: string;
            children?: React.ReactNode;
          }) => {
            if (inline) {
              return (
                <code
                  className={['font-mono text-xs bg-slate-800 text-indigo-300 px-1.5 py-0.5 rounded border border-slate-700/80', className].filter(Boolean).join(' ')}
                  {...props}
                >
                  {children}
                </code>
              );
            }

            const language = className?.replace('language-', '') || 'Code snippet';

            return (
              <div className="relative my-3 rounded-xl overflow-hidden border border-slate-800 bg-slate-950/90 shadow-inner">
                <div className="bg-slate-900/80 px-4 py-1.5 border-b border-slate-800/80 text-[11px] font-mono text-slate-400 flex items-center justify-between">
                  <span>{language}</span>
                </div>
                <pre className="p-4 overflow-x-auto font-mono text-xs text-slate-200 leading-relaxed">
                  <code className={className}>{children}</code>
                </pre>
              </div>
            );
          },

          // Tables
          table: ({ children }) => (
            <div className="overflow-x-auto my-3 rounded-lg border border-slate-800">
              <table className="min-w-full divide-y divide-slate-800 text-xs text-left">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-slate-900/80 text-slate-300 font-semibold">{children}</thead>,
          tbody: ({ children }) => <tbody className="divide-y divide-slate-800/60">{children}</tbody>,
          tr: ({ children }) => <tr className="hover:bg-slate-900/40 transition-colors">{children}</tr>,
          th: ({ children }) => <th className="px-3 py-2 font-medium">{children}</th>,
          td: ({ children }) => <td className="px-3 py-2 text-slate-300">{children}</td>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};