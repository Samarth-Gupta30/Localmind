import crypto from 'crypto';

export interface SignatureDoc {
  id: string;
  text?: string;
}

/**
 * Builds a SHA-256 fingerprint of a set of chunks plus the active file filter.
 *
 * Two inputs produce the same fingerprint only if they contain the same chunk
 * IDs, the same chunk TEXT, and the same filter. Changing a single character
 * of any chunk changes the fingerprint.
 *
 * Design notes:
 * - Docs are sorted by id, so the order LanceDB returns rows in doesn't matter.
 * - Every field is length-prefixed ("framing"), so boundaries are unambiguous:
 *   id "a" + text "bc"  can never collide with  id "ab" + text "c".
 * - The filter is JSON-encoded, so a file name containing a comma can't
 *   collide with two separate file names.
 */
export function computeCollectionSignature(
  docs: SignatureDoc[],
  fileFilter: string[] = []
): string {
  const hash = crypto.createHash('sha256');

  hash.update(JSON.stringify([...fileFilter].sort()));
  hash.update(`|${docs.length}|`);

  const sorted = [...docs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const doc of sorted) {
    const text = typeof doc.text === 'string' ? doc.text : '';
    hash.update(`${doc.id.length}:${doc.id}${text.length}:`);
    hash.update(text);
  }

  return hash.digest('hex');
}
