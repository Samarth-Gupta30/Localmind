import React from 'react';
import { Zap, Gauge, Clock, Cpu, Activity, AlertCircle } from 'lucide-react';
import type { TelemetryMetrics } from '../types/chat';

interface TelemetryHUDProps {
  metrics: TelemetryMetrics | null;
  isStreaming: boolean;
  hasError?: boolean;
  isEngineReady?: boolean;
}

export const TelemetryHUD: React.FC<TelemetryHUDProps> = ({
  metrics,
  isStreaming,
  hasError = false,
  isEngineReady,
}) => {
  const statusDotClass = isStreaming
    ? 'bg-emerald-500'
    : hasError || isEngineReady === false
      ? 'bg-rose-500'
      : isEngineReady === true
        ? 'bg-emerald-500'
        : 'bg-slate-600';

  const idleLabel =
    isEngineReady === true
      ? 'Ready'
      : isEngineReady === false
        ? 'Unavailable'
        : 'Idle';

  return (
    <div className="glass-panel rounded-xl p-2.5 shadow-md">
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">

        {/* Live Status Indicator */}
        <div className="flex items-center gap-2 pr-3 border-r border-white/10">
          <div className="relative flex h-2.5 w-2.5">
            {isStreaming && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            )}
            <span
              className={`relative inline-flex rounded-full h-2.5 w-2.5 ${statusDotClass}`}
            ></span>
          </div>
          <span className="font-medium text-slate-300">
            {isStreaming ? (
              <span className="text-emerald-400 font-semibold flex items-center gap-1">
                <Activity className="w-3.5 h-3.5 animate-pulse" />
                Generating...
              </span>
            ) : hasError ? (
              <span className="text-rose-400 font-semibold flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" />
                Stream Error
              </span>
            ) : (
              idleLabel
            )}
          </span>
        </div>

        {/* Metrics Grid */}
        <div className="flex flex-wrap items-center gap-4 text-slate-400">

          {/* TTFT Metric */}
          <div className="flex items-center gap-1.5" title="Time to First Token (Perceived Latency)">
            <Zap className="w-3.5 h-3.5 text-amber-400" />
            <span>TTFT:</span>
            <span className="font-mono font-semibold text-slate-200">
              {metrics ? `${metrics.ttftMs}ms` : '--'}
            </span>
          </div>

          {/* TPS Metric */}
          <div className="flex items-center gap-1.5" title="Tokens Generated Per Second">
            <Gauge className="w-3.5 h-3.5 text-cyan-400" />
            <span>Throughput:</span>
            <span className="font-mono font-semibold text-cyan-300">
              {metrics ? `${metrics.tps} tok/s` : '--'}
            </span>
          </div>

          {/* Total Duration */}
          <div className="flex items-center gap-1.5" title="Total Roundtrip Duration">
            <Clock className="w-3.5 h-3.5 text-indigo-400" />
            <span>Duration:</span>
            <span className="font-mono font-semibold text-slate-200">
              {metrics ? `${(metrics.totalDurationMs / 1000).toFixed(2)}s` : '--'}
            </span>
          </div>

          {/* Total Tokens */}
          <div className="flex items-center gap-1.5" title="Total Tokens in Response">
            <Cpu className="w-3.5 h-3.5 text-purple-400" />
            <span>Tokens:</span>
            <span className="font-mono font-semibold text-slate-200">
              {metrics ? metrics.totalTokens : '--'}
            </span>
          </div>

        </div>

      </div>
    </div>
  );
};