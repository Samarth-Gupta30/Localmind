import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OllamaService } from '../src/services/ollama.service';
import { createSSEParser } from '../../client/src/utils/sseParser';

test('cancellation during model loading (fetch) does not emit onDone or onError', async () => {
  const service = new OllamaService();
  const ac = new AbortController();
  let doneCalled = false;
  let errorCalled = false;

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init?: any) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  }) as any;

  try {
    const p = service.streamChat(
      [{ role: 'user', content: 'hi' }],
      {
        onToken: () => {},
        onDone: () => { doneCalled = true; },
        onError: () => { errorCalled = true; },
      },
      undefined,
      ac.signal
    );
    ac.abort();
    await p;
    assert.equal(doneCalled, false);
    assert.equal(errorCalled, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('cancellation during generation prevents onDone even if done chunk arrives', async () => {
  const service = new OllamaService();
  const ac = new AbortController();
  let doneCalled = false;

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(JSON.stringify({ message: { content: 'hel' }, done: false }) + '\n'));
        ac.abort();
        controller.enqueue(enc.encode(JSON.stringify({ message: { content: 'lo' }, done: true }) + '\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as any;

  try {
    await service.streamChat(
      [{ role: 'user', content: 'hi' }],
      {
        onToken: () => {},
        onDone: () => { doneCalled = true; },
        onError: () => {},
      },
      undefined,
      ac.signal
    );
    assert.equal(doneCalled, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('createSSEParser handles malformed, incomplete, CRLF, and multi-event streams', () => {
  const events: Array<Record<string, unknown>> = [];
  const parseErrors: string[] = [];

  const parser = createSSEParser({
    onEvent: (ev) => events.push(ev),
    onParseError: (raw) => parseErrors.push(raw),
  });

  // Multi-event chunk with CRLF, keep-alive comment, malformed JSON, and trailing incomplete event
  parser.feed(
    ': ping\r\n\r\n' +
    'data: {"type":"token","token":"Hi"}\r\n\r\n' +
    'data: {bad json\n\n' +
    'data: {"type":"token","token":" there"}'
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].token, 'Hi');
  assert.equal(parseErrors.length, 1);

  // Complete the trailing event
  parser.feed('\n\ndata: {"type":"done","metrics":{}}\n\n');
  parser.flush();

  assert.equal(events.length, 3);
  assert.equal(events[1].token, ' there');
  assert.equal(events[2].type, 'done');
});