import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectExcerptsForPrompt,
  alignCitationsWithFinalPrompt,
  streamRagChat,
} from '../src/controllers/chat.controller';
import type { SearchResult } from '../src/services/vectorStore.service';

const makeHit = (id: string, text: string, score: number): SearchResult => ({
  chunk: { id, fileName: 'guide.pdf', pageNumber: 1, chunkIndex: 0, text },
  score,
});

test('selectExcerptsForPrompt drops lower-ranked oversized excerpts in fast mode', () => {
  const hits = [
    makeHit('c1', 'Top relevant excerpt. '.repeat(35), 0.9),
    makeHit('c2', 'Second excerpt. '.repeat(80), 0.7),
    makeHit('c3', 'Third excerpt. '.repeat(80), 0.5),
  ];

  const fitted = selectExcerptsForPrompt(hits, {
    isFastMode: true,
    maxTokens: 900,
    userQuery: 'What is in the guide?',
  });

  assert.ok(fitted.length >= 1 && fitted.length < hits.length);
  assert.equal(fitted[0].chunk.id, 'c1');
});

test('selectExcerptsForPrompt allows larger context in deep mode than fast mode', () => {
  const hits = [
    makeHit('c1', 'Alpha fact. '.repeat(50), 0.9),
    makeHit('c2', 'Beta fact. '.repeat(50), 0.8),
    makeHit('c3', 'Gamma fact. '.repeat(50), 0.7),
    makeHit('c4', 'Delta fact. '.repeat(50), 0.6),
  ];

  const fastFitted = selectExcerptsForPrompt(hits, {
    isFastMode: true,
    maxTokens: 900,
    userQuery: 'Explain details',
  });
  const deepFitted = selectExcerptsForPrompt(hits, {
    isFastMode: false,
    maxTokens: 1800,
    userQuery: 'Explain details',
  });

  assert.ok(deepFitted.length >= fastFitted.length);
});

test('alignCitationsWithFinalPrompt excludes excerpts removed from final system prompt', () => {
  const h1 = makeHit('c1', 'Kept excerpt alpha', 0.9);
  const h2 = makeHit('c2', 'Removed excerpt beta', 0.5);

  const aligned = alignCitationsWithFinalPrompt([h1, h2], [
    { role: 'system', content: 'Rules here. Kept excerpt alpha is present.' },
    { role: 'user', content: 'Question' },
  ]);

  assert.deepEqual(aligned.map((i) => i.chunk.id), ['c1']);
});

test('streamRagChat rejects oversized queries with HTTP 400', async () => {
  const res: any = {
    headersSent: false,
    statusCode: 200,
    body: null,
    on() {
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };

  await streamRagChat({ body: { query: 'q'.repeat(4001) } } as any, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});