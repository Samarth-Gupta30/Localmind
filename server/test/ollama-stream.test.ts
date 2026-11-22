import { test } from 'node:test';
import assert from 'node:assert/strict';

// Replace the real preference store (which opens the SQLite DB on import) with a stub,
// so this test never touches your real database.
const prefPath = require.resolve('../src/services/preference.service');
require.cache[prefPath] = {
  id: prefPath, filename: prefPath, loaded: true,
  exports: {
    preferenceStore: { get: (k: string) => (k === 'responseStyle' ? 'balanced' : 0.5) },
    PreferenceStore: class {},
  },
} as any;
const { OllamaService } = require('../src/services/ollama.service');

// Build a fake fetch that streams the given raw chunks as the Ollama body.
function mockFetch(chunks: string[]) {
  (globalThis as any).fetch = async () => ({
    ok: true,
    body: new ReadableStream({
      start(c) { chunks.forEach((x) => c.enqueue(new TextEncoder().encode(x))); c.close(); },
    }),
  });
}
async function run(chunks: string[], signal?: AbortSignal) {
  mockFetch(chunks);
  const events: string[] = [];
  let metrics: any;
  const svc = new (OllamaService as any)();
  await svc.streamChat([{ role: 'user', content: 'hi' }], {
    onToken: (t: string) => events.push('token:' + t),
    onDone: (m: any) => { events.push('done'); metrics = m; },
    onError: (e: Error) => events.push('error:' + e.message),
  }, 'qwen2.5:1.5b', signal);
  return { events, metrics };
}
const line = (o: object) => JSON.stringify(o) + '\n';

test('normal stream: tokens then done with real Ollama metrics', async () => {
  const { events, metrics } = await run([
    line({ message: { content: 'Hel' } }),
    line({ message: { content: 'lo' } }),
    line({ done: true, eval_count: 2, eval_duration: 1e9, total_duration: 2e9 }),
  ]);
  assert.deepEqual(events, ['token:Hel', 'token:lo', 'done']);
  assert.equal(metrics.totalTokens, 2);
  assert.equal(metrics.status, 'completed');
});

test('stream that ends without done:true is an ERROR, not a success', async () => {
  const { events } = await run([line({ message: { content: 'partial' } })]);
  assert.deepEqual(events, ['token:partial', 'error:Ollama stream ended before generation completed.']);
});

test('Ollama {"error"} line is reported as an error', async () => {
  const { events } = await run([line({ error: 'model not found' })]);
  assert.deepEqual(events, ['error:model not found']);
});

test('pre-aborted signal emits neither done nor error', async () => {
  const ac = new AbortController(); ac.abort();
  const { events } = await run([line({ done: true })], ac.signal);
  assert.deepEqual(events, []);
});

test('JSON split across chunks and malformed lines are handled', async () => {
  const full = line({ message: { content: 'ok' } });
  const { events } = await run([full.slice(0, 10), full.slice(10), 'not json\n', line({ done: true, eval_count: 1, eval_duration: 1e9 })]);
  assert.deepEqual(events, ['token:ok', 'done']);
});