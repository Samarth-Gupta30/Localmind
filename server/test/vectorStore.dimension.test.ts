// Integration test: uses a REAL LanceDB in a temp folder (needs @lancedb/lancedb installed).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VectorStoreService } from '../src/services/vectorStore.service';
import type { DocumentChunk } from '../src/services/chunking.service';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localmind-vs-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const chunk = (id: string, fileName: string, text = 'some text'): DocumentChunk => ({
  id, fileName, pageNumber: 1, chunkIndex: 0, text,
});

test('dimension compatibility lifecycle', async () => {
  const store = new VectorStoreService(dir);

  // 1. first upload defines the dimension (3D)
  await store.addDocuments([chunk('a1', 'a.txt')], [[1, 0, 0]]);

  // 2. a 4D upload is rejected with a clear 409
  await assert.rejects(
    store.addDocuments([chunk('b1', 'b.txt')], [[1, 0, 0, 0]]),
    (e: any) => e.statusCode === 409 && /Dimension conflict/.test(e.message)
  );

  // 3. a 4D query is rejected too
  await assert.rejects(
    store.search([1, 0, 0, 0], 3),
    (e: any) => e.statusCode === 409 && /query embedding is 4D/.test(e.message)
  );

  // 4. a matching 3D query still works
  const hits = await store.search([1, 0, 0], 3);
  assert.equal(hits.length, 1);

  // 5. after deleting everything, a new dimension is accepted (table recreated)
  await store.deleteFile('a.txt');
  await store.addDocuments([chunk('b1', 'b.txt')], [[1, 0, 0, 0]]);
  assert.equal((await store.search([1, 0, 0, 0], 3)).length, 1);
});

test('zero-magnitude and non-finite vectors are rejected, not stored', async () => {
  const store = new VectorStoreService(fs.mkdtempSync(path.join(dir, 'z-')));
  await assert.rejects(store.addDocuments([chunk('z1', 'z.txt')], [[0, 0, 0]]), /zero/);
  await assert.rejects(store.addDocuments([chunk('z1', 'z.txt')], [[NaN, 1, 0]]), /non-finite/);
  await assert.rejects(store.addDocuments([chunk('z1', 'z.txt')], [[]]), /empty or has 0 dimensions/);
});

test('issue 6 regression: newly added file is visible to getAllChunks without restart', async () => {
  const store = new VectorStoreService(fs.mkdtempSync(path.join(dir, 'c-')));
  await store.addDocuments([chunk('x1', 'x.txt', 'first')], [[1, 0, 0]]);
  assert.equal((await store.getAllChunks()).length, 1); // primes the cache
  await store.addDocuments([chunk('y1', 'y.txt', 'second')], [[0, 1, 0]]);
  assert.equal((await store.getAllChunks()).length, 2);
});