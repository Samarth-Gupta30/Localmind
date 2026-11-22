import { PDFParse } from 'pdf-parse';
import crypto from 'crypto';
import { createWorker } from 'tesseract.js';
import path from 'node:path';
import fs from 'node:fs';
import { AppError } from '../utils/errorHandler';
import { logger } from '../utils/logger';

export type ChunkContentType = 'paragraph' | 'table' | 'question-answer' | 'list' | 'definition';

export interface DocumentChunk {
  id: string;
  fileName: string;
  pageNumber: number;
  endPageNumber?: number;
  chunkIndex: number;
  text: string;
  sectionTitle?: string;
  contentType?: ChunkContentType;
}

export interface ExtractedPage {
  pageNumber: number;
  text: string;
}

export interface StructuralUnit {
  text: string;
  pageNumber: number;
  endPageNumber: number;
  sectionTitle?: string;
  contentType: ChunkContentType;
}

export function resolveOfflineTrainedDataDir(): string | null {
  const candidatePaths = [
    process.cwd(),
    path.resolve(process.cwd(), '..'),
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '..', '..'),
  ];

  for (const p of candidatePaths) {
    if (fs.existsSync(path.join(p, 'eng.traineddata'))) {
      return p;
    }
  }
  return null;
}

export class ChunkingService {
  private readonly TARGET_TOKENS = 500;
  private readonly MAX_TOKENS = 700;
  private readonly OVERLAP_TOKENS = 60;

  private readonly CHARS_PER_TOKEN = 4;
  private readonly TARGET_CHARS = this.TARGET_TOKENS * this.CHARS_PER_TOKEN;
  private readonly MAX_CHARS = this.MAX_TOKENS * this.CHARS_PER_TOKEN;
  private readonly OVERLAP_CHARS = this.OVERLAP_TOKENS * this.CHARS_PER_TOKEN;

  private static readonly MAX_OCR_PAGES = 30;
  private static readonly PER_PAGE_TIMEOUT_MS = 25_000;
  private static readonly TOTAL_OCR_BUDGET_MS = 120_000;

  private static activeOcrJobs = 0;
  private static readonly MAX_CONCURRENT_OCR = 2;
  private static readonly ocrWaitQueue: Array<() => void> = [];

  private static async acquireOcrSlot(): Promise<void> {
    if (ChunkingService.activeOcrJobs < ChunkingService.MAX_CONCURRENT_OCR) {
      ChunkingService.activeOcrJobs++;
      return;
    }
    await new Promise<void>((resolve) => {
      ChunkingService.ocrWaitQueue.push(resolve);
    });
    ChunkingService.activeOcrJobs++;
  }

  private static releaseOcrSlot(): void {
    ChunkingService.activeOcrJobs = Math.max(0, ChunkingService.activeOcrJobs - 1);
    const next = ChunkingService.ocrWaitQueue.shift();
    if (next) next();
  }

  private static async createOfflineWorker(langPath: string) {
    return await createWorker('eng', 1, {
      langPath,
      gzip: false,
    });
  }

  public async extractText(
    fileBuffer: Buffer,
    fileName: string
  ): Promise<{ text: string; pageCount: number; pages: ExtractedPage[] }> {
    const ext = fileName.split('.').pop()?.toLowerCase();

    if (ext === 'pdf') {
      return this.extractPdfPageByPage(fileBuffer);
    }

    const fullText = fileBuffer.toString('utf-8');
    const pages: ExtractedPage[] = [{ pageNumber: 1, text: fullText }];
    return {
      text: fullText,
      pageCount: 1,
      pages,
    };
  }

  private async extractPdfPageByPage(
    buffer: Buffer
  ): Promise<{ text: string; pageCount: number; pages: ExtractedPage[] }> {
    let parser: PDFParse | undefined;

    try {
      parser = new PDFParse({ data: buffer });
      const data = await parser.getText();

      const rawPages: ExtractedPage[] = (data.pages ?? []).map((page, idx) => ({
        pageNumber: idx + 1,
        text: (page.text ?? '').trim(),
      }));

      const totalChars = rawPages.reduce((acc, page) => acc + page.text.length, 0);
      const pageCount = rawPages.length;
      const avgCharsPerPage = pageCount > 0 ? totalChars / pageCount : 0;

      const sparsePages = rawPages.filter((page) => page.text.length < 30);

      const isCompletelyScanned = pageCount === 0 || totalChars < 50 || avgCharsPerPage < 40;
      const hasSignificantScannedPages = pageCount > 0 && sparsePages.length / pageCount >= 0.4;

      if (isCompletelyScanned || hasSignificantScannedPages) {
        logger.warn(
          'ChunkingService',
          `Scanned or mixed PDF detected (pages=${pageCount}, sparsePages=${sparsePages.length}, avgChars=${avgCharsPerPage.toFixed(1)}). Running local OCR fallback.`
        );
        return await this.performOcrFallback(rawPages, buffer);
      }

      return {
        text: rawPages.map((page) => `--- PAGE ${page.pageNumber} ---\n${page.text}`).join('\n\n'),
        pageCount,
        pages: rawPages,
      };
    } catch (err: any) {
      const errMsg = String(err?.message || err).toLowerCase();

      if (
        errMsg.includes('password') ||
        errMsg.includes('encrypted') ||
        err?.name === 'PasswordException'
      ) {
        throw new AppError(
          'This PDF is password-protected or encrypted. Please remove the password before uploading.',
          400
        );
      }

      if (
        err?.name === 'InvalidPDFException' ||
        err?.name === 'FormatError' ||
        errMsg.includes('invalid pdf') ||
        errMsg.includes('bad xref') ||
        errMsg.includes('unexpected end of file') ||
        errMsg.includes('formaterror')
      ) {
        throw new AppError(
          'This PDF appears to be malformed or corrupted and cannot be processed.',
          400
        );
      }

      logger.warn('ChunkingService', 'Native PDF text extraction failed; attempting OCR fallback.', err);
      return await this.performOcrFallback([], buffer);
    } finally {
      try {
        const maybeDestroy = parser as unknown as { destroy?: () => Promise<void> | void } | undefined;
        await maybeDestroy?.destroy?.();
      } catch {
        // Cleanup must not hide the extraction result/error.
      }
    }
  }

  private async performOcrFallback(
    rawPages: ExtractedPage[],
    buffer: Buffer
  ): Promise<{ text: string; pageCount: number; pages: ExtractedPage[] }> {
    await ChunkingService.acquireOcrSlot();

    let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
    let parser: PDFParse | undefined;
    const ocrStartTime = Date.now();

    try {
      const offlineLangPath = resolveOfflineTrainedDataDir();
      if (!offlineLangPath) {
        throw new AppError(
          'Offline OCR language data (eng.traineddata) was not found. Local OCR requires bundled eng.traineddata without network downloads.',
          400
        );
      }

      parser = new PDFParse({ data: buffer });

      const pageCapList = Array.from({ length: ChunkingService.MAX_OCR_PAGES }, (_, i) => i + 1);
      const screenshots = await parser.getScreenshot({
        scale: 1.5,
        imageBuffer: true,
        imageDataUrl: false,
        partial: pageCapList,
      } as any);

      if (!screenshots?.pages || screenshots.pages.length === 0) {
        throw new AppError('Could not render PDF pages for OCR scanning.', 400);
      }

      logger.info('OCR Engine', `Initializing offline Tesseract worker with langPath: ${offlineLangPath}`);
      worker = await ChunkingService.createOfflineWorker(offlineLangPath);

      const pages: ExtractedPage[] = [];
      const pagesToProcess = screenshots.pages.slice(0, ChunkingService.MAX_OCR_PAGES);

      if (screenshots.pages.length > ChunkingService.MAX_OCR_PAGES) {
        logger.warn(
          'OCR Engine',
          `PDF has ${screenshots.pages.length} pages. Capping OCR processing to first ${ChunkingService.MAX_OCR_PAGES} pages to prevent memory exhaustion.`
        );
      }

      for (const screenshot of pagesToProcess) {
        if (Date.now() - ocrStartTime > ChunkingService.TOTAL_OCR_BUDGET_MS) {
          logger.warn('OCR Engine', 'Total OCR time budget exceeded; stopping early.');
          break;
        }

        const pageNum = screenshot.pageNumber;
        const existingText = rawPages.find((page) => page.pageNumber === pageNum)?.text?.trim() ?? '';

        if (existingText.length >= 40) {
          logger.info('OCR Engine', `Page ${pageNum}: retained native text (${existingText.length} chars).`);
          pages.push({ pageNumber: pageNum, text: existingText });
          continue;
        }

        if (!screenshot.data || screenshot.data.length === 0) {
          logger.warn('OCR Engine', `Page ${pageNum}: no image data rendered, keeping existing text.`);
          pages.push({ pageNumber: pageNum, text: existingText });
          continue;
        }

        let timer: NodeJS.Timeout | undefined;
        let recognizedText = '';
        let pageTimedOut = false;

        try {
          const activeWorker = worker;
          const ocrPromise = activeWorker.recognize(Buffer.from(screenshot.data));
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              pageTimedOut = true;
              reject(new Error(`OCR timed out on page ${pageNum}`));
            }, ChunkingService.PER_PAGE_TIMEOUT_MS);
          });

          const result = await Promise.race([ocrPromise, timeoutPromise]);
          recognizedText = (result.data.text ?? '')
            .replace(/\r\n/g, '\n')
            .replace(/(\w+)-\n(\w+)/g, '$1$2')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        } catch (pageErr) {
          logger.warn('OCR Engine', `OCR failed or timed out on page ${pageNum}:`, pageErr);
          recognizedText = existingText;

          // Recreate worker after a timeout so a hung worker does not stall remaining pages.
          if (pageTimedOut && worker) {
            try {
              await worker.terminate();
            } catch {}
            worker = await ChunkingService.createOfflineWorker(offlineLangPath);
          }
        } finally {
          if (timer) clearTimeout(timer);
          (screenshot as any).data = undefined;
        }

        const finalText = recognizedText.length > 0 ? recognizedText : existingText;

        logger.info('OCR Engine', `Page ${pageNum}: extracted ${finalText.length} characters.`);
        pages.push({
          pageNumber: pageNum,
          text: finalText,
        });
      }

      const totalExtracted = pages.reduce((sum, p) => sum + p.text.trim().length, 0);
      if (pages.length === 0 || totalExtracted === 0) {
        throw new AppError(
          'OCR detected no readable text. The document may be completely blank, password-protected, or in an unsupported language.',
          400
        );
      }

      return {
        text: pages.map((page) => `--- PAGE ${page.pageNumber} ---\n${page.text}`).join('\n\n'),
        pageCount: pages.length,
        pages,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      logger.error('OCR Engine', 'Scanned PDF OCR error:', error);
      throw new AppError(
        `Scanned PDF OCR failed: ${error instanceof Error ? error.message : String(error)}`,
        400
      );
    } finally {
      if (worker) {
        try {
          await worker.terminate();
        } catch {}
      }
      if (parser) {
        try {
          await parser.destroy();
        } catch {}
      }
      ChunkingService.releaseOcrSlot();
    }
  }

  public createChunks(
    fileData: { text: string; pageCount: number; pages?: ExtractedPage[] } | string,
    fileName: string,
    documentIdPrefix?: string
  ): DocumentChunk[] {
    let pages: ExtractedPage[] = [];

    if (typeof fileData === 'string') {
      if (!fileData || fileData.trim().length === 0) return [];
      pages = [{ pageNumber: 1, text: fileData }];
    } else {
      if (fileData.pages && fileData.pages.length > 0) {
        pages = fileData.pages;
      } else if (fileData.text && fileData.text.trim().length > 0) {
        pages = [{ pageNumber: 1, text: fileData.text }];
      } else {
        return [];
      }
    }

    const units = this.segmentDocument(pages);
    return this.assembleChunks(units, fileName, documentIdPrefix);
  }

  private segmentDocument(pages: ExtractedPage[]): StructuralUnit[] {
    const units: StructuralUnit[] = [];

    for (const page of pages) {
      if (!page.text || page.text.trim().length === 0) continue;

      const lines = page.text.split('\n').map((l) => l.trim()).filter(Boolean);
      let currentSectionTitle = '';
      let i = 0;

      while (i < lines.length) {
        const line = lines[i];

        if (this.isHeading(line)) {
          currentSectionTitle = line.replace(/^#+\s*/, '');
          i++;
          continue;
        }

        if (this.isQuestionStart(line)) {
          const qaBlock = this.extractQABlock(lines, i);
          units.push({
            text: qaBlock.text,
            pageNumber: page.pageNumber,
            endPageNumber: page.pageNumber,
            sectionTitle: currentSectionTitle,
            contentType: 'question-answer',
          });
          i = qaBlock.nextIndex;
          continue;
        }

        if (this.isTableStart(lines, i)) {
          const tableBlock = this.extractTableBlock(lines, i);
          units.push({
            text: tableBlock.text,
            pageNumber: page.pageNumber,
            endPageNumber: page.pageNumber,
            sectionTitle: currentSectionTitle,
            contentType: 'table',
          });
          i = tableBlock.nextIndex;
          continue;
        }

        if (this.isDefinition(line)) {
          units.push({
            text: line,
            pageNumber: page.pageNumber,
            endPageNumber: page.pageNumber,
            sectionTitle: currentSectionTitle,
            contentType: 'definition',
          });
          i++;
          continue;
        }

        if (this.isListItem(line)) {
          const listBlock = this.extractListBlock(lines, i);
          units.push({
            text: listBlock.text,
            pageNumber: page.pageNumber,
            endPageNumber: page.pageNumber,
            sectionTitle: currentSectionTitle,
            contentType: 'list',
          });
          i = listBlock.nextIndex;
          continue;
        }

        const paraBlock = this.extractParagraphBlock(lines, i);
        units.push({
          text: paraBlock.text,
          pageNumber: page.pageNumber,
          endPageNumber: page.pageNumber,
          sectionTitle: currentSectionTitle,
          contentType: 'paragraph',
        });
        i = paraBlock.nextIndex;
      }
    }

    return units;
  }

  private isHeading(line: string): boolean {
    return /^#+\s+/.test(line) || /^(SECTION|CHAPTER|MODULE)\s+\d+/i.test(line);
  }

  private isQuestionStart(line: string): boolean {
    return /^(Q\d+[:.]|Question\s*\d+[:.]|\d+[\.\)]\s+What|\d+[\.\)]\s+How|\d+[\.\)]\s+Explain|\d+[\.\)]\s+Define)/i.test(
      line
    );
  }

  private extractQABlock(lines: string[], startIndex: number): { text: string; nextIndex: number } {
    let blockText = lines[startIndex];
    let curr = startIndex + 1;

    while (curr < lines.length) {
      const line = lines[curr];
      if (this.isQuestionStart(line) || this.isHeading(line) || this.isTableStart(lines, curr)) {
        break;
      }
      blockText += '\n' + line;
      curr++;
      if (/^(Ans|Answer)[:.]/i.test(line) && curr < lines.length && this.isQuestionStart(lines[curr])) {
        break;
      }
    }
    return { text: blockText, nextIndex: curr };
  }

  private isTableStart(lines: string[], idx: number): boolean {
    const line = lines[idx];
    if (line.includes('|') || line.includes('\t')) return true;
    if (idx + 1 < lines.length) {
      const nextLine = lines[idx + 1];
      if (line.split(/\s{2,}/).length >= 2 && nextLine.split(/\s{2,}/).length >= 2) {
        return true;
      }
    }
    return false;
  }

  private extractTableBlock(lines: string[], startIndex: number): { text: string; nextIndex: number } {
    let rows: string[] = [];
    let curr = startIndex;

    while (curr < lines.length) {
      const line = lines[curr];
      if (line.includes('|') || line.includes('\t') || line.split(/\s{2,}/).length >= 2) {
        rows.push(line);
        curr++;
      } else {
        break;
      }
    }
    return { text: rows.join('\n'), nextIndex: curr };
  }

  private isDefinition(line: string): boolean {
    return /^[A-Z][a-zA-A0-9\s\-]{2,30}\s*[:\-]\s+[A-Z0-9]/.test(line) && !line.toLowerCase().startsWith('http');
  }

  private isListItem(line: string): boolean {
    return /^(\d+[\.\)]|[-*•])\s+/.test(line);
  }

  private extractListBlock(lines: string[], startIndex: number): { text: string; nextIndex: number } {
    let listText = lines[startIndex];
    let curr = startIndex + 1;

    while (curr < lines.length) {
      const line = lines[curr];
      if (this.isListItem(line) || (!this.isHeading(line) && !this.isQuestionStart(line) && line.length > 0)) {
        listText += '\n' + line;
        curr++;
      } else {
        break;
      }
    }
    return { text: listText, nextIndex: curr };
  }

  private extractParagraphBlock(lines: string[], startIndex: number): { text: string; nextIndex: number } {
    let paraText = lines[startIndex];
    let curr = startIndex + 1;

    while (curr < lines.length) {
      const line = lines[curr];
      if (
        this.isHeading(line) ||
        this.isQuestionStart(line) ||
        this.isTableStart(lines, curr) ||
        this.isListItem(line)
      ) {
        break;
      }
      paraText += ' ' + line;
      curr++;
    }
    return { text: paraText, nextIndex: curr };
  }

  private assembleChunks(units: StructuralUnit[], fileName: string, docPrefix?: string): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    const prefix = docPrefix ? docPrefix : fileName;

    let currentChunkText = '';
    let currentStartPage = 1;
    let currentEndPage = 1;
    let currentSection = '';
    let currentContentType: ChunkContentType = 'paragraph';

    const flushChunk = () => {
      if (currentChunkText.trim().length === 0) return;

      const chunkIndex = chunks.length;
      const randomSuffix = crypto.randomBytes(4).toString('hex');
      const cleanId = `${prefix}-chunk-${chunkIndex}-${randomSuffix}`;

      let formattedText = currentChunkText.trim();
      if (currentSection && !formattedText.includes(currentSection)) {
        formattedText = `[Section: ${currentSection}]\n${formattedText}`;
      }

      chunks.push({
        id: cleanId,
        fileName,
        pageNumber: currentStartPage,
        endPageNumber: currentEndPage,
        chunkIndex,
        text: formattedText,
        sectionTitle: currentSection || undefined,
        contentType: currentContentType,
      });

      if (this.OVERLAP_CHARS > 0 && currentChunkText.length > this.OVERLAP_CHARS) {
        const overlapSlice = currentChunkText.slice(-this.OVERLAP_CHARS);
        const safeSpace = overlapSlice.indexOf(' ');
        currentChunkText = safeSpace !== -1 ? overlapSlice.slice(safeSpace + 1) : overlapSlice;
        currentStartPage = currentEndPage;
      } else {
        currentChunkText = '';
      }
    };

    for (const unit of units) {
      if (unit.text.length > this.MAX_CHARS) {
        flushChunk();
        const splitUnits = this.splitOversizedUnit(unit);
        for (const subUnit of splitUnits) {
          currentStartPage = subUnit.pageNumber;
          currentEndPage = subUnit.endPageNumber;
          currentSection = subUnit.sectionTitle || '';
          currentContentType = subUnit.contentType;
          currentChunkText = subUnit.text;
          flushChunk();
        }
        continue;
      }

      if (currentChunkText.length + unit.text.length > this.TARGET_CHARS && currentChunkText.length > 0) {
        flushChunk();
      }

      if (currentChunkText.length === 0) {
        currentStartPage = unit.pageNumber;
        currentSection = unit.sectionTitle || '';
        currentContentType = unit.contentType;
      }

      currentEndPage = unit.endPageNumber;
      if (unit.contentType !== 'paragraph') {
        currentContentType = unit.contentType;
      }
      currentChunkText += (currentChunkText.length > 0 ? '\n\n' : '') + unit.text;
    }

    flushChunk();
    return chunks;
  }

  private splitOversizedUnit(unit: StructuralUnit): StructuralUnit[] {
    const results: StructuralUnit[] = [];

    if (unit.contentType === 'table') {
      const rows = unit.text.split('\n');
      const header = rows[0] || '';
      let currentTableText = header;

      for (let r = 1; r < rows.length; r++) {
        if (currentTableText.length + rows[r].length > this.TARGET_CHARS) {
          results.push({ ...unit, text: currentTableText });
          currentTableText = header + '\n' + rows[r];
        } else {
          currentTableText += '\n' + rows[r];
        }
      }
      if (currentTableText.trim().length > 0) {
        results.push({ ...unit, text: currentTableText });
      }
      return results;
    }

    const sentences = unit.text.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [unit.text];
    let currentBlock = '';

    for (const sentence of sentences) {
      if (currentBlock.length + sentence.length > this.TARGET_CHARS && currentBlock.length > 0) {
        results.push({ ...unit, text: currentBlock.trim() });
        currentBlock = sentence;
      } else {
        currentBlock += sentence;
      }
    }

    if (currentBlock.trim().length > 0) {
      results.push({ ...unit, text: currentBlock.trim() });
    }

    return results;
  }
}