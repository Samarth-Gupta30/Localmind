# LocalMind Client

The client is a React and TypeScript single-page application built with Vite. It provides three conversation modes—general chat, document Q&A, and agent mode—and renders streamed responses, citations, tool-approval requests, and generation telemetry.

## Responsibilities

- Maintain the active conversation and saved browser-side sessions.
- Select general, document, or agent request flows.
- Upload and remove documents through the backend API.
- Consume backend Server-Sent Events (SSE) from a streamed `fetch` response.
- Display citations, tool approval prompts, tool results, and generation metrics.
- Read and update user preferences.

## Technology

| Technology | Use |
|---|---|
| React 19 | Component UI and state |
| TypeScript | Static typing |
| Vite | Development server and production build |
| Tailwind CSS 3 | Styling utilities |
| Lucide React | Icons |
| React Markdown | Markdown response rendering |
| remark-gfm | GitHub-flavored Markdown support |

The dependencies above are taken from `package.json`; the client does not use a separate state-management library.

## Source structure

```text
client/src/
├── App.tsx
├── config.ts
├── index.css
├── main.tsx
├── components/
│   ├── ActionApprovalModal.tsx
│   ├── CitationModal.tsx
│   ├── FileUploadZone.tsx
│   ├── MarkdownRenderer.tsx
│   ├── SettingsModal.tsx
│   ├── Sidebar.tsx
│   └── TelemetryHUD.tsx
├── hooks/
│   └── useSSEStream.ts
├── types/
│   └── chat.ts
└── utils/
    └── sseParser.ts
```

## Main components

| Component / module | Responsibility |
|---|---|
| `App.tsx` | Coordinates modes, sessions, preferences, uploads, citations, and approval actions |
| `Sidebar.tsx` | Session navigation, new/delete session actions, model selection, and settings entry point |
| `FileUploadZone.tsx` | Document selection and upload interaction in document mode |
| `MarkdownRenderer.tsx` | Renders assistant message Markdown and GFM content |
| `CitationModal.tsx` | Displays the selected citation's source excerpt and metadata |
| `ActionApprovalModal.tsx` | Presents a pending agent tool action for explicit approval or denial |
| `TelemetryHUD.tsx` | Displays generation metrics supplied by the backend |
| `SettingsModal.tsx` | Edits response preferences |
| `useSSEStream.ts` | Sends chat requests, consumes SSE events, manages stream state and cancellation |
| `sseParser.ts` | Parses SSE event frames from streamed response bytes |
| `types/chat.ts` | Shared frontend types for messages, sessions, citations, preferences, and telemetry |
| `config.ts` | Resolves and normalizes the backend API base URL |

## State and session management

The application uses React state and hooks in `App.tsx` and `useSSEStream.ts`. There is no Redux, Zustand, or other external global state library in the package dependencies.

Conversation sessions are serialized in browser `localStorage` under the key `offline_ai_sessions`. The active session ID is stored separately by the application. This persistence is browser-local; it is not a server-side account or cross-device synchronization mechanism.

User preferences are loaded from and saved to the backend. The current preference shape includes temperature, response style, default model, and maximum context turns.

## API communication

The API base URL is read from `VITE_API_URL`; if unset, the client uses `http://localhost:5000`. Trailing slashes are removed in `src/config.ts`.

| Method | Endpoint | Client use |
|---|---|---|
| GET | `/api/preferences` | Load preferences |
| PATCH | `/api/preferences` | Save preference changes |
| DELETE | `/api/preferences` | Reset preferences |
| POST | `/api/documents/upload` | Upload one document using multipart form data |
| GET | `/api/documents/` | Backend document listing endpoint; not required for local session persistence |
| DELETE | `/api/documents/:fileName` | Remove an uploaded document |
| POST | `/api/chat/stream` | General chat |
| POST | `/api/chat/rag/stream` | Document-grounded chat |
| POST | `/api/chat/agent/stream` | Agent mode |
| POST | `/api/chat/agent/tools/execute` | Submit an approval token to execute a pending tool action |

The agent-mode requests use `credentials: 'include'` so the browser sends the session cookie established by the backend. The client sends the approval token when the user approves; the backend retrieves the approved tool and arguments from its own pending-approval store.

## Streaming lifecycle

`useSSEStream.ts` uses `fetch()` with a `ReadableStream` response body rather than the browser `EventSource` API. It reads byte chunks, decodes them with `TextDecoder`, and passes the text to `createSSEParser()`.

The hook selects an endpoint according to the active conversation mode:

- `general` → `/api/chat/stream`
- `document` → `/api/chat/rag/stream`
- `agent` → `/api/chat/agent/stream`

The hook updates the assistant message as content events arrive and handles terminal events such as completion, errors, citations, metrics, and pending tool approvals. It keeps an `AbortController` for explicit stop actions and aborts an active request during hook cleanup.

## Agent approval and result rendering

When the agent stream reports a pending action, the hook exposes it as `pendingAction`. `App.tsx` passes the action details to `ActionApprovalModal.tsx`.

- Approve: the client posts the approval token to `/api/chat/agent/tools/execute`.
- Deny: the pending UI action is cleared without calling the execution endpoint.
- Result: the response is incorporated into the conversation UI by the app's agent flow.

The client is not the authority for tool arguments or approval validity. The backend validates the token, session, and expiry before execution.

## Styling

Global styles and Tailwind directives are in `src/index.css`; Tailwind configuration is in `tailwind.config.js`. Component styling is implemented in the React components and stylesheet. The project uses Lucide React for iconography.

## Configuration

Create `client/.env` from `client/.env.example`:

| Variable | Purpose | Default / example |
|---|---|---|
| `VITE_API_URL` | Backend API origin | `http://localhost:5000` |

Vite exposes variables prefixed with `VITE_` to client-side code. Do not place secrets in this variable or any other frontend environment variable.

## Development commands

```bash
cd client
npm install
npm run dev
```

Other scripts:

```bash
npm run build    # TypeScript project build and Vite production build
npm run lint     # ESLint
npm run preview  # Preview the production build locally
```

Start the backend separately; see [Server README](../server/README.md).

## Known limitations

- Sessions are stored in the current browser's `localStorage`; there is no account-based session sync.
- The client depends on the backend for preferences, document operations, chat generation, retrieval, and agent execution.
- Streaming requires a browser that supports `fetch` response streams and `AbortController`.
- No frontend automated test script is defined in `package.json`.
