import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveOfflineTrainedDataDir } from '../src/services/chunking.service';
import { RerankerService, extractScores } from '../src/services/reranker.service';

const chunk = (text: string, score = 0.1): any => ({ chunk: { text }, score });
const tensor = (data: number[], dims: number[]) => ({ logits: { data: Float32Array.from(data), dims } });

// Fake runtime: tokenizer records what it was given, model returns the supplied tensor.
const fakeRuntime = (out: any, seen: any[] = []) => ({
  tokenizer: (q: string[], opts: any) => { seen.push({ q, opts }); return {}; },
  model: async () => out,
});

test('extractScores accepts valid [N,1] output', () => {
  assert.deepEqual(extractScores(tensor([1.5, -2], [2, 1]), 2), [1.5, -2]);
});
test('extractScores rejects wrong shape, wrong length, NaN, Infinity, missing tensor', () => {
  assert.throws(() => extractScores(tensor([1, 2, 3], [3, 1]), 2));
  assert.throws(() => extractScores(tensor([1, 2], [1, 2]), 2));
  assert.throws(() => extractScores(tensor([1, NaN], [2, 1]), 2));
  assert.throws(() => extractScores(tensor([1, Infinity], [2, 1]), 2));
  assert.throws(() => extractScores({}, 2));
});

test('sorts by rerankScore, keeps original retrieval score untouched', async () => {
  const svc = new RerankerService(async () => fakeRuntime(tensor([-1, 4, 2], [3, 1])));
  const res = await svc.rerank('q', [chunk('a', 0.9), chunk('b', 0.5), chunk('c', 0.1)], 2);
  assert.deepEqual(res.map((r) => r.chunk.text), ['b', 'c']);
  assert.equal(res[0].score, 0.5);
  assert.equal(res[0].rerankScore, 4);
});

test('empty documents are not sent to the model; all-empty falls back', async () => {
  const seen: any[] = [];
  const svc = new RerankerService(async () => fakeRuntime(tensor([3], [1, 1]), seen));
  const res = await svc.rerank('q', [chunk(''), chunk('   '), chunk('real')], 3);
  assert.deepEqual(seen[0].opts.text_pair, ['real']);
  assert.equal(res.length, 1);
  const fb = await svc.rerank('q', [chunk('')], 3);
  assert.equal(fb.length, 1);
});

test('oversized document is passed whole with token-based truncation options (no char slicing)', async () => {
  const seen: any[] = [];
  const svc = new RerankerService(async () => fakeRuntime(tensor([1], [1, 1]), seen));
  await svc.rerank('q', [chunk('x'.repeat(50_000))], 1);
  assert.equal(seen[0].opts.text_pair[0].length, 50_000);
  assert.equal(seen[0].opts.truncation, true);
  assert.equal(seen[0].opts.max_length, 512);
});

test('inference failure and bad output fall back to original order', async () => {
  const boom = new RerankerService(async () => ({ tokenizer: () => ({}), model: async () => { throw new Error('onnx'); } }));
  const input = [chunk('a'), chunk('b')];
  assert.deepEqual((await boom.rerank('q', input, 2)).map((r) => r.chunk.text), ['a', 'b']);
  const nan = new RerankerService(async () => fakeRuntime(tensor([NaN, 1], [2, 1])));
  assert.deepEqual((await nan.rerank('q', input, 2)).map((r) => r.chunk.text), ['a', 'b']);
});

test('failed model load is NOT cached: next call retries and succeeds', async () => {
  let calls = 0;
  const svc = new RerankerService(async () => {
    calls++;
    if (calls === 1) throw new Error('download failed');
    return fakeRuntime(tensor([1, 5], [2, 1]));
  });
  const input = [chunk('a'), chunk('b')];
  assert.deepEqual((await svc.rerank('q', input, 2)).map((r) => r.chunk.text), ['a', 'b']); // fallback
  assert.deepEqual((await svc.rerank('q', input, 2)).map((r) => r.chunk.text), ['b', 'a']); // recovered
  assert.equal(calls, 2);
});

test('missing local model asset falls back gracefully without crashing', async () => {
  const svc = new RerankerService(async () => {
    throw new Error('Local model files not found in cache (remote disabled)');
  });
  const input = [chunk('first', 0.8), chunk('second', 0.2)];
  const out = await svc.rerank('query', input, 2);
  assert.deepEqual(out.map((r) => r.chunk.text), ['first', 'second']);
});

test('resolveOfflineTrainedDataDir finds eng.traineddata when present in cwd', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ocr-'));
  const origCwd = process.cwd();
  try {
    fs.writeFileSync(path.join(tmp, 'eng.traineddata'), 'dummy');
    process.chdir(tmp);
    assert.equal(resolveOfflineTrainedDataDir(), tmp);
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

