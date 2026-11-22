/**
 * Shared vector helpers. Previously the same validation/normalisation logic was
 * copy-pasted in embedding.service.ts and vectorStore.service.ts (three copies);
 * keeping ONE copy means a fix can't be applied in one place and forgotten in another.
 */

/**
 * True only for a non-empty array whose every element is a finite number.
 * Rejects: non-arrays, [], NaN, Infinity, null, strings, holes in sparse arrays.
 */
export function isValidVector(vec: unknown): vec is number[] {
  if (!Array.isArray(vec) || vec.length === 0) return false;
  for (let i = 0; i < vec.length; i++) {
    const val = vec[i];
    if (typeof val !== 'number' || !Number.isFinite(val)) return false;
  }
  return true;
}

/** Euclidean (L2) length of a vector. */
export function vectorNorm(vec: number[]): number {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  return Math.sqrt(sumSq);
}

/**
 * Scales a vector to length 1.
 * Returns null (instead of a bad vector) when that is impossible: all-zero,
 * or so large that squaring overflowed to Infinity. The caller decides what
 * error to raise, because the right message depends on where it happened.
 */
export function normalizeVector(vec: number[]): number[] | null {
  const norm = vectorNorm(vec);
  if (!Number.isFinite(norm) || norm <= 0) return null;
  return vec.map((v) => v / norm);
}