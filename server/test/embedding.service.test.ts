import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EmbeddingService } from '../src/services/embedding.service';
import { AppError } from '../src/utils/errorHandler';

afterEach(() => mock.restoreAll());

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const mockFetch = (impl: (url: any, init?: any) => Promise<Response>) =>
  mock.method(globalThis, 'fetch', impl as any);

const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

async function rejectsWith(p: Promise<unknown>, status: number, pattern: RegExp) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof AppError, 'expected an AppError');
    assert.equal((err as AppError).statusCode, status);
    assert.match((err as AppError).message, pattern);
    return true;
  });
}

test('happy path: returns a normalized vector', async () => {
  mockFetch(async () => jsonResponse({ embedding: [3, 4] }));
  const out = await new EmbeddingService().getEmbedding('hello', 'search_query');
  assert.ok(Math.abs(norm(out) - 1) < 1e-12);
});

test('sends a timeout signal and the task prefix', async () => {
  const m = mockFetch(async () => jsonResponse({ embedding: [1, 0] }));
  await new EmbeddingService().getEmbedding('hello', 'search_document');
  const init = m.mock.calls[0].arguments[1];
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(JSON.parse(init.body).prompt, 'search_document: hello');
});

test('empty / whitespace / non-string text => 400, no network call', async () => {
  const m = mockFetch(async () => jsonResponse({ embedding: [1] }));
  const svc = new EmbeddingService();
  await rejectsWith(svc.getEmbedding('   '), 400, /empty text/);
  await rejectsWith(svc.getEmbedding(undefined as any), 400, /empty text/);
  assert.equal(m.mock.calls.length, 0);
});

test('connection failure => 503', async () => {
  mockFetch(async () => { throw new TypeError('fetch failed'); });
  await rejectsWith(new EmbeddingService().getEmbedding('x'), 503, /Failed to connect/);
});

test('HTTP error from Ollama => 502 with body', async () => {
  mockFetch(async () => new Response('model "nope" not found', { status: 404 }));
  await rejectsWith(new EmbeddingService().getEmbedding('x'), 502, /404.*not found/);
});

test('body that is not JSON => 502', async () => {
  mockFetch(async () => new Response('<html>oops</html>', { status: 200 }));
  await rejectsWith(new EmbeddingService().getEmbedding('x'), 502, /not valid JSON/);
});

test('JSON null / array / string body => 502', async () => {
  for (const body of [null, [1, 2], 'text', 42]) {
    mockFetch(async () => jsonResponse(body));
    await rejectsWith(new EmbeddingService().getEmbedding('x'), 502, /Unexpected response shape/);
    mock.restoreAll();
  }
});

test('{"error": "..."} with HTTP 200 => 502 with that message', async () => {
  mockFetch(async () => jsonResponse({ error: 'out of memory' }));
  await rejectsWith(new EmbeddingService().getEmbedding('x'), 502, /out of memory/);
});

test('missing / empty / wrong-typed / null-containing embedding => 502', async () => {
  for (const body of [{}, { embedding: [] }, { embedding: 'abc' }, { embedding: [0.1, null] }, { embedding: [0.1, '2'] }]) {
    mockFetch(async () => jsonResponse(body));
    await rejectsWith(new EmbeddingService().getEmbedding('x'), 502, /invalid vector/);
    mock.restoreAll();
  }
});

test('all-zero embedding => 502', async () => {
  mockFetch(async () => jsonResponse({ embedding: [0, 0, 0] }));
  await rejectsWith(new EmbeddingService().getEmbedding('x'), 502, /zero-magnitude/);
});

test('timeout: a hung request is aborted => 504', async () => {
  mockFetch((_url, init) => new Promise<Response>((_res, rej) => {
    init.signal.addEventListener('abort', () => rej(init.signal.reason));
  }));
  // AbortSignal.timeout() uses an unref'd timer: a running server stays alive on its
  // own, but a bare test process would exit first. This interval keeps it alive.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await rejectsWith(new EmbeddingService({ timeoutMs: 30 }).getEmbedding('x'), 504, /did not answer within 30 ms/);
  } finally {
    clearInterval(keepAlive);
  }
});

test('invalid timeout option falls back to the default instead of 0/NaN', async () => {
  const m = mockFetch(async () => jsonResponse({ embedding: [1, 0] }));
  await new EmbeddingService({ timeoutMs: -5 }).getEmbedding('x');
  assert.equal(m.mock.calls.length, 1); // would have aborted instantly with a 0 ms timeout
});