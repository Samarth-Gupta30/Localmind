import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, handleControllerError } from '../src/utils/errorHandler';
import { logger } from '../src/utils/logger';

function mockRes() {
  const res: any = {
    headersSent: false,
    statusCode: 200,
    body: null,
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

test('operational AppError returns its statusCode, category, and message', () => {
  const res = mockRes();
  handleControllerError(res, new AppError('Dimension conflict', 409), 'VectorStore');

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'Dimension conflict');
  assert.equal(res.body.code, 'CONFLICT');
});

test('unexpected Error hides internal details from client and returns 500 INTERNAL_ERROR', () => {
  const res = mockRes();
  handleControllerError(
    res,
    new Error('SQLITE_CANTOPEN: /var/private/db.sqlite'),
    'PreferenceStore'
  );

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, 'INTERNAL_ERROR');
  assert.equal(res.body.error, 'An unexpected internal error occurred.');
  assert.ok(!res.body.error.includes('SQLITE'));
});

test('logger redacts sensitive fields from logged objects', () => {
  const origLog = console.log;
  const captured: unknown[] = [];
  console.log = (...args: unknown[]) => captured.push(...args);

  try {
    logger.info('Test', 'Checking payload', {
      approvalToken: 'secret-uuid-123',
      toolName: 'get_current_time',
    });
    const serialized = JSON.stringify(captured);
    assert.ok(!serialized.includes('secret-uuid-123'));
    assert.ok(serialized.includes('[REDACTED]'));
    assert.ok(serialized.includes('get_current_time'));
  } finally {
    console.log = origLog;
  }
});

test('logger redacts localmind_agent_session cookie, Bearer tokens, and sensitive object keys', () => {
  const origLog = console.log;
  const captured: unknown[] = [];
  console.log = (...args: unknown[]) => captured.push(...args);

  try {
    const secretSession = 'a'.repeat(64);
    const secretToken = '11111111-2222-3333-4444-555555555555';
    logger.info(
      'AuthCheck',
      `Cookie: localmind_agent_session=${secretSession}; Authorization: Bearer secret-jwt-999`,
      {
        approvalToken: secretToken,
        sessionId: secretSession,
        authorization: 'Bearer secret-jwt-999',
        nested: { password: 'pw-value', safeKey: 'visible' },
      }
    );

    const serialized = JSON.stringify(captured);
    assert.ok(!serialized.includes(secretSession));
    assert.ok(!serialized.includes(secretToken));
    assert.ok(!serialized.includes('secret-jwt-999'));
    assert.ok(!serialized.includes('pw-value'));
    assert.ok(serialized.includes('[REDACTED]'));
    assert.ok(serialized.includes('visible'));
  } finally {
    console.log = origLog;
  }
});