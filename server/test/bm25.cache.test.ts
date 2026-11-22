import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BM25Service, BM25Document } from '../src/services/bm25.service';

const doc = (id: string, text: string): BM25Document => ({ id, text, fileName: 'f.txt' });
const filler = [doc('x1', 'alpha beta gamma'), doc('x2', 'delta epsilon theta')];

test('REGRESSION: same id + same length, new text => index is rebuilt', () => {
  const svc = new BM25Service();
  const oldText = 'apple banana cherry';
  const newText = 'zebra yellow orange';
  assert.equal(oldText.length, newText.length);

  svc.buildIndex([doc('c1', oldText), ...filler]);
  assert.equal(svc.search('apple')[0]?.id, 'c1');

  svc.buildIndex([doc('c1', newText), ...filler]);   // old code: cache hit => stale
  assert.equal(svc.search('zebra')[0]?.id, 'c1');    // new word is findable
  assert.equal(svc.search('apple').length, 0);       // old word is gone
});

test('identical input is a cache hit (index object is reused)', () => {
  const svc = new BM25Service();
  const docs = [doc('c1', 'apple banana cherry'), ...filler];
  svc.buildIndex(docs);
  const engine = (svc as any).bm25;
  svc.buildIndex(docs);
  assert.strictEqual((svc as any).bm25, engine);
});

test('invalidateCache() forces a rebuild', () => {
  const svc = new BM25Service();
  svc.buildIndex([doc('c1', 'apple banana cherry'), ...filler]);
  svc.invalidateCache();
  assert.deepEqual(svc.search('apple'), []);
});