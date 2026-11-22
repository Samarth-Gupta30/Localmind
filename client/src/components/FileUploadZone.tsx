import React, { useRef } from 'react';
import { Upload, FileText, X, CheckCircle2, HardDrive } from 'lucide-react';
import  type { UploadedFile } from '../types/chat';

interface FileUploadZoneProps {
  files: UploadedFile[];
  onFileUpload: (file: File) => void;
  onFileRemove: (fileId: string) => void;
}

export const FileUploadZone: React.FC<FileUploadZoneProps> = ({
  files,
  onFileUpload,
  onFileRemove,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      onFileUpload(selectedFile);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="bg-slate-900/80 border border-indigo-500/30 rounded-xl p-3.5 mb-4 shadow-lg backdrop-blur-md">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-indigo-500/20 text-indigo-400">
            <HardDrive className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-xs font-semibold text-slate-200">Local Knowledge Base</h3>
            <p className="text-[11px] text-slate-400">Upload documents to query offline with exact citations</p>
          </div>
        </div>

        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept=".pdf,.txt,.md"
          className="hidden"
        />

        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium transition-all shadow-md active:scale-95"
        >
          <Upload className="w-3.5 h-3.5" />
          Upload Document
        </button>
      </div>

      {/* File Chips */}
      {files.length === 0 ? (
        <div className="border border-dashed border-slate-800 rounded-lg p-4 text-center">
          <p className="text-xs text-slate-500">
            No documents loaded. Supports <span className="text-indigo-400 font-mono">.pdf</span>,{' '}
            <span className="text-indigo-400 font-mono">.txt</span>,{' '}
            <span className="text-indigo-400 font-mono">.md</span> (Processed 100% locally on your laptop).
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {files.map((file) => (
            <div
              key={file.id}
              className="flex items-center gap-2 px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 group hover:border-slate-700 transition-colors"
            >
              <FileText className="w-3.5 h-3.5 text-indigo-400" />
              <span className="font-medium truncate max-w-[160px]">{file.name}</span>
              <span className="text-[10px] text-slate-500 font-mono">({formatFileSize(file.size)})</span>
              <span className="flex items-center gap-0.5 text-[10px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded font-mono">
                <CheckCircle2 className="w-3 h-3" />
                Indexed
              </span>
              <button
                onClick={() => onFileRemove(file.id)}
                className="text-slate-500 hover:text-rose-400 transition-colors ml-1"
                title="Remove document"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};






                