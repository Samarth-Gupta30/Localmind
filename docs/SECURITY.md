# LocalMind Security

This document records security-related controls visible in the inspected source. It is not a security certification or a claim that the application is production-secure.

## 1. Security boundaries

LocalMind is designed as a local application. The backend exposes an HTTP API to the configured frontend origin, calls a local Ollama service, reads/writes local application data, and exposes a small whitelist of local tools. The agent's directory-listing tool is the main feature that interacts with the filesystem on behalf of a model-generated request.

The model is not treated as an authorization authority: tool decisions are parsed and validated, and a user approval step is required before the approval-protected execution path.

## 2. Human approval and token lifecycle

The agent controller maintains pending approvals in a process-local `Map`. Each approval record contains the tool name, validated arguments, browser session ID, creation time, and expiry time.

1. The agent controller validates the proposed tool decision against the expected schema and registered tool names.
2. For an approval-required action, the server creates a cryptographically random UUID token.
3. The server stores the tool name and arguments with the token, bound to the current agent session.
4. The token expires after five minutes.
5. The client displays the pending action and asks the user to approve or deny it.
6. On approval, the client sends the UUID token to `POST /api/chat/agent/tools/execute`.
7. The server checks token format, existence, expiry, and session ownership.
8. A valid token is deleted before the stored tool and arguments are returned for execution, making it single-use.

The execute request schema accepts the approval token; the server uses the stored tool arguments rather than treating client-supplied arguments as authoritative.

### Session cookie

The agent routes install `ensureAgentSession` middleware. It issues a random 32-byte session identifier encoded as hex in the `localmind_agent_session` cookie when a valid cookie is not already present. The cookie is configured with:

- `HttpOnly`
- `SameSite=Strict`
- `Path=/`
- `Max-Age=2592000` (30 days)
- `Secure` when the request is secure or the backend is in production mode

The cookie is scoped to the agent routes' session mechanism. This is not user-account authentication.

### Limitations

- Pending approvals are stored in memory and are lost on backend restart.
- Tokens are not shared across multiple backend processes/instances.
- The session identifier is a browser-session binding mechanism, not a full identity or authorization system.
- The cookie has a 30-day lifetime; there is no account login or user-level session revocation flow in the inspected implementation.

## 3. Filesystem path protections

`ToolService.listDirectorySafe()` applies several checks before listing a directory:

- Rejects non-string paths and null bytes.
- Resolves the requested relative path against the canonical project working directory.
- Uses `path.relative()` checks to reject lexical traversal outside the project root.
- Walks path components with `lstatSync()` and rejects symbolic links.
- Resolves the final path with `realpathSync()` and verifies it remains within the canonical root.
- Requires the target to be a directory.
- Excludes entries named `.env`, `.git`, and `node_modules` from the returned listing.
- Uses `lstatSync()` when describing entries so symbolic links are not followed to report file metadata.

These checks reduce common path traversal and symlink escape risks for this tool. They do not create an operating-system sandbox and do not restrict the backend process's filesystem permissions generally.

### Filesystem limitations

The path checks and subsequent directory operations are separate filesystem operations. A concurrent filesystem change can create a time-of-check/time-of-use (TOCTOU) race. The tool should therefore be treated as a constrained application feature, not a hardened sandbox for untrusted multi-user workloads.

## 4. Request and model-output validation

The backend uses Zod schemas in relevant request and agent-decision paths. General chat validates message roles/content/lengths and rejects client-supplied system messages; the server builds its own system prompt. The agent controller validates structured model output and restricts execution to registered tool names. Upload middleware limits the request to one file and 10 MiB, and the document controller validates supported file types.

Validation is applied to the routes and data structures implemented in source; it should not be interpreted as proof that every possible input or deployment configuration is secure.

## 5. Secret and logging practices

- Environment-specific configuration is loaded through `dotenv` and centralized in `src/config/env.ts`.
- `.env` and local environment overrides are listed in the repository `.gitignore`; `.env.example` files are intended to document variable names/defaults without private credentials.
- The logger includes redaction logic for sensitive keys/strings such as session identifiers, approval tokens, and bearer-token patterns.
- Frontend `VITE_` variables are bundled into client code and must never contain secrets.

The inspected archive includes local `.env` files. Their values are intentionally not reproduced in this document. Before publishing the repository or an archive, remove private `.env` files and rotate any real credentials that may have been exposed.

## 6. Other protective controls

- CORS is configured around the frontend origin (`CLIENT_ORIGIN`).
- JSON request bodies have a configured size limit in the server bootstrap.
- Uploads are held in memory and constrained by file count and file size.
- OCR work is bounded by page count, per-page timeout, total time budget, and concurrent-job limits.
- Unexpected server errors are masked by centralized error handling; operational errors are returned with their configured status/category.
- The health endpoint reports readiness of local dependencies; it is not an authentication endpoint.

## 7. Known security limitations and unverified areas

- No general user authentication/authorization layer is implemented across all API routes.
- The agent session cookie does not identify a human user and does not provide account-level access control.
- In-memory approval state is single-process and non-persistent.
- Filesystem validation is vulnerable to TOCTOU races and is not an OS sandbox.
- Sensitive directory exclusions apply to directory-listing output; they do not constitute a general filesystem access policy for the backend process.
- The project has not been represented here as independently penetration-tested or audited.
- Production deployment hardening, reverse-proxy configuration, TLS termination, rate limiting, and multi-user isolation were not established by the inspected source and should not be assumed.

## 8. Security testing

The backend test directory includes tests for approval-token behavior and filesystem path handling, alongside request validation and error-handling tests. Run the backend test suite from `server/` with:

```bash
npm test
```

The presence of tests documents intended coverage; test success must be established by executing the suite in the target environment.
