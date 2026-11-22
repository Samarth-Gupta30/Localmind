// @ts-ignore
import BM25 from 'wink-bm25-text-search';
import { computeCollectionSignature } from '../utils/collectionSignature';
import { logger } from '../utils/logger';

export interface BM25Document {
  id: string;
  text: string;
  fileName: string;
  pageNumber?: number;
  endPageNumber?: number;
  chunkIndex?: number;
  sectionTitle?: string;
  contentType?: string;
}

export class BM25Service {
  private bm25: any;
  private isIndexed: boolean = false;
  private lastDocSignature: string = '';
  private lastCollectionVersion: number = -1;
  private lastScopeKey: string = '';

  constructor() {
    this.resetIndex();
  }

  private static normalizeScopeKey(fileFilter: string[] = []): string {
    if (!fileFilter || fileFilter.length === 0) return '*';
    return [...new Set(fileFilter)].sort().join('\0');
  }

  /**
   * Resets and configures a fresh BM25 engine instance.
   */
  public resetIndex(): void {
    this.bm25 = BM25();

    const prepPipeline = (text: string): string[] => {
      if (typeof text !== 'string' || !text.trim()) {
        return [];
      }

      return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .trim()
        .split(/\s+/)
        .filter((token) => token.length > 1);
    };

    // wink-bm25 requirement: 1. defineConfig first, 2. definePrepTasks second
    this.bm25.defineConfig({
      fldWeights: { text: 1 },
    });

    this.bm25.definePrepTasks([prepPipeline]);

    this.isIndexed = false;
    this.lastDocSignature = '';
    this.lastCollectionVersion = -1;
    this.lastScopeKey = '';
  }

  /**
   * Explicitly invalidates the cache when document set changes (upload / delete).
   */
  public invalidateCache(): void {
    logger.info('BM25', 'Cache invalidated due to document lifecycle change.');
    this.resetIndex();
  }

  /**
   * Fingerprint of the candidate chunks + file filter.
   * Hashes the actual chunk TEXT (not just its length), so any content change
   * produces a different signature and forces an index rebuild.
   */
  private generateSignature(docs: BM25Document[], fileFilter: string[] = []): string {
    return computeCollectionSignature(docs, fileFilter);
  }

  /**
   * Ensures the BM25 index is warm for the given (collectionVersion, fileFilter).
   * Returns false if the collection is empty; skips loading chunks completely on cache hits.
   */
  public async ensureIndex(
    loadChunks: () => Promise<BM25Document[]>,
    collectionVersion: number,
    fileFilter: string[] = []
  ): Promise<boolean> {
    const scopeKey = BM25Service.normalizeScopeKey(fileFilter);

    if (
      this.isIndexed &&
      this.lastCollectionVersion === collectionVersion &&
      this.lastScopeKey === scopeKey
    ) {
      return true;
    }

    const docs = await loadChunks();
    if (!docs || docs.length === 0) {
      this.resetIndex();
      return false;
    }

    this.buildIndex(docs, fileFilter);
    if (this.isIndexed) {
      this.lastCollectionVersion = collectionVersion;
      this.lastScopeKey = scopeKey;
    }
    return this.isIndexed;
  }

  /**
   * Builds or updates the BM25 index with candidate chunks from LanceDB.
   * Caches index to avoid rebuilding when document set and filter have not changed.
   */
  public buildIndex(docs: BM25Document[], fileFilter: string[] = []): void {
    if (!docs || docs.length === 0) {
      this.resetIndex();
      return;
    }

    const currentSignature = this.generateSignature(docs, fileFilter);

    if (this.isIndexed && this.lastDocSignature === currentSignature) {
      return;
    }

    this.resetIndex();

    let addedCount = 0;
    for (const doc of docs) {
      if (doc && typeof doc.text === 'string' && doc.text.trim().length > 0) {
        this.bm25.addDoc({ text: doc.text }, doc.id);
        addedCount++;
      }
    }

    if (addedCount === 0) {
      return;
    }

    // wink-bm25 requires at least 3 documents to consolidate.
    if (addedCount < 3) {
      const paddingNeeded = 3 - addedCount;
      for (let p = 0; p < paddingNeeded; p++) {
        this.bm25.addDoc(
          { text: `__bm25_synthetic_filler_pad_token_${p}__` },
          `__bm25_pad_${p}__`
        );
      }
    }

    try {
      this.bm25.consolidate();
      this.isIndexed = true;
      this.lastDocSignature = currentSignature;
      logger.info('BM25', `Built fresh index for ${addedCount} documents (Filter: [${fileFilter.join(', ')}]).`);
    } catch (err) {
      this.resetIndex();
      logger.warn(
        'BM25',
        `Index consolidation failed for ${addedCount} documents. Vector search will still run.`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /**
   * Performs BM25 keyword search against the indexed documents.
   */
  public search(query: string, topK: number = 20): Array<{ id: string; score: number }> {
    if (!this.isIndexed || !query || !query.trim()) return [];

    try {
      const rawResults = this.bm25.search(query.trim(), topK + 2);
      if (!Array.isArray(rawResults)) return [];

      return rawResults
        .map((result: any) => {
          if (!result) return null;

          if (Array.isArray(result)) {
            const docId = String(result[0] || '');
            if (docId.startsWith('__bm25_pad_')) return null;
            return { id: docId, score: Number(result[1]) || 0 };
          }

          const docId = String(result.out || result.id || result[0] || '');
          if (!docId || docId.startsWith('__bm25_pad_')) return null;
          const score = Number(result.score || result[1]) || 0;

          return { id: docId, score };
        })
        .filter((item): item is { id: string; score: number } => item !== null)
        .slice(0, topK);
    } catch (err) {
      logger.warn('BM25', 'Search query skipped:', err instanceof Error ? err.message : String(err));
      return [];
    }
  }
}

export const bm25Service = new BM25Service();