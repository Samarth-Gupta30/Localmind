import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { BM25Service, BM25Document } from '../src/services/bm25.service';

function makeCorpus(count: number): BM25Document[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `chunk-${i}`,
    fileName: `doc-${i % 20}.pdf`,
    text: `Document ${i} discusses offline retrieval, local embeddings, hybrid search, and keyword_${i}.`,
  }));
}

test('ensureIndex loads chunks only once across repeated queries for the same version', async () => {
  const svc = new BM25Service();
  let loadCalls = 0;
  const docs = makeCorpus(5000);

  const loader = async () => {
    loadCalls++;
    return docs;
  };

  await svc.ensureIndex(loader, 1, []);
  for (let q = 0; q < 50; q++) {
    await svc.ensureIndex(loader, 1, []);
    const hits = svc.search('keyword_4242', 5);
    assert.equal(hits[0]?.id, 'chunk-4242');
  }

  assert.equal(loadCalls, 1);

  // Version bump triggers fresh load
  await svc.ensureIndex(loader, 2, []);
  assert.equal(loadCalls, 2);

  // Scope change triggers fresh load
  await svc.ensureIndex(loader, 2, ['doc-0.pdf']);
  assert.equal(loadCalls, 3);
});

for (const corpusSize of [5_000, 10_000, 20_000]) {
  test(`benchmark BM25 cold index, warm search, and memory at ${corpusSize} chunks`, async () => {
    const svc = new BM25Service();
    const docs = makeCorpus(corpusSize);
    const memBefore = process.memoryUsage();

    const tColdStart = performance.now();
    await svc.ensureIndex(async () => docs, 1, []);
    const coldMs = performance.now() - tColdStart;

    const queryCount = 50;
    const tWarmStart = performance.now();
    for (let q = 0; q < queryCount; q++) {
      const targetIdx = (q * 97) % corpusSize;
      const hits = svc.search(`keyword_${targetIdx}`, 5);
      assert.equal(hits[0]?.id, `chunk-${targetIdx}`);
    }
    const warmTotalMs = performance.now() - tWarmStart;
    const warmAvgMs = warmTotalMs / queryCount;

    const memAfter = process.memoryUsage();
    const heapDeltaMb = ((memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024)).toFixed(1);
    const rssMb = (memAfter.rss / (1024 * 1024)).toFixed(1);

    console.log(
      `[BM25 Benchmark ${corpusSize} chunks] cold=${coldMs.toFixed(1)}ms | 50_warm_total=${warmTotalMs.toFixed(1)}ms (avg=${warmAvgMs.toFixed(2)}ms) | rss=${rssMb}MB | heap_delta=${heapDeltaMb}MB`
    );
  });
}