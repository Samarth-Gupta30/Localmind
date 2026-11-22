import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { SelfHealingService } from '../src/services/selfHealing.service';
import { EmbeddingService } from '../src/services/embedding.service';
import { streamAgentChat } from '../src/controllers/agent.controller';

test('SelfHealingService stops and returns cancelled when signal aborts', async () => {
  const svc = new SelfHealingService();
  const ac = new AbortController();
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
    const schema = z.object({ ok: z.boolean() });
    const runPromise = svc.executeWithSchema('test', schema, '{"ok":true}', '', ac.signal);
    ac.abort();
    const res = await runPromise;
    assert.equal(res.success, false);
    assert.equal(res.error, 'Request cancelled');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('SelfHealingService times out hung request cleanly', async () => {
  const svc = new SelfHealingService();
  const origFetch = globalThis.fetch;

  globalThis.fetch = (async (_url: any, init?: any) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('Timed out');
        err.name = 'AbortError';
        reject(err);
      });
    });
  }) as any;

  try {
    const schema = z.object({ ok: z.boolean() });
    await assert.rejects(
      svc.executeWithSchema('test', schema, '{"ok":true}', '', undefined, 50),
      /timed out/i
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('EmbeddingService rejects with cancellation when signal aborts during fetch', async () => {
  const svc = new EmbeddingService({ timeoutMs: 5000 });
  const ac = new AbortController();
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
    const p = svc.getEmbedding('hello world', 'search_query', ac.signal);
    ac.abort();
    await assert.rejects(p, /cancelled/i);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('cancelling during agent routing stops further processing and emits no approval or completion', async () => {
  const origFetch = globalThis.fetch;
  const writtenEvents: any[] = [];
  let signalPassedToRouter = false;

  const res: any = Object.assign(new EventEmitter(), {
    headersSent: false,
    writable: true,
    writableEnded: false,
    destroyed: false,
    locals: { agentSessionId: 'c'.repeat(64) },
    setHeader() {},
    flushHeaders() {
      this.headersSent = true;
    },
    write(chunk: string) {
      if (chunk.startsWith('data: ')) {
        writtenEvents.push(JSON.parse(chunk.slice(6).trim()));
      }
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  });

  globalThis.fetch = (async (_url: any, init?: any) => {
    signalPassedToRouter = Boolean(init?.signal);
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        reject(err);
      });
      setTimeout(() => res.emit('close'), 15);
    });
  }) as any;

  try {
    await streamAgentChat({ body: { query: 'run a tool for me' } } as any, res);
    assert.equal(signalPassedToRouter, true);
    assert.equal(writtenEvents.some((e) => e.type === 'action_required'), false);
    assert.equal(writtenEvents.some((e) => e.type === 'done'), false);
  } finally {
    globalThis.fetch = origFetch;
  }
});