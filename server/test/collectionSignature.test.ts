import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCollectionSignature } from '../src/utils/collectionSignature';

test('same chunks + same filter => same signature', () => {
  const docs = [{ id: 'a', text: 'hello world' }, { id: 'b', text: 'foo bar' }];
  assert.equal(computeCollectionSignature(docs, ['x.pdf']), computeCollectionSignature(docs, ['x.pdf']));
});

test('REGRESSION: identical id + identical length but different text => different signature', () => {
  const before = [{ id: 'c1', text: 'apple banana cherry' }];
  const after = [{ id: 'c1', text: 'zebra yellow orange' }];
  assert.equal(before[0].text.length, after[0].text.length); // the case the old length-hash missed
  assert.notEqual(computeCollectionSignature(before), computeCollectionSignature(after));
});

test('adding or removing a chunk changes the signature', () => {
  const base = [{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }];
  assert.notEqual(computeCollectionSignature(base), computeCollectionSignature([...base, { id: 'c', text: 'three' }]));
  assert.notEqual(computeCollectionSignature(base), computeCollectionSignature(base.slice(1)));
});

test('row order returned by the database does not matter', () => {
  const a = { id: 'a', text: 'one' };
  const b = { id: 'b', text: 'two' };
  assert.equal(computeCollectionSignature([a, b]), computeCollectionSignature([b, a]));
});

test('filter changes the signature, regardless of filter order', () => {
  const docs = [{ id: 'a', text: 'one' }];
  assert.notEqual(computeCollectionSignature(docs, ['x.pdf']), computeCollectionSignature(docs, ['y.pdf']));
  assert.equal(computeCollectionSignature(docs, ['x.pdf', 'y.pdf']), computeCollectionSignature(docs, ['y.pdf', 'x.pdf']));
});

test('field boundaries are unambiguous (id/text framing)', () => {
  assert.notEqual(
    computeCollectionSignature([{ id: 'a', text: 'bc' }]),
    computeCollectionSignature([{ id: 'ab', text: 'c' }])
  );
});

test('filename containing a comma cannot collide with two filenames', () => {
  const docs = [{ id: 'a', text: 'one' }];
  assert.notEqual(
    computeCollectionSignature(docs, ['a,b.pdf']),
    computeCollectionSignature(docs, ['a', 'b.pdf'])
  );
});