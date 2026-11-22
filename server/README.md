# LocalMind Server

The server is a Node.js, Express 5, and TypeScript backend for LocalMind. It coordinates local Ollama inference, document ingestion, hybrid retrieval, SSE streaming, preference persistence, and a limited set of human-approved agent tools.

## Responsibilities

- Expose chat, document, agent, preference, and health endpoints.
- Validate requests and construct server-controlled prompts.
- Extract, chunk, embed, index, retrieve, and rerank uploaded documents.
- Stream model output and terminal metadata to the frontend.
- Enforce approval-token checks before executing agent tools.
- Persist user preferences in SQLite and document vectors in LanceDB.

## Technology

| Dependency | Responsibility |
|---|---|
| Express 5 | HTTP API and middleware |
| TypeScript / tsx | Type checking and development execution |
| Zod | Request and agent-output validation |
| Ollama HTTP API | Local chat generation and embedding generation |
| `@lancedb/lancedb` | Vector database |
| `wink-bm25-text-search`, `wink-nlp-utils` | BM25 keyword retrieval and text processing |
| `@xenova/transformers` | Local cross-encoder reranker |
| `pdf-parse` | PDF text extraction |
| `tesseract.js` | OCR fallback for scanned or mixed PDFs |
| Multer | In-memory multipart upload handling |
| `better-sqlite3` | Local preferences database |
| `dotenv` | Environment configuration |
| `cors` | Frontend-origin access policy |

## Source structure

```text
server/src/
├── config/env.ts
├── controllers/
│   ├── agent.controller.ts
│   ├── chat.controller.ts
│   ├── document.controller.ts
│   └── preference.controller.ts
├── routes/
│   ├── agent.routes.ts
│   ├── chat.routes.ts
│   ├── document.routes.ts
│   └── preference.routes.ts
├── services/
│   ├── bm25.service.ts
│   ├── chunking.service.ts
│   ├── embedding.service.ts
│   ├── ollama.service.ts
│   ├── preference.service.ts
│   ├── reranker.service.ts
│   ├── selfHealing.service.ts
│   ├── tool.service.ts
│   └── vectorStore.service.ts
├── types/
└── utils/
    ├── agentSession.ts
    ├── collectionSignature.ts
    ├── contextWindow.ts
    ├── errorHandler.ts
    ├── guardrails.ts
    ├── logger.ts
    ├── rrf.ts
    ├── sse.ts
    ├── telemetry.ts
    └── vector.ts
```

Automated tests are in `server/test/` and use Node's test runner through `tsx`.

## API reference

All routes are mounted below `/api`.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | Checks backend dependency readiness |
| POST | `/api/chat/stream` | Streams general chat output |
| POST | `/api/chat/rag/stream` | Streams document-grounded output and citations |
| POST | `/api/chat/agent/stream` | Streams agent reasoning/action status and response events |
| POST | `/api/chat/agent/tools/execute` | Consumes an approval token and executes its server-stored tool request |
| POST | `/api/documents/upload` | Uploads and indexes a document |
| GET | `/api/documents/` | Lists indexed documents |
| DELETE | `/api/documents/:fileName` | Removes a document from the index |
| GET | `/api/preferences/` | Reads preferences |
| PATCH | `/api/preferences/` | Validates and updates preferences |
| DELETE | `/api/preferences/` | Resets preferences |

The upload endpoint accepts a single multipart field named `file` and limits uploads to 10 MiB. The application supports PDF, TXT, and Markdown documents; malformed or password-protected PDFs are rejected.

## RAG pipeline

1. **Ingestion:** `document.controller.ts` receives a file in Multer memory storage and passes its buffer to `ChunkingService`.
2. **Extraction:** PDF pages are extracted with `pdf-parse`; TXT and Markdown content are decoded as UTF-8.
3. **OCR fallback:** PDFs with very sparse extracted text, or extraction failures eligible for fallback, are processed with local Tesseract OCR. OCR is bounded by page, per-page time, total time, and concurrency limits. The English trained-data file is resolved locally.
4. **Chunking:** `ChunkingService` identifies structural content units and produces chunks with file name, page range, chunk index, optional section title, and content type. Its current approximate target is 500 tokens, maximum 700, and overlap 60 tokens (using a character/token heuristic).
5. **Embeddings:** `EmbeddingService` requests embeddings from the configured Ollama embedding model. Stored/query vectors are normalized by the vector utility before cosine-distance retrieval.
6. **Storage:** `VectorStoreService` persists vector records in LanceDB. It also maintains a bounded in-memory chunk cache and handles collection versioning, dimension checks, and failure-aware document replacement.
7. **Hybrid retrieval:** BM25 keyword candidates and dense vector candidates are combined with Reciprocal Rank Fusion in `utils/rrf.ts`.
8. **Reranking:** `RerankerService` uses the local `Xenova/ms-marco-MiniLM-L-6-v2` cross-encoder. Remote model downloads are disabled; if the local reranker cannot load or reranking fails, the service can retain the original candidate order.
9. **Context construction:** selected excerpts are fitted to a context budget. The backend aligns citation metadata with the evidence actually included in the final prompt.
10. **Generation:** `OllamaService` streams the answer. RAG responses include citations corresponding to the final included excerpts.

Retrieval and reranker scores are ranking signals. They are not calibrated answer-confidence percentages.

## Ollama and model configuration

The backend communicates with Ollama at `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`). The configured default chat model is `qwen2.5:1.5b`; the frontend model selector also offers `qwen2.5:3b`. The default embedding model is `nomic-embed-text`.

Required model tags must already be available in the local Ollama installation for offline operation. The backend does not provide a cloud inference fallback.

## Agent routing and tool execution

Agent mode sends the user request and conversation history to the agent controller. The model is asked to produce a structured routing decision; the result is parsed and validated against a Zod schema and the server's tool whitelist.

The currently exposed tools are:

- `get_system_specs`
- `list_directory_safe`
- `calculate_math`
- `get_current_time`

A tool that requires approval is represented to the client as a pending action. The server creates a UUID approval token and stores the selected tool name, arguments, session ID, and expiry in an in-memory Map. The frontend receives the token and asks the user to approve or deny the action.

On approval, the client posts the token to `/api/chat/agent/tools/execute`. The server validates the token and browser session, checks its five-minute expiry, deletes the token, and executes the server-stored arguments. Client-supplied tool arguments are not used as the authority for execution. A token is single-use. Pending tokens are process-local and are lost on server restart.

## Persistence

| Store | Data | Location / scope |
|---|---|---|
| LanceDB | Document chunks and embeddings | Backend storage directory under the server runtime |
| SQLite | User preferences | `server/data/preferences.db` |
| In-memory cache | Chunk lookup cache and pending approvals | Current backend process only |
| Browser localStorage | Chat sessions | Frontend browser; documented in [Client README](../client/README.md) |

The SQLite preference store enables WAL mode. Runtime databases and vector-store files are excluded by the repository `.gitignore`.

## SSE and telemetry

Chat and agent endpoints stream event frames using the backend SSE utilities. Abort signals are propagated through the relevant generation/retrieval stages so a disconnected or cancelled request can stop work and avoid emitting a normal completion event for an aborted stream.

Telemetry includes server-measured time to first token, total duration, generated token count, tokens per second, optional prompt token count, and a status (`completed`, `cancelled`, or `failed`). Generated token count and tokens-per-second are derived from Ollama generation metadata; unavailable values are represented as zero rather than estimated from text length.

## Environment variables

Create `server/.env` from `server/.env.example`. Do not commit real credentials or private values.

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP server port | `5000` |
| `CLIENT_ORIGIN` | Allowed frontend origin for CORS | `http://localhost:5173` |
| `OLLAMA_BASE_URL` | Ollama API base URL (`OLLAMA_URL` is also accepted as a fallback) | `http://127.0.0.1:11434` |
| `DEFAULT_MODEL` | Default chat model | `qwen2.5:1.5b` |
| `EMBEDDING_MODEL` | Ollama embedding model | `nomic-embed-text` |
| `RAG_MIN_SCORE` | Minimum retrieval score threshold | `0.05` |
| `EMBEDDING_TIMEOUT_MS` | Embedding request timeout | `60000` |

## Install, run, test

```bash
cd server
npm install
```

Copy `.env.example` to `.env`, configure the values if needed, ensure Ollama is running with the required models, and start the development server:

```bash
npm run dev
```

Available scripts:

```bash
npm run build       # Compile TypeScript to dist/
npm test            # Run test/*.test.ts using Node's test runner via tsx
npm start            # Run compiled dist/index.js
npm run test:reranker
npm run test:telemetry
```

The `start` script expects a successful build first. Start the frontend separately; see [Client README](../client/README.md).

## Known limitations

- Approval state is stored in process memory: it is single-process, non-persistent, and not shared across multiple backend instances.
- The filesystem tool's path checks are application-level and remain subject to time-of-check/time-of-use races; they are not an OS sandbox.
- Local reranker assets must be cached before fully offline use because remote downloads are disabled.
- OCR fallback requires the local trained-data file and is intentionally bounded; it is not a general-purpose OCR service.
- Context token budgeting uses estimates rather than exact tokenizer counts for every model.
- No general user-account authentication layer is implemented across all API routes.
