
import React from 'react';
import {
  X,
  Settings2,
  RotateCcw,
  Save,
  Thermometer,
  Brain,
  MessageSquare,
  History,
  Loader2,
  Cpu,
  Sparkles,
} from 'lucide-react';

import type { UserPreferences } from '../types/chat';

interface SettingsModalProps {
  preferences: UserPreferences;
  onChange: (updated: UserPreferences) => void;
  onSave: () => void;
  onReset: () => void;
  onClose: () => void;
  isSaving: boolean;
  error: string | null;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  preferences,
  onChange,
  onSave,
  onReset,
  onClose,
  isSaving,
  error,
}) => {
  const updateField = <K extends keyof UserPreferences>(
    key: K,
    value: UserPreferences[K]
  ) => {
    onChange({
      ...preferences,
      [key]: value,
    });
  };

  return (
    <div
      className="settings-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !isSaving) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="settings-panel"
      >
        {/* Top accent line */}
        <div className="settings-accent-line" />

        {/* Header */}
        <div className="settings-header">
          <div className="flex items-center gap-3">
            <div className="settings-header-icon">
              <Settings2 size={19} />
            </div>

            <div>
              <div className="flex items-center gap-2">
                <h2 id="settings-title" className="settings-title">
                  Preferences
                </h2>
                <span className="settings-version">LOCAL CONFIG</span>
              </div>

              <p className="settings-subtitle">
                Configure your local inference environment
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="settings-close"
            aria-label="Close settings"
          >
            <X size={17} />
          </button>
        </div>

        {/* Body */}
        <div className="settings-body">

          {/* Temperature */}
          <section className="settings-section">
            <div className="settings-section-heading">
              <div className="settings-label-group">
                <div className="settings-icon settings-icon-red">
                  <Thermometer size={16} />
                </div>

                <div>
                  <h3>Temperature</h3>
                  <p>Control response randomness</p>
                </div>
              </div>

              <span className="settings-value settings-value-blue">
                {preferences.temperature.toFixed(1)}
              </span>
            </div>

            <div className="settings-slider-container">
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={preferences.temperature}
                onChange={(e) =>
                  updateField('temperature', Number(e.target.value))
                }
                disabled={isSaving}
                className="settings-slider temperature-slider"
                style={{
                  '--slider-progress': `${preferences.temperature * 100}%`,
                } as React.CSSProperties}
              />

              <div className="settings-slider-labels">
                <span>PRECISE</span>
                <span>CREATIVE</span>
              </div>
            </div>
          </section>

          {/* Response Style */}
          <section className="settings-section">
            <div className="settings-section-heading">
              <div className="settings-label-group">
                <div className="settings-icon settings-icon-blue">
                  <MessageSquare size={16} />
                </div>

                <div>
                  <h3>Response Style</h3>
                  <p>Choose how LocalMind communicates</p>
                </div>
              </div>

              <Sparkles size={15} className="text-slate-600" />
            </div>

            <div className="settings-segment-group">
              {(['concise', 'balanced', 'detailed'] as const).map(
                (style) => (
                  <button
                    key={style}
                    type="button"
                    disabled={isSaving}
                    onClick={() => updateField('responseStyle', style)}
                    className={`settings-segment ${
                      preferences.responseStyle === style
                        ? 'settings-segment-active'
                        : ''
                    }`}
                  >
                    <span>{style}</span>

                    {preferences.responseStyle === style && (
                      <span className="settings-active-dot" />
                    )}
                  </button>
                )
              )}
            </div>
          </section>

          {/* Default Model */}
          <section className="settings-section">
            <div className="settings-section-heading">
              <div className="settings-label-group">
                <div className="settings-icon settings-icon-purple">
                  <Brain size={16} />
                </div>

                <div>
                  <h3>Default AI Model</h3>
                  <p>Select your preferred inference model</p>
                </div>
              </div>
            </div>

            <div className="settings-model-wrapper">
              <Cpu size={16} className="settings-model-icon" />

              <select
                value={preferences.defaultModel}
                onChange={(e) =>
                  updateField(
                    'defaultModel',
                    e.target.value as UserPreferences['defaultModel']
                  )
                }
                disabled={isSaving}
                className="settings-model-select"
              >
                <option value="qwen2.5:1.5b">
                  Qwen 2.5 · 1.5B Fast
                </option>

                <option value="qwen2.5:3b">
                  Qwen 2.5 · 3B Deep
                </option>
              </select>

              <span className="settings-model-indicator">
                {preferences.defaultModel === 'qwen2.5:1.5b'
                  ? 'FAST'
                  : 'DEEP'}
              </span>
            </div>
          </section>

          {/* Conversation Memory */}
          <section className="settings-section settings-section-last">
            <div className="settings-section-heading">
              <div className="settings-label-group">
                <div className="settings-icon settings-icon-red">
                  <History size={16} />
                </div>

                <div>
                  <h3>Conversation Memory</h3>
                  <p>Maximum previous turns to retain</p>
                </div>
              </div>

              <span className="settings-value settings-value-red">
                {preferences.maxContextTurns} <small>TURNS</small>
              </span>
            </div>

            <div className="settings-slider-container">
              <input
                type="range"
                min="1"
                max="20"
                step="1"
                value={preferences.maxContextTurns}
                onChange={(e) =>
                  updateField('maxContextTurns', Number(e.target.value))
                }
                disabled={isSaving}
                className="settings-slider memory-slider"
                style={{
                  '--slider-progress': `${
                    ((preferences.maxContextTurns - 1) / 19) * 100
                  }%`,
                } as React.CSSProperties}
              />

              <div className="settings-slider-labels">
                <span>LESS CONTEXT</span>
                <span>MORE CONTEXT</span>
              </div>
            </div>
          </section>

          {/* Error */}
          {error && (
            <div className="settings-error" role="alert">
              <span className="settings-error-dot" />
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="settings-footer">
          <button
            type="button"
            onClick={onReset}
            disabled={isSaving}
            className="settings-reset-button"
          >
            <RotateCcw size={14} />
            <span>Reset defaults</span>
          </button>

          <button
            type="button"
            onClick={onSave}
            disabled={isSaving}
            className="settings-save-button"
          >
            {isSaving ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Save size={15} />
            )}

            <span>
              {isSaving ? 'Saving...' : 'Save Preferences'}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};
