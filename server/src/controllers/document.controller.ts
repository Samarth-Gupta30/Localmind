import { Request, Response } from 'express';
import { ChunkingService, DocumentChunk } from '../services/chunking.service';
import { embeddingService } from '../services/embedding.service';
import { vectorStoreService } from '../services/vectorStore.service';
import { bm25Service } from '../services/bm25.service';
import {  handleControllerError } from '../utils/errorHandler';
import { logger } from '../utils/logger'; // or './logger' inside src/utils/

const chunkingService = new ChunkingService();

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.txt', '.md']);

function getFileExtension(fileName: string): string {
  const parts = fileName.split('.');
  return parts.length > 1 ? `.${parts.pop()!.toLowerCase()}` : '';
}

/**
 * Checks if a buffer starts with standard PDF magic bytes: %PDF- (0x25 0x50 0x44 0x46)
 */
function isValidPdfHeader(buffer: Buffer): boolean {
  if (buffer.length < 5) return false;
  return (
    buffer[0] === 0x25 && // %
    buffer[1] === 0x50 && // P
    buffer[2] === 0x44 && // D
    buffer[3] === 0x46 && // F
    buffer[4] === 0x2d    // -
  );
}

/**
 * Generates embeddings in controlled concurrent batches to prevent exhausting Ollama's HTTP thread pool.
 */
async function generateEmbeddingsInBatches(
  chunks: DocumentChunk[],
  service: typeof embeddingService,
  batchSize: number = 5
): Promise<number[][]> {
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map((chunk) => service.getEmbedding(chunk.text, 'search_document'))
    );
    allEmbeddings.push(...batchResults);
  }

  return allEmbeddings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Upload a document, extract text, chunk it, embed it, and index it in the vector store
// ─────────────────────────────────────────────────────────────────────────────
export async function uploadDocument(req: Request, res: Response): Promise<void> {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'No file uploaded.' });
      return;
    }

    if (file.size === 0 || !file.buffer || file.buffer.length === 0) {
      res.status(400).json({ error: 'The uploaded file is empty (0 bytes).' });
      return;
    }

    // 1️⃣ Validate file extension
    const ext = getFileExtension(file.originalname);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      res.status(400).json({
        error: `Unsupported file type "${ext}". Only PDF, TXT, and MD files are allowed.`,
      });
      return;
    }

    // 2️⃣ Validate PDF header (if PDF)
    if (ext === '.pdf' && !isValidPdfHeader(file.buffer)) {
      res.status(400).json({
        error: `The file "${file.originalname}" is corrupted or is not a valid PDF document.`,
      });
      return;
    }

logger.info('DocumentController', `Processing upload: ${file.originalname} (${file.size} bytes)`);
    // 3️⃣ Extract raw text from the file
    const extracted = await chunkingService.extractText(file.buffer, file.originalname);

    if (!extracted.text || extracted.text.trim().length === 0) {
      res.status(400).json({ error: 'The uploaded file appears to be empty or unreadable.' });
      return;
    }

    // 4️⃣ Chunk the extracted text
    const chunks = chunkingService.createChunks(extracted, file.originalname);
    if (!chunks || chunks.length === 0) {
      res.status(400).json({ error: 'Could not extract readable text chunks from this document.' });
      return;
    }

    // 5️⃣ Generate embeddings (batched)
    const embeddings = await generateEmbeddingsInBatches(chunks, embeddingService, 5);

    // 6️⃣ Add documents to the vector store (replaces any existing entry for the same file)
    try {
      await vectorStoreService.addDocuments(chunks, embeddings);
    } finally {
      // 7️⃣ Invalidate BM25 cache even if the write threw: a failed replace can
      // still leave the table partly changed, and a stale index is worse than a rebuild.
      bm25Service.invalidateCache();
    }

    res.json({
      message: 'Document uploaded and indexed successfully',
      fileName: file.originalname,
      size: file.size,
      chunkCount: chunks.length,
    });
 } catch (error) {
  handleControllerError(res, error, 'DocumentController');
}
}

// ─────────────────────────────────────────────────────────────────────────────
// List all indexed documents (files) in the vector store
// ─────────────────────────────────────────────────────────────────────────────
export async function listDocuments(_req: Request, res: Response): Promise<void> {
  try {
    const files = await vectorStoreService.getIndexedFiles();
    res.json({ files });
  } catch (error) {
    handleControllerError(res, error, 'DocumentController');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Delete a document from the vector store (and clear its BM25 entries)
// ─────────────────────────────────────────────────────────────────────────────
export async function deleteDocument(req: Request, res: Response): Promise<void> {
  try {
    const { fileName } = req.params;

    if (!fileName || typeof fileName !== 'string' || fileName.trim().length === 0) {
      res.status(400).json({ error: 'A valid fileName parameter is required.' });
      return;
    }

    const name = Array.isArray(fileName) ? fileName[0] : fileName;
    try {
      await vectorStoreService.deleteFile(name);
    } finally {
      // Ensure BM25 indexes are refreshed after removal (even on failure)
      bm25Service.invalidateCache();
    }

    res.json({ success: true, message: `Removed "${name}" from vector store.` });
  } catch (error) {
  handleControllerError(res, error, 'DocumentController');
}
}