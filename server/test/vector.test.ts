import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidVector, normalizeVector, vectorNorm } from '../src/utils/vector';

test('isValidVector accepts normal finite vectors', () => {
  assert.equal(isValidVector([0.1, -0.2, 3]), true);
});

test('isValidVector rejects empty, non-array and wrong element types', () => {
  assert.equal(isValidVector([]), false);
  assert.equal(isValidVector(null), false);
  assert.equal(isValidVector(undefined), false);
  assert.equal(isValidVector('abc'), false);
  assert.equal(isValidVector({ length: 3 }), false);
  assert.equal(isValidVector([1, '2', 3]), false);
  assert.equal(isValidVector([1, null, 3]), false); // what JSON turns NaN into
});

test('isValidVector rejects NaN and Infinity', () => {
  assert.equal(isValidVector([1, NaN]), false);
  assert.equal(isValidVector([1, Infinity]), false);
  assert.equal(isValidVector([1, -Infinity]), false);
});

test('isValidVector rejects sparse arrays (holes)', () => {
  // eslint-disable-next-line no-sparse-arrays
  assert.equal(isValidVector([1, , 3]), false);
});

test('normalizeVector returns a unit-length vector', () => {
  const out = normalizeVector([3, 4])!;
  assert.ok(Math.abs(vectorNorm(out) - 1) < 1e-12);
  assert.deepEqual(out, [0.6, 0.8]);
});

test('normalizeVector returns null for all-zero vectors', () => {
  assert.equal(normalizeVector([0, 0, 0]), null);
});

test('normalizeVector returns null when squaring overflows to Infinity', () => {
  assert.equal(normalizeVector([1e200, 1e200]), null);
});