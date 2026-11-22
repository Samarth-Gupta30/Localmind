import { Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';

// Singleton services
import { ollamaService, ChatMessage, buildSystemPrompt } from '../services/ollama.service';
import { preferenceStore } from '../services/preference.service';

// Instance services (stateless)
import { SelfHealingService } from '../services/selfHealing.service';
import { ToolService } from '../services/tool.service';

// Utils
import { applySlidingWindow } from '../utils/contextWindow';
import {
  initSSEResponse,
  writeSSEEvent,
  writeSSEError,
  createSSEAbortController,
} from '../utils/sse';
import { handleControllerError, getErrorMessage } from '../utils/errorHandler';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
type ToolName =
  | 'calculate_math'
  | 'list_directory_safe'
  | 'get_system_specs'
  | 'get_current_time';

interface ValidatedToolCall {
  toolName: ToolName;
  args: Record<string, unknown>;
  reason: string;
}

// ---------------------------------------------------------------------------
// Services created once (stateless)
const selfHealingService = new SelfHealingService();
const toolService = new ToolService();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Tool-router schema & prompts
const ToolRouterSchema = z.discriminatedUnion('needsTool', [
  z
    .object({
      needsTool: z.literal(false),
      toolName: z.literal('none'),
      args: z.record(z.string(), z.unknown()).default({}),
      reason: z.string().default(''),
    })
    .strict(),

  z
    .object({
      needsTool: z.literal(true),
      toolName: z.enum([
        'get_system_specs',
        'list_directory_safe',
        'calculate_math',
        'get_current_time',
      ]),
      args: z.record(z.string(), z.unknown()).default({}),
      reason: z.string().default(''),
    })
    .strict(),
]);

const ROUTER_PROMPT = `Analyze the user's request and determine whether a local tool is needed.

Available tools:
${JSON.stringify(ToolService.AVAILABLE_TOOLS, null, 2)}

Tool selection rules:
- get_system_specs: RAM, CPU, hardware specs.
- list_directory_safe: List files or folders.
- calculate_math: Calculate math expression.
- get_current_time: Date, time, day, or timezone.
- none: Normal conversation. Use needsTool=false and toolName="none".

Return valid JSON.`;

const ROUTER_EXAMPLE = `{
  "needsTool": true,
  "toolName": "get_current_time",
  "args": {},
  "reason": "Requested date and time."
}`;

// ---------------------------------------------------------------------------
// Helper: sanitize chat history
function sanitizeHistory(history: unknown): ChatMessage[] {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (m): m is ChatMessage =>
        m !== null &&
        typeof m === 'object' &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string'
    )
    .map((m) => ({ role: m.role, content: m.content }));
}

// ---------------------------------------------------------------------------
// Helper: deterministic detection of explicit tool requests
const PATH_STOP_WORDS = new Set([
  'this', 'that', 'the', 'my', 'our', 'current', 'here', 'there',
  'folder', 'folders', 'directory', 'directories', 'project', 'workspace',
  'root', 'it', 'a', 'an',
]);

function detectExplicitToolIntent(query: string): ValidatedToolCall | null {
  const normalized = query.toLowerCase().trim();

  // Explicit math calculation (e.g. "Calculate (125 * 8) + 45")
  const mathMatch = query.match(
    /^\s*(?:calculate|compute|evaluate)\s+([0-9+\-*/().%\s]+)$/i
  );
  if (mathMatch && mathMatch[1]) {
    const expression = mathMatch[1].trim();
    if (/[0-9]/.test(expression) && expression.length <= 500) {
      return {
        toolName: 'calculate_math',
        args: { expression },
        reason: 'The user explicitly requested a math calculation.',
      };
    }
  }

  const asksToList =
    /\b(list|show|display)\b/.test(normalized) &&
    /\b(files?|folders?|directories|directory)\b/.test(normalized);

  if (!asksToList) return null;

  const pathMatch = query.match(
    /\b(?:inside|in|under|within)\s+(?:the\s+)?([a-zA-Z0-9_.\\/-]+)/i
  );

  let dirPath = pathMatch?.[1]?.replace(/[.,!?]+$/, '') ?? '';

  if (!dirPath || PATH_STOP_WORDS.has(dirPath.toLowerCase())) {
    dirPath = '.';
  }

  return {
    toolName: 'list_directory_safe',
    args: { dirPath },
    reason: 'The user explicitly requested a directory listing.',
  };
}

// ---------------------------------------------------------------------------
// Helper: validate router decision & arguments
export function validateRouterDecision(
  data: z.infer<typeof ToolRouterSchema> | undefined
): ValidatedToolCall | null {
  if (!data || !data.needsTool) {
    return null;
  }

  const { toolName, args, reason } = data;

  switch (toolName) {
    case 'calculate_math': {
      const result = z
        .object({ expression: z.string().trim().min(1).max(500) })
        .strict()
        .safeParse(args);

      if (!result.success) {
        logger.warn('AgentRouter', 'Rejected calculate_math: invalid arguments.');
        return null;
      }
      return { toolName, args: result.data, reason };
    }

    case 'list_directory_safe': {
      const result = z
        .object({ dirPath: z.string().trim().min(1).max(500) })
        .strict()
        .safeParse(args);

      if (!result.success) {
        logger.warn('AgentRouter', 'Rejected list_directory_safe: invalid arguments.');
        return null;
      }
      return { toolName, args: result.data, reason };
    }

    case 'get_system_specs':
    case 'get_current_time': {
      const result = z.object({}).strict().safeParse(args);

      if (!result.success) {
        logger.warn('AgentRouter', `Rejected ${toolName}: unexpected arguments.`);
        return null;
      }
      return { toolName, args: {}, reason };
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Approval-ticket logic (single-use, session-bound tokens)
interface PendingApproval {
  toolName: ToolName;
  args: Record<string, unknown>;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
}

const pendingApprovals = new Map<string, PendingApproval>();
const APPROVAL_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function issueApprovalToken(
  toolName: ToolName,
  args: Record<string, unknown>,
  sessionId: string
): string {
  const now = Date.now();

  for (const [token, approval] of pendingApprovals.entries()) {
    if (now >= approval.expiresAt) {
      pendingApprovals.delete(token);
    }
  }

  const approvalToken = crypto.randomUUID();

  pendingApprovals.set(approvalToken, {
    toolName,
    args,
    sessionId,
    createdAt: now,
    expiresAt: now + APPROVAL_TTL_MS,
  });

  return approvalToken;
}

export function consumeApprovalToken(
  token: string,
  sessionId: string
): { toolName: ToolName; args: Record<string, unknown> } {
  if (typeof token !== 'string' || !UUID_RE.test(token) || !sessionId) {
    throw new Error('Invalid approval request.');
  }

  const approval = pendingApprovals.get(token);

  if (!approval) {
    throw new Error('Invalid or already consumed approval token.');
  }

  if (Date.now() >= approval.expiresAt) {
    pendingApprovals.delete(token);
    throw new Error('Approval token has expired. Please retry your request.');
  }

  if (approval.sessionId !== sessionId) {
    throw new Error('Approval token does not belong to this browser session.');
  }

  pendingApprovals.delete(token);

  return { toolName: approval.toolName, args: approval.args };
}

// ---------------------------------------------------------------------------
// Controllers
const ApprovalRequestSchema = z.object({
  approvalToken: z.string().uuid(),
});

export async function executeTool(req: Request, res: Response): Promise<void> {
  try {
    const parsed = ApprovalRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid approval request.', code: 'VALIDATION_ERROR' });
      return;
    }

    const sessionId = res.locals.agentSessionId as string | undefined;

    if (!sessionId) {
      res.status(403).json({ error: 'Agent session is missing.', code: 'AUTH_ERROR' });
      return;
    }

    const verified = consumeApprovalToken(parsed.data.approvalToken, sessionId);

    logger.info('AgentController', `Executing approved tool: ${verified.toolName}`);

    const result = await toolService.executeTool({
      name: verified.toolName,
      arguments: verified.args,
    });

    res.json({ success: true, toolName: verified.toolName, result });
  } catch (error) {
    logger.error('AgentController', 'Tool request rejected:', getErrorMessage(error));

    res.status(403).json({
      error: getErrorMessage(error, 'Tool authorization failed.'),
      code: 'AUTH_ERROR',
    });
  }
}

export async function streamAgentChat(req: Request, res: Response): Promise<void> {
  const abortController = createSSEAbortController(res);
  try {
    const { query, conversationHistory = [], model } = req.body as {
      query: string;
      conversationHistory?: ChatMessage[];
      model?: string;
    };

    if (typeof query !== 'string' || !query.trim()) {
      res.status(400).json({ error: 'Query is required.', code: 'VALIDATION_ERROR' });
      return;
    }

    const cleanQuery = query.trim();

    initSSEResponse(res);
    if (abortController.signal.aborted) {
      return;
    }

    // 1. Detect explicit tool requests deterministically.
    let toolAction: ValidatedToolCall | null = detectExplicitToolIntent(cleanQuery);

    // 2. If no explicit intent is detected, ask the LLM router with cancellation signal.
    if (!toolAction && !abortController.signal.aborted) {
      const userPrompt = `User Query: "${cleanQuery}"`;

      const decision = await selfHealingService.executeWithSchema(
        userPrompt,
        ToolRouterSchema,
        ROUTER_EXAMPLE,
        ROUTER_PROMPT,
        abortController.signal
      );

      if (abortController.signal.aborted) {
        return;
      }

      if (decision.success && decision.data) {
        toolAction = validateRouterDecision(decision.data);
      } else if (!decision.error?.includes('cancelled')) {
        logger.warn('AgentRouter', 'Router validation failed. Falling back to normal chat.');
      }
    }

    if (abortController.signal.aborted) {
      return;
    }

    // 3. Request approval for every selected tool.
    if (toolAction) {
      const sessionId = res.locals.agentSessionId as string | undefined;

      if (!sessionId) {
        throw new Error('Agent session could not be established.');
      }

      const approvalToken = issueApprovalToken(
        toolAction.toolName,
        toolAction.args,
        sessionId
      );

      logger.info('AgentRouter', `Approval requested for tool: ${toolAction.toolName}`);

      writeSSEEvent(
        res,
        {
          type: 'action_required',
          approvalToken,
          toolName: toolAction.toolName,
          args: toolAction.args,
          reason: toolAction.reason || 'Execute system tool',
        },
        abortController.signal
      );

      if (!res.writableEnded) res.end();
      return;
    }

    // 4. Normal chat flow (no tool needed)
    const agentSystemPrompt = buildSystemPrompt(
      `You are LocalMind, a helpful privacy-focused offline AI assistant.\n\nAvailable tools:\n${JSON.stringify(
        ToolService.AVAILABLE_TOOLS,
        null,
        2
      )}`,
      model
    );

    const safeHistory = sanitizeHistory(conversationHistory);
    const messagesPayload: ChatMessage[] = [
      { role: 'system', content: agentSystemPrompt },
      ...safeHistory,
      { role: 'user', content: cleanQuery },
    ];

    const maxContextTurns = preferenceStore.get('maxContextTurns');

    await ollamaService.streamChat(
      applySlidingWindow(messagesPayload, {
        maxTurns: maxContextTurns,
        maxTokens: 1800,
      }),
      {
        onToken: (token) => writeSSEEvent(res, { type: 'token', token }, abortController.signal),
        onDone: (metrics) => {
          if (abortController.signal.aborted) return;
          writeSSEEvent(res, { type: 'done', metrics }, abortController.signal);
          if (!res.writableEnded) res.end();
        },
        onError: (error) => {
          writeSSEError(res, error.message, abortController.signal);
        },
      },
      model,
      abortController.signal
    );
  } catch (error) {
    if (abortController.signal.aborted) return;
    handleControllerError(res, error, 'Agent Controller');
  }
}