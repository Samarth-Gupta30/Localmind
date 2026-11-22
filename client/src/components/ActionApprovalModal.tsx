import React from 'react';
import { ShieldAlert, Check, X, Terminal, Cpu, Folder, Calculator } from 'lucide-react';

interface ActionApprovalModalProps {
  isOpen: boolean;
  toolName: string;
  args: Record<string, unknown>;
  reason?: string;
  onApprove: () => void;
  onDeny: () => void;
}

export const ActionApprovalModal: React.FC<ActionApprovalModalProps> = ({
  isOpen,
  toolName,
  args,
  reason,
  onApprove,
  onDeny,
}) => {
  if (!isOpen) return null;

  const getToolIcon = () => {
    switch (toolName) {
      case 'get_system_specs':
        return <Cpu className="w-5 h-5 text-amber-400" />;
      case 'list_directory_safe':
        return <Folder className="w-5 h-5 text-indigo-400" />;
      case 'calculate_math':
        return <Calculator className="w-5 h-5 text-cyan-400" />;
      default:
        return <Terminal className="w-5 h-5 text-slate-400" />;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-fade-in">
      <div className="bg-slate-900 border border-amber-500/40 rounded-2xl max-w-md w-full p-5 shadow-2xl space-y-4">

        {/* Header with Approval Badge */}
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400 shrink-0">
            <ShieldAlert className="w-6 h-6 animate-pulse" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
              Action Approval Required
              <span className="text-[10px] font-mono bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded-full border border-amber-500/30">
                Approval Gate
              </span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              The AI Assistant is requesting permission to execute a local tool.
            </p>
          </div>
        </div>

        {/* Tool Call Card */}
        <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-2.5">
          <div className="flex items-center justify-between text-xs pb-2 border-b border-slate-800">
            <span className="text-slate-400">Target Tool:</span>
            <div className="flex items-center gap-1.5 font-mono font-semibold text-slate-200">
              {getToolIcon()}
              <span>{toolName}()</span>
            </div>
          </div>

          {reason && (
            <div className="text-xs text-slate-300">
              <span className="text-slate-500 block text-[11px] uppercase tracking-wider font-semibold">Purpose:</span>
              <span>{reason}</span>
            </div>
          )}

          {/* Parameters Preview */}
          <div>
            <span className="text-slate-500 block text-[11px] uppercase tracking-wider font-semibold mb-1">
              Parameters:
            </span>
            <pre className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 text-[11px] font-mono text-cyan-300 overflow-x-auto">
              {Object.keys(args).length === 0 ? '// No external arguments required' : JSON.stringify(args, null, 2)}
            </pre>
          </div>
        </div>

        {/* Safety Disclaimer */}
        <p className="text-[11px] text-slate-500 leading-normal">
          Requires explicit approval. Directory listing enforces application-level path traversal and symlink checks within the project root (not an OS-level sandbox).
        </p>

        {/* Buttons */}
        <div className="flex items-center justify-end gap-2.5 pt-2">
          <button
            onClick={onDeny}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-semibold transition-all active:scale-95"
          >
            <X className="w-3.5 h-3.5" />
            Deny
          </button>

          <button
            onClick={onApprove}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-lg shadow-emerald-950 transition-all active:scale-95"
          >
            <Check className="w-3.5 h-3.5" />
            Approve & Execute
          </button>
        </div>

      </div>
    </div>
  );
};