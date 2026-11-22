import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PreferenceStore } from '../src/services/preference.service';
import { OllamaService, matchesOllamaModel } from '../src/services/ollama.service';
import { VectorStoreService } from '../src/services/vectorStore.service';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localmind-life-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('PreferenceStore checkHealth reports ok while open and false after close', () => {
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    const store = new PreferenceStore();
    assert.equal(store.checkHealth().ok, true);
    store.close();
    assert.equal(store.checkHealth().ok, false);
  } finally {
    process.chdir(origCwd);
  }
});

test('matchesOllamaModel enforces exact tags and handles :latest aliases', () => {
  assert.equal(matchesOllamaModel('qwen2.5:1.5b', 'qwen2.5:1.5b'), true);
  assert.equal(matchesOllamaModel('qwen2.5:3b', 'qwen2.5:1.5b'), false);
  assert.equal(matchesOllamaModel('nomic-embed-text:latest', 'nomic-embed-text'), true);
  assert.equal(matchesOllamaModel('nomic-embed-text', 'nomic-embed-text:latest'), true);
  assert.equal(matchesOllamaModel('other-model:latest', 'nomic-embed-text'), false);
});

test('OllamaService checkHealth distinguishes reachable vs unreachable daemon', async () => {
  const svc = new OllamaService();
  const origFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          models: [{ name: 'qwen2.5:1.5b' }, { name: 'nomic-embed-text' }],
        }),
        { status: 200 }
      )) as any;
    const up = await svc.checkHealth(1000);
    assert.equal(up.ok, true);
    assert.equal(up.daemonReachable, true);
    assert.equal(up.modelCount, 2);

    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as any;
    const down = await svc.checkHealth(1000);
    assert.equal(down.ok, false);
    assert.equal(down.daemonReachable, false);
    assert.match(down.error ?? '', /ECONNREFUSED/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('VectorStoreService checkHealth and close lifecycle', async () => {
  const vs = new VectorStoreService(path.join(tmpDir, 'lancedb'));
  assert.equal((await vs.checkHealth()).ok, true);
  await vs.close();
  assert.equal((await vs.checkHealth()).ok, false);
});

test('OllamaService checkHealth rejects wrong model size and reports missing embedding model', async () => {
  const svc = new OllamaService();
  const origFetch = globalThis.fetch;

  try {
    // Only 3b chat model installed, missing 1.5b and nomic-embed-text
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ models: [{ name: 'qwen2.5:3b' }] }), { status: 200 })) as any;
    const res = await svc.checkHealth(1000);
    assert.equal(res.daemonReachable, true);
    assert.equal(res.hasDefaultModel, false);
    assert.equal(res.hasEmbeddingModel, false);
    assert.equal(res.ok, false);
    assert.ok(Array.isArray(res.missingModels) && res.missingModels.length >= 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});