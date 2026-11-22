import * as lancedb from '@lancedb/lancedb';
import path from 'path';
import fs from 'fs';
import { DocumentChunk } from './chunking.service';
import { isValidVector, normalizeVector } from '../utils/vector';
import { AppError } from '../utils/errorHandler';
import { logger } from '../utils/logger';

export interface VectorRecord {
  [key: string]: unknown;
  id: string;
  fileName: string;
  pageNumber: number;
  endPageNumber: number;
  chunkIndex: number;
  text: string;
  sectionTitle: string;
  contentType: string;
  vector: number[];
}

export interface SearchResult {
  chunk: DocumentChunk;
  score: number;
  rerankScore?: number;
}

interface ReplacementJournal {
  fileNames: string[];
  newChunkIds: string[];
  oldChunkIds: string[];
}

export class VectorStoreService {
  private readonly storageDir: string;
  private readonly pendingPruneFile: string;
  private readonly journalFile: string;
  private dbPromise: Promise<lancedb.Connection> | null = null;
  private isClosed = false;
  private tableName = 'document_vectors';

  private cachedChunks: DocumentChunk[] | null = null;
  private cacheGeneration = 0;
  private pendingPruneIds = new Set<string>();
  private pendingPrunesLoaded = false;

  private static readonly MAX_CACHED_CHUNKS = 5000;
  private static readonly MAX_CACHE_BYTES = 20 * 1024 * 1024; // 20 MB

  private static readonly TEXT_COLUMNS = [
    'id',
    'fileName',
    'pageNumber',
    'endPageNumber',
    'chunkIndex',
    'text',
    'sectionTitle',
    'contentType',
  ];

  constructor(storageDir = path.join(process.cwd(), 'data', 'lancedb')) {
    this.storageDir = storageDir;
    this.pendingPruneFile = path.join(this.storageDir, '.pending-prune-ids.json');
    this.journalFile = path.join(this.storageDir, '.replacement-journal.json');
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  private writeJsonAtomic(targetPath: string, data: unknown): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
    const tmpFile = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpFile, targetPath);
  }

  private removeFileIfExists(targetPath: string): void {
    try {
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
    } catch (err) {
      logger.warn('LanceDB', `Failed to remove file ${targetPath}:`, err);
    }
  }

  private writeReplacementJournal(journal: ReplacementJournal): void {
    try {
      this.writeJsonAtomic(this.journalFile, journal);
    } catch (err) {
      logger.warn('LanceDB', 'Failed to write replacement journal:', err);
    }
  }

  private clearReplacementJournal(): void {
    this.removeFileIfExists(this.journalFile);
  }

  private readReplacementJournal(): ReplacementJournal | null {
    try {
      if (!fs.existsSync(this.journalFile)) return null;
      const raw = fs.readFileSync(this.journalFile, 'utf-8');
      const parsed = JSON.parse(raw) as ReplacementJournal;
      if (
        parsed &&
        Array.isArray(parsed.fileNames) &&
        Array.isArray(parsed.newChunkIds) &&
        Array.isArray(parsed.oldChunkIds)
      ) {
        return parsed;
      }
      return null;
    } catch (err) {
      logger.warn('LanceDB', 'Failed to read replacement journal:', err);
      return null;
    }
  }

  private ensurePendingPrunesLoaded(): void {
    if (this.pendingPrunesLoaded) return;
    this.pendingPrunesLoaded = true;

    try {
      if (!fs.existsSync(this.pendingPruneFile)) return;
      const raw = fs.readFileSync(this.pendingPruneFile, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === 'string' && id.length > 0) {
            this.pendingPruneIds.add(id);
          }
        }
      }
    } catch (err) {
      logger.warn('LanceDB', 'Could not read persisted pending prune list; starting empty.', err);
    }
  }

  private persistPendingPrunes(): void {
    try {
      if (this.pendingPruneIds.size === 0) {
        this.removeFileIfExists(this.pendingPruneFile);
        return;
      }
      this.writeJsonAtomic(this.pendingPruneFile, Array.from(this.pendingPruneIds));
    } catch (err) {
      logger.warn('LanceDB', 'Failed to persist pending prune list to disk:', err);
    }
  }

  private setPendingPruneIds(nextIds: Iterable<string>): void {
    this.ensurePendingPrunesLoaded();
    this.pendingPruneIds = new Set(
      Array.from(nextIds).filter((id) => typeof id === 'string' && id.length > 0)
    );
    this.persistPendingPrunes();
  }

  private addPendingPruneIds(ids: Iterable<string>): void {
    this.ensurePendingPrunesLoaded();
    let changed = false;
    for (const id of ids) {
      if (typeof id === 'string' && id.length > 0 && !this.pendingPruneIds.has(id)) {
        this.pendingPruneIds.add(id);
        changed = true;
      }
    }
    if (changed) {
      this.persistPendingPrunes();
    }
  }

  /**
   * Recovers from an interrupted replacement recorded in `.replacement-journal.json`.
   * If new chunks were committed, queues superseded old chunks for pruning and hides them.
   */
  public async reconcileJournal(): Promise<void> {
    this.ensurePendingPrunesLoaded();
    const journal = this.readReplacementJournal();
    if (!journal) return;

    const table = await this.getTable();
    if (!table) {
      this.clearReplacementJournal();
      return;
    }

    try {
      const idFilter =
        journal.newChunkIds.length > 0
          ? `id IN (${journal.newChunkIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ')})`
          : '';
      const presentNewRows = idFilter
        ? await table.query().where(idFilter).select(['id']).toArray()
        : [];

      if (presentNewRows.length > 0 && journal.oldChunkIds.length > 0) {
        this.addPendingPruneIds(journal.oldChunkIds);
      } else if (presentNewRows.length === 0 && journal.newChunkIds.length > 0 && journal.oldChunkIds.length === 0) {
        this.addPendingPruneIds(journal.newChunkIds);
      }
      this.clearReplacementJournal();
    } catch (err) {
      logger.warn('LanceDB', 'Journal reconciliation deferred; keeping journal for retry.', err);
    }
  }

  private getConnection(): Promise<lancedb.Connection> {
    if (this.isClosed) {
      return Promise.reject(new Error('VectorStoreService is closed.'));
    }

    if (!this.dbPromise) {
      this.dbPromise = lancedb.connect(this.storageDir).catch((err) => {
        this.dbPromise = null;
        throw err;
      });
    }

    return this.dbPromise;
  }

  public async checkHealth(): Promise<{ ok: boolean; error?: string }> {
    if (this.isClosed) {
      return { ok: false, error: 'VectorStoreService is closed.' };
    }
    try {
      const db = await this.getConnection();
      await db.tableNames();
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  public async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    this.invalidateChunkCache();

    if (this.dbPromise) {
      try {
        const db = await this.dbPromise;
        const maybeClose = db as unknown as { close?: () => Promise<void> | void };
        await maybeClose.close?.();
      } catch {
        // Ignore connection errors during shutdown
      } finally {
        this.dbPromise = null;
      }
    }

    logger.info('LanceDB', 'VectorStore connection closed cleanly.');
  }

  public getVersion(): number {
    return this.cacheGeneration;
  }

  private invalidateChunkCache(): void {
    this.cachedChunks = null;
    this.cacheGeneration++;
  }

  private async deleteIdsInBatches(table: lancedb.Table, ids: string[]): Promise<string[]> {
    const remaining: string[] = [];

    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const filter = batch.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
      const predicate = `id IN (${filter})`;

      try {
        await table.delete(predicate);
      } catch {
        try {
          await table.delete(predicate);
        } catch {
          remaining.push(...batch);
        }
      }
    }

    return remaining;
  }

  public async flushPendingPrunes(): Promise<number> {
    await this.reconcileJournal();
    if (this.pendingPruneIds.size === 0) return 0;

    const table = await this.getTable();
    if (!table) {
      this.setPendingPruneIds([]);
      return 0;
    }

    const toPrune = Array.from(this.pendingPruneIds);
    const failed = await this.deleteIdsInBatches(table, toPrune);

    this.setPendingPruneIds(failed);
    const prunedCount = toPrune.length - failed.length;
    if (prunedCount > 0) {
      this.invalidateChunkCache();
      logger.info('LanceDB', `Flushed ${prunedCount} pending stale chunk(s).`);
    }
    return prunedCount;
  }

  private async getStoredDimension(table: lancedb.Table): Promise<number | null> {
    try {
      const schema: any = await table.schema();
      const field = schema?.fields?.find((f: any) => f?.name === 'vector');
      const listSize = field?.type?.listSize;
      if (typeof listSize === 'number' && listSize > 0) return listSize;
    } catch {
      // fall through to sampling
    }

    try {
      const rows = await table.query().select(['vector']).limit(1).toArray();
      const vec: any = rows[0]?.vector;
      if (vec && typeof vec.length === 'number' && vec.length > 0) return vec.length;
    } catch {
      // unknown
    }

    return null;
  }

  public async getTable(): Promise<lancedb.Table | null> {
    const db = await this.getConnection();
    const tables = await db.tableNames();
    if (tables.includes(this.tableName)) {
      return await db.openTable(this.tableName);
    }
    return null;
  }

  public async addDocuments(chunks: DocumentChunk[], embeddings: number[][]): Promise<void> {
    if (!chunks || chunks.length === 0) return;

    if (!embeddings || chunks.length !== embeddings.length) {
      throw new AppError(
        `Chunk and embedding count mismatch: received ${chunks.length} chunks but ${embeddings?.length ?? 0} embeddings.`,
        400
      );
    }

    const expectedDim = embeddings[0]?.length;
    if (!expectedDim || expectedDim === 0) {
      throw new AppError('Embeddings batch is empty or has 0 dimensions.', 400);
    }

    for (let i = 0; i < embeddings.length; i++) {
      const vec = embeddings[i];
      if (!isValidVector(vec)) {
        throw new AppError(`Embedding at index ${i} contains non-finite numbers or is empty.`, 400);
      }
      if (vec.length !== expectedDim) {
        throw new AppError(
          `Embedding dimension mismatch in batch: expected ${expectedDim}D, but chunk at index ${i} has ${vec.length}D.`,
          400
        );
      }
    }

    await this.reconcileJournal();

    let table = await this.getTable();
    if (table) {
      const existingDim = await this.getStoredDimension(table);
      if (existingDim !== null && existingDim !== expectedDim) {
        if ((await table.countRows()) === 0) {
          const db = await this.getConnection();
          await db.dropTable(this.tableName);
          this.setPendingPruneIds([]);
          this.clearReplacementJournal();
          this.invalidateChunkCache();
          table = null;
          logger.info('LanceDB', `Recreating empty table: dimension changed ${existingDim}D -> ${expectedDim}D.`);
        } else {
          throw new AppError(
            `[VectorStore] Dimension conflict: stored documents use ${existingDim}D vectors, but the current embedding model produces ${expectedDim}D. ` +
              `Switch back to the original embedding model, or delete ALL documents and upload them again.`,
            409
          );
        }
      }
    }

    const normalizedEmbeddings = embeddings.map((vec, i) => {
      const unit = normalizeVector(vec);
      if (!unit) {
        throw new AppError(`Embedding at index ${i} has zero (or overflowing) magnitude and cannot be stored.`, 400);
      }
      return unit;
    });

    const fileNames = Array.from(new Set(chunks.map((c) => c.fileName)));
    const fileFilter = fileNames
      .map((f) => `'${f.replace(/'/g, "''")}'`)
      .join(', ');

    const records: VectorRecord[] = chunks.map((chunk, idx) => ({
      id: chunk.id,
      fileName: chunk.fileName,
      pageNumber: chunk.pageNumber,
      endPageNumber: chunk.endPageNumber ?? chunk.pageNumber,
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      sectionTitle: chunk.sectionTitle ?? '',
      contentType: chunk.contentType ?? 'paragraph',
      vector: normalizedEmbeddings[idx],
    }));

    const newChunkIds = records.map((r) => r.id);
    const newIdSet = new Set(newChunkIds);

    try {
      const db = await this.getConnection();

      if (table && this.pendingPruneIds.size > 0) {
        await this.flushPendingPrunes();
      }

      let oldChunkIds: string[] = [];
      if (table && (await table.countRows()) > 0) {
        const existingRows = await table
          .query()
          .where(`fileName IN (${fileFilter})`)
          .select(['id'])
          .toArray();

        oldChunkIds = existingRows
          .map((row: any) => String(row.id || ''))
          .filter((id) => id.length > 0 && !newIdSet.has(id));
      }

      if (table) {
        this.writeReplacementJournal({
          fileNames,
          newChunkIds,
          oldChunkIds,
        });

        await table.add(records);
        logger.info('LanceDB', `Committed ${records.length} new records for ${fileNames.join(', ')}.`);
      } else {
        await db.createTable(this.tableName, records);
        logger.info('LanceDB', `Created table "${this.tableName}" with ${records.length} initial records.`);
        return;
      }

      if (oldChunkIds.length > 0) {
        const remainingOldIds = await this.deleteIdsInBatches(table, oldChunkIds);

        if (remainingOldIds.length > 0) {
          const deletedCount = oldChunkIds.length - remainingOldIds.length;

          if (deletedCount === 0) {
            const unrolledIds = await this.deleteIdsInBatches(table, newChunkIds);
            if (unrolledIds.length === 0) {
              this.clearReplacementJournal();
              throw new AppError(
                `[VectorStore] Failed to prune previous chunks for "${fileNames.join(', ')}". Rolled back new upload so the previous version remains intact.`,
                500
              );
            }
            // Partial rollback failure: track unrolled new IDs so they are cleaned up
            this.addPendingPruneIds(unrolledIds);
          }

          this.addPendingPruneIds(remainingOldIds);
          this.clearReplacementJournal();
          throw new AppError(
            `[VectorStore] Partial replacement failure for "${fileNames.join(', ')}": ${remainingOldIds.length} old chunk(s) could not be pruned and are queued for cleanup.`,
            500
          );
        }

        logger.info('LanceDB', `Pruned ${oldChunkIds.length} previous chunks for ${fileNames.join(', ')}.`);
      }

      this.clearReplacementJournal();
    } finally {
      this.invalidateChunkCache();
    }
  }

  public async getIndexedFiles(): Promise<string[]> {
    const table = await this.getTable();
    if (!table) return [];

    const results = await table.query().select(['fileName']).toArray();
    const files = new Set<string>();
    results.forEach((row: any) => {
      if (row.fileName) files.add(row.fileName);
    });
    return Array.from(files);
  }

 public async deleteFile(fileName: string): Promise<void> {
    this.ensurePendingPrunesLoaded();
    try {
      const table = await this.getTable();
      if (!table) return;

      const filter = `fileName = '${fileName.replace(/'/g, "''")}'`;
      let matchingIds: string[] = [];
      try {
        const rows = await table.query().where(filter).select(['id']).toArray();
        matchingIds = rows
          .map((row: any) => String(row.id || ''))
          .filter((id) => id.length > 0);
      } catch {
        // Proceed to delete even if pre-query failed
      }

      try {
        await table.delete(filter);
      } catch (err) {
        if (matchingIds.length > 0) {
          this.addPendingPruneIds(matchingIds);
        }
        throw err;
      }

      if (matchingIds.length > 0) {
        try {
          const remainingRows = await table.query().where(filter).select(['id']).toArray();
          const remainingIds = remainingRows
            .map((row: any) => String(row.id || ''))
            .filter((id) => id.length > 0);
          if (remainingIds.length > 0) {
            this.addPendingPruneIds(remainingIds);
          }
        } catch {
          // Ignore verification read error after delete
        }
      }

      logger.info('LanceDB', `Purged existing records for file: "${fileName}".`);
    } finally {
      this.invalidateChunkCache();
    }
  }

  public async getChunksByIds(ids: string[]): Promise<DocumentChunk[]> {
    if (!ids || ids.length === 0) return [];
    this.ensurePendingPrunesLoaded();

    const uniqueIds = Array.from(
      new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))
    );
    if (uniqueIds.length === 0) return [];

    if (this.cachedChunks !== null) {
      const wanted = new Set(uniqueIds);
      return this.cachedChunks.filter(
        (c) => wanted.has(c.id) && !this.pendingPruneIds.has(c.id)
      );
    }

    const table = await this.getTable();
    if (!table) return [];

    const results: DocumentChunk[] = [];
    for (let i = 0; i < uniqueIds.length; i += 50) {
      const batch = uniqueIds.slice(i, i + 50);
      const filter = batch.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
      const rows = await table
        .query()
        .select(VectorStoreService.TEXT_COLUMNS)
        .where(`id IN (${filter})`)
        .toArray();

      for (const row of rows as any[]) {
        const id = String(row.id || '');
        if (!id || this.pendingPruneIds.has(id)) continue;
        results.push({
          id,
          text: String(row.text || ''),
          fileName: String(row.fileName || ''),
          pageNumber: typeof row.pageNumber === 'number' ? row.pageNumber : 1,
          endPageNumber: typeof row.endPageNumber === 'number' ? row.endPageNumber : row.pageNumber,
          chunkIndex: typeof row.chunkIndex === 'number' ? row.chunkIndex : 0,
          sectionTitle: row.sectionTitle ? String(row.sectionTitle) : undefined,
          contentType: row.contentType ? row.contentType : 'paragraph',
        });
      }
    }

    return results;
  }

  public async getAllChunks(selectedFiles?: string[]): Promise<DocumentChunk[]> {
    this.ensurePendingPrunesLoaded();
    const table = await this.getTable();
    if (!table) return [];

    if (this.pendingPruneIds.size > 0) {
      await this.flushPendingPrunes();
    }

    const hasFilter = Array.isArray(selectedFiles) && selectedFiles.length > 0;
    const filterPending = (items: DocumentChunk[]) =>
      this.pendingPruneIds.size === 0
        ? items
        : items.filter((c) => !this.pendingPruneIds.has(c.id));

    if (!hasFilter && this.cachedChunks !== null) {
      return filterPending(this.cachedChunks);
    }

    if (hasFilter && this.cachedChunks !== null) {
      const fileSet = new Set(selectedFiles);
      return filterPending(this.cachedChunks.filter((chunk) => fileSet.has(chunk.fileName)));
    }

    const generationAtStart = this.cacheGeneration;

    try {
      let queryBuilder = table.query().select(VectorStoreService.TEXT_COLUMNS);

      if (hasFilter) {
        const safeFilterList = selectedFiles
          .map((f) => `'${f.replace(/'/g, "''")}'`)
          .join(', ');
        queryBuilder = queryBuilder.where(`fileName IN (${safeFilterList})`);
      }

      const rawRecords = await queryBuilder.toArray();

      const chunks: DocumentChunk[] = rawRecords
        .map((row: any) => ({
          id: String(row.id || ''),
          text: String(row.text || ''),
          fileName: String(row.fileName || ''),
          pageNumber: typeof row.pageNumber === 'number' ? row.pageNumber : 1,
          endPageNumber: typeof row.endPageNumber === 'number' ? row.endPageNumber : row.pageNumber,
          chunkIndex: typeof row.chunkIndex === 'number' ? row.chunkIndex : 0,
          sectionTitle: row.sectionTitle ? String(row.sectionTitle) : undefined,
          contentType: row.contentType ? row.contentType : 'paragraph',
        }))
        .filter((chunk) => !this.pendingPruneIds.has(chunk.id));

      if (!hasFilter && generationAtStart === this.cacheGeneration) {
        const approxBytes = chunks.reduce((sum, c) => sum + c.text.length * 2, 0);
        if (
          chunks.length <= VectorStoreService.MAX_CACHED_CHUNKS &&
          approxBytes <= VectorStoreService.MAX_CACHE_BYTES
        ) {
          this.cachedChunks = chunks;
        }
      }

      return chunks;
    } catch (error) {
      logger.error('VectorStore', 'Error in getAllChunks:', error);
      return [];
    }
  }

  public async search(
    queryEmbedding: number[],
    topK: number = 6,
    minScore: number = 0.05,
    selectedFiles?: string[]
  ): Promise<SearchResult[]> {
    if (!isValidVector(queryEmbedding)) {
      logger.warn('VectorStore', 'Search skipped: queryEmbedding contains non-finite numbers or is empty.');
      return [];
    }

    this.ensurePendingPrunesLoaded();

    const table = await this.getTable();
    if (!table) return [];

    const normalizedQuery = normalizeVector(queryEmbedding);
    if (!normalizedQuery) {
      logger.warn('VectorStore', 'Search skipped: query vector has zero magnitude.');
      return [];
    }

    const storedDim = await this.getStoredDimension(table);
    if (storedDim !== null && storedDim !== normalizedQuery.length) {
      throw new AppError(
        `[VectorStore] Dimension conflict: stored documents use ${storedDim}D vectors, but the query embedding is ${normalizedQuery.length}D. ` +
          `The embedding model has changed since the documents were indexed. Switch back to the original model, or delete ALL documents and upload them again.`,
        409
      );
    }

    let queryBuilder = (table.search(normalizedQuery) as any)
      .distanceType('cosine')
      .limit(Math.max(topK * 2, 10));

    if (selectedFiles && selectedFiles.length > 0) {
      const fileFilter = selectedFiles
        .map((f) => `'${f.replace(/'/g, "''")}'`)
        .join(', ');

      queryBuilder = queryBuilder.where(`fileName IN (${fileFilter})`);
    }

    const results = await queryBuilder.toArray();

    const scoredResults: SearchResult[] = results
      .filter(
        (row: any) =>
          typeof row._distance === 'number' &&
          Number.isFinite(row._distance) &&
          row._distance >= 0 &&
          !this.pendingPruneIds.has(String(row.id || ''))
      )
      .map((row: any) => ({
        chunk: {
          id: row.id,
          text: row.text,
          fileName: row.fileName,
          pageNumber: row.pageNumber,
          endPageNumber: row.endPageNumber,
          chunkIndex: row.chunkIndex,
          sectionTitle: row.sectionTitle,
          contentType: row.contentType,
        },
        score: 1 / (1 + Math.max(0, row._distance)),
      }));

    return scoredResults
      .filter((item) => item.score >= minScore)
      .slice(0, topK);
  }
}

export const vectorStoreService = new VectorStoreService();