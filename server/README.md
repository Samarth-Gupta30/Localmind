# LocalMind Server

Offline-first Node.js + TypeScript backend for local LLM chat, hybrid RAG (LanceDB + BM25 + cross-encoder reranking), and session-bound tool execution via Ollama.

## Offline Prerequisites

Before running offline, ensure:
1. The local Ollama daemon is reachable at `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`) with required models already pulled (e.g., `qwen2.5:1.5b` / `qwen2.5:3b` and `nomic-embed-text`).
2. Local cross-encoder reranker assets (`Xenova/ms-marco-MiniLM-L-6-v2`) are pre-cached locally (`env.allowRemoteModels = false` prevents remote downloads).
3. `eng.traineddata` is present locally for offline Tesseract OCR fallback.

## Architecture & Key Design Decisions

- **Centralized Config (`src/config/env.ts`):** Parses and validates `PORT`, `CLIENT_ORIGIN`, `OLLAMA_BASE_URL`, `DEFAULT_MODEL`, `EMBEDDING_MODEL`, `EMBEDDING_TIMEOUT_MS`, and `RAG_MIN_SCORE` in one place.
- **General Chat & RAG (`src/controllers/chat.controller.ts`):**
  - General chat validates incoming message roles/content/lengths, rejects client-supplied `system` messages, and prepends the server-built system prompt.
  - RAG combines sparse keyword search (`BM25Service` via `wink-bm25-text-search`) and dense vector search (`VectorStoreService` via LanceDB) with Reciprocal Rank Fusion (`rrf.ts`), followed by cross-encoder reranking (`Xenova/ms-marco-MiniLM-L-6-v2`).
  - Both stored and query embeddings are L2-normalized (`src/utils/vector.ts`) and queried with `cosine` distance (`score = 1 / (1 + distance)`). Dimension mismatches return `409 Conflict`.
  - Excerpts are fitted to the RAG token budget before building context and citations so citations match included evidence. Retrieval and rerank scores are ranking signals only—never answer-confidence percentages.
- **BM25 Loading & Cache Coordination (`src/services/bm25.service.ts`, `src/services/vectorStore.service.ts`):**
  - `BM25Service.ensureIndex()` checks `(collectionVersion, fileFilter)` before loading chunks, and `getChunksByIds()` fetches only matching chunk IDs.
  - `VectorStoreService` bounds its in-memory chunk cache (`MAX_CACHED_CHUNKS = 5000`, `MAX_CACHE_BYTES = 20MB`) and bumps `cacheGeneration` on mutations.
- **Failure-Safe Document Replacement (`src/services/vectorStore.service.ts`):**
  - Uses Append-then-Prune: old IDs are read first, new records are added, and old IDs are pruned afterward.
  - If pruning fails before any old batch is deleted, new records are rolled back. If pruning fails partway through, unpruned old IDs are persisted to `.pending-prune-ids.json` in `storageDir`, hidden from reads, and reconciled via `flushPendingPrunes()`.
- **Document Ingestion & OCR Fallback (`src/services/chunking.service.ts`):**
  - Supports `.pdf`, `.txt`, and `.md` (10MB Multer limit via `handleUploadMiddleware`, returning JSON `413`/`400` on upload errors).
  - PDFs with low extracted text density (`totalChars < 50`, `avgCharsPerPage < 40`, or `>= 40%` sparse pages under 30 chars) fall back to local Tesseract OCR (`eng.traineddata`), capped at `MAX_OCR_PAGES = 30`, `25s` per page, `120s` total budget, and up to `2` concurrent OCR jobs.
  - Password-protected and malformed PDFs fail fast with `400`.
- **SSE Streaming & Cancellation (`src/utils/sse.ts`, `src/services/ollama.service.ts`, `src/services/selfHealing.service.ts`, `src/services/embedding.service.ts`):**
  - Hooks `AbortController` to response lifecycle events (`close`/`finish`) and propagates `AbortSignal` across routing, embeddings, retrieval, reranking, and Ollama streaming so aborted streams do not emit `done`.
- **Context Window Management (`src/utils/contextWindow.ts`):**
  - Preserves the system prompt and latest user message, trims older `(user, assistant)` pairs, and truncates oversized system/user messages to fit `maxTokens` (using heuristic token estimates, not exact BPE counts).
- **Tool Approval & Filesystem Checks (`src/controllers/agent.controller.ts`, `src/services/tool.service.ts`):**
  - Tool execution requires a single-use, 5-minute UUID approval token bound to the `localmind_agent_session` cookie; server-stored arguments are used rather than client-supplied args. In-memory token storage is single-process and resets on server restart.
  - `list_directory_safe` checks null bytes, path traversal, and symlinks (`lstatSync` / `realpathSync`) in user-space Node.js; it is not an OS-level sandbox and remains subject to TOCTOU races under concurrent filesystem mutations.

## Error Handling & Observability

- **Categorized Errors (`src/utils/errorHandler.ts`):** Converts `ZodError` to HTTP `400` (`VALIDATION_ERROR`), attaches HTTP status codes and categories on `AppError`, exposes operational messages, and masks unexpected `500` errors.
- **Redacted Logging (`src/utils/logger.ts`):** Redacts sensitive object keys and string occurrences including `localmind_agent_session`, `lm_agent_sid`, `approvalToken`, `sessionId`, and `Bearer` tokens.
- **Health & Lifecycle (`src/index.ts`):** `GET /api/health` checks SQLite, LanceDB, and Ollama (including configured chat/embedding model presence), returning `200 online` or `503 degraded`. `SIGINT`/`SIGTERM` close HTTP, SQLite, and LanceDB cleanly.

## Scripts

- `npm run dev` — Start development server with `tsx watch`
- `npm run build` — Compile TypeScript (`tsc`)
- `npm test` — Run all `node:test` suites in `test/*.test.ts`
- `npm start` — Run compiled `dist/index.js`