import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  executeTool,
  issueApprovalToken,
  validateRouterDecision,
} from '../src/controllers/agent.controller';
import { ensureAgentSession } from '../src/utils/agentSession';
import { ToolService } from '../src/services/tool.service';

function makeMockRes() {
  const headers: Record<string, string[]> = {};
  const res: any = {
    locals: {} as Record<string, unknown>,
    statusCode: 200,
    body: null,
    append(name: string, val: string) {
      headers[name] = headers[name] ?? [];
      headers[name].push(val);
    },
    getHeader(name: string) {
      return headers[name];
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

test('ensureAgentSession issues 64-hex session cookie and sets res.locals.agentSessionId', () => {
  const req: any = { headers: {}, secure: false };
  const res = makeMockRes();
  let nextCalled = false;
  ensureAgentSession(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.match(String(res.locals.agentSessionId), /^[a-f0-9]{64}$/i);
  const setCookie = String(res.getHeader('Set-Cookie') ?? '');
  assert.match(setCookie, /localmind_agent_session=/);
  assert.match(setCookie, /HttpOnly/i);
});

test('valid approval executes tool, ignores client-tampered args, and blocks replay', async () => {
  const sessionId = 'session-owner-1';
  const token = issueApprovalToken('calculate_math', { expression: '6 * 7' }, sessionId);

  const resExec = makeMockRes();
  resExec.locals.agentSessionId = sessionId;

  // Client sends modified expression in body; server must execute stored "6 * 7" = 42
  await executeTool(
    {
      body: {
        approvalToken: token,
        toolName: 'calculate_math',
        args: { expression: '1000000 + 1' },
      },
    } as any,
    resExec
  );

  assert.equal(resExec.statusCode, 200);
  assert.equal(resExec.body.success, true);
  assert.equal(resExec.body.result.result, 42);

  // Replay attempt with the same token must fail
  const resReplay = makeMockRes();
  resReplay.locals.agentSessionId = sessionId;
  await executeTool({ body: { approvalToken: token } } as any, resReplay);
  assert.equal(resReplay.statusCode, 403);
});

test('cross-session token usage is rejected', async () => {
  const token = issueApprovalToken('get_current_time', {}, 'session-a');
  const resOther = makeMockRes();
  resOther.locals.agentSessionId = 'session-b';

  await executeTool({ body: { approvalToken: token } } as any, resOther);
  assert.equal(resOther.statusCode, 403);
  assert.match(String(resOther.body.error), /different|does not belong/i);
});

test('expired approval token is rejected', async () => {
  const realNow = Date.now;
  const baseTime = 1_700_000_000_000;
  Date.now = () => baseTime;

  try {
    const token = issueApprovalToken('get_current_time', {}, 'session-exp');
    // Advance clock past 5-minute TTL
    Date.now = () => baseTime + 5 * 60 * 1000 + 1;

    const res = makeMockRes();
    res.locals.agentSessionId = 'session-exp';
    await executeTool({ body: { approvalToken: token } } as any, res);
    assert.equal(res.statusCode, 403);
    assert.match(String(res.body.error), /expired/i);
  } finally {
    Date.now = realNow;
  }
});

test('validateRouterDecision rejects invalid args and unsupported tools are rejected by ToolService', async () => {
  assert.equal(
    validateRouterDecision({
      needsTool: true,
      toolName: 'calculate_math',
      args: { wrongField: '1+1' },
      reason: 'bad args',
    } as any),
    null
  );

  const tools = new ToolService();
  await assert.rejects(
    () => tools.executeTool({ name: 'delete_all_files', arguments: {} }),
    /not in the allowed whitelist/i
  );
});