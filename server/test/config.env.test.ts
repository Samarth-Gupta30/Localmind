import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, validateEnvConfig } from '../src/config/env';

test('validateEnvConfig flags invalid PORT and malformed OLLAMA_BASE_URL without throwing', () => {
  const warnings = validateEnvConfig({
    PORT: '99999',
    OLLAMA_BASE_URL: 'not-a-valid-url',
    RAG_MIN_SCORE: '-1',
    EMBEDDING_TIMEOUT_MS: '0',
  });
  assert.equal(warnings.length, 4);
});

test('env exposes valid default values', () => {
  assert.ok(env.port > 0);
  assert.ok(env.ollamaBaseUrl.startsWith('http'));
  assert.ok(env.embeddingTimeoutMs > 0);
  assert.ok(env.ragMinScore >= 0);
});