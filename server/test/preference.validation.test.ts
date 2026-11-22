import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updatePreferences, setPreference } from '../src/controllers/preference.controller';

function makeMockRes() {
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

test('updatePreferences rejects out-of-range temperature and unknown keys with HTTP 400', async () => {
  const resBadTemp = makeMockRes();
  await updatePreferences({ body: { temperature: 5 } } as any, resBadTemp);
  assert.equal(resBadTemp.statusCode, 400);
  assert.equal(resBadTemp.body.code, 'VALIDATION_ERROR');

  const resUnknownKey = makeMockRes();
  await updatePreferences({ body: { unknownField: true } } as any, resUnknownKey);
  assert.equal(resUnknownKey.statusCode, 400);
  assert.equal(resUnknownKey.body.code, 'VALIDATION_ERROR');
});

test('setPreference rejects unknown preference key with HTTP 400', async () => {
  const res = makeMockRes();
  await setPreference({ params: { key: 'not_a_real_key' }, body: { value: 1 } } as any, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  assert.match(res.body.error, /Unknown preference key/i);
});