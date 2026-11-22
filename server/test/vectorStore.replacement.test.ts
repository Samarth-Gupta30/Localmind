import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VectorStoreService } from '../src/services/vectorStore.service';
import type { DocumentChunk } from '../src/services/chunking.service';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localmind-replace-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const makeChunk = (id: string, fileName: string, text: string): DocumentChunk => ({
  id,
  fileName,
  pageNumber: 1,
  chunkIndex: 0,
  text,
});

test('successful replacement prunes old chunks and invalidates cachedChunks', async () => {
  const store = new VectorStoreService(fs.mkdtempSync(path.join(dir, 'ok-')));
  await store.addDocuments([makeChunk('v1-1', 'doc.txt', 'old text')], [[1, 0, 0]]);
  assert.deepEqual((await store.getAllChunks()).map((c) => c.id), ['v1-1']);

  await store.addDocuments([makeChunk('v2-1', 'doc.txt', 'new text')], [[0, 1, 0]]);
  const chunks = await store.getAllChunks();
  assert.deepEqual(chunks.map((c) => c.id), ['v2-1']);
  assert.equal(chunks[0].text, 'new text');
});

test('insertion failure retains old chunks and invalidates cache', async () => {
  const store = new VectorStoreService(fs.mkdtempSync(path.join(dir, 'ins-')));
  await store.addDocuments([makeChunk('v1-1', 'doc.txt', 'old text')], [[1, 0, 0]]);
  await store.getAllChunks();

  await assert.rejects(
    store.addDocuments([makeChunk('v2-1', 'doc.txt', 'bad')], [[NaN, 1, 0]]),
    /non-finite/
  );

  const chunks = await store.getAllChunks();
  assert.deepEqual(chunks.map((c) => c.id), ['v1-1']);
});

test('full pruning failure rolls back new chunks and leaves zero duplicates', async () => {
  const store = new VectorStoreService(fs.mkdtempSync(path.join(dir, 'prune-')));
  await store.addDocuments([makeChunk('v1-1', 'doc.txt', 'old text')], [[1, 0, 0]]);

  const realGetTable = store.getTable.bind(store);
  (store as any).getTable = async () => {
    const table = await realGetTable();
    if (!table) return null;
    const origDelete = table.delete.bind(table);
    table.delete = async (pred: string) => {
      if (pred.includes('v1-1')) throw new Error('Simulated prune failure');
      return origDelete(pred);
    };
    return table;
  };

  await assert.rejects(
    store.addDocuments([makeChunk('v2-1', 'doc.txt', 'new text')], [[0, 1, 0]]),
    /Rolled back new upload/
  );

  const chunks = await store.getAllChunks();
  assert.deepEqual(chunks.map((c) => c.id), ['v1-1']);
});

test('partial pruning failure persists pending prunes across simulated restart and cleans up', async () => {
  const storeDir = fs.mkdtempSync(path.join(dir, 'restart-'));
  const store1 = new VectorStoreService(storeDir);

  const oldChunks = Array.from({ length: 55 }, (_, i) =>
    makeChunk(`v1-${i}`, 'big.txt', `old ${i}`)
  );
  await store1.addDocuments(oldChunks, oldChunks.map(() => [1, 0, 0]));

  const realGetTable = store1.getTable.bind(store1);
  (store1 as any).getTable = async () => {
    const table = await realGetTable();
    if (!table) return null;
    const origDelete = table.delete.bind(table);
    table.delete = async (pred: string) => {
      if (pred.includes('v1-54')) {
        throw new Error('Simulated batch 2 failure');
      }
      return origDelete(pred);
    };
    return table;
  };

  await assert.rejects(
    store1.addDocuments([makeChunk('v2-0', 'big.txt', 'new 0')], [[0, 1, 0]]),
    /Partial replacement failure/
  );
  await store1.close();

  const store2 = new VectorStoreService(storeDir);
  const flushed = await store2.flushPendingPrunes();
  assert.equal(flushed, 5);
  const visible = await store2.getAllChunks();
  assert.deepEqual(visible.map((c) => c.id), ['v2-0']);
  await store2.close();
});

test('interrupted replacement journal reconciles after simulated restart', async () => {
  const storeDir = fs.mkdtempSync(path.join(dir, 'journal-'));
  const store1 = new VectorStoreService(storeDir);
  await store1.addDocuments([makeChunk('v1-a', 'note.txt', 'old note')], [[1, 0, 0]]);
  await store1.addDocuments([makeChunk('v2-a', 'note.txt', 'new note')], [[0, 1, 0]]);

  // Simulate crash after inserting v2-a by writing journal with v1-a still present
  const table = await store1.getTable();
  assert.ok(table);
  await table.add([
    {
      id: 'v1-a',
      fileName: 'note.txt',
      pageNumber: 1,
      endPageNumber: 1,
      chunkIndex: 0,
      text: 'old note',
      sectionTitle: '',
      contentType: 'paragraph',
      vector: [1, 0, 0],
    },
  ]);
  fs.writeFileSync(
    path.join(storeDir, '.replacement-journal.json'),
    JSON.stringify({ fileNames: ['note.txt'], newChunkIds: ['v2-a'], oldChunkIds: ['v1-a'] })
  );
  await store1.close();

  const store2 = new VectorStoreService(storeDir);
  await store2.flushPendingPrunes();
  const visible = await store2.getAllChunks();
  assert.deepEqual(visible.map((c) => c.id), ['v2-a']);
  await store2.close();
});