import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySlidingWindow,
  estimateMessageTokens,
  estimateTokens,
} from '../src/utils/contextWindow';
import type { ChatMessage } from '../src/services/ollama.service';

const totalEstimatedTokens = (msgs: ChatMessage[]) =>
  msgs.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

test('long conversation trims oldest complete pairs and starts history with user', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are LocalMind.' },
  ];
  for (let i = 0; i < 20; i++) {
    messages.push({ role: 'user', content: `User turn ${i}: ` + 'word '.repeat(30) });
    messages.push({ role: 'assistant', content: `Assistant turn ${i}: ` + 'reply '.repeat(30) });
  }
  messages.push({ role: 'user', content: 'Latest question?' });

  const windowed = applySlidingWindow(messages, { maxTurns: 10, maxTokens: 600 });

  assert.equal(windowed[0].role, 'system');
  assert.equal(windowed[windowed.length - 1].content, 'Latest question?');
  assert.equal(windowed[1].role, 'user'); // no orphan assistant message
  assert.ok(totalEstimatedTokens(windowed) <= 600);
});

test('oversized latest user prompt is truncated without dropping system prompt', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are LocalMind.' },
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'big prompt '.repeat(800) },
  ];

  const windowed = applySlidingWindow(messages, { maxTokens: 300 });

  assert.equal(windowed.length, 2); // history dropped, system + latest kept
  assert.equal(windowed[0].content, 'You are LocalMind.');
  assert.match(windowed[1].content, /\.\.\.\[truncated\]$/);
  assert.ok(totalEstimatedTokens(windowed) <= 300);
});

test('oversized system prompt is truncated while preserving short user query', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'context chunk '.repeat(800) },
    { role: 'user', content: 'Summarize this.' },
  ];

  const windowed = applySlidingWindow(messages, { maxTokens: 300 });

  assert.equal(windowed.length, 2);
  assert.equal(windowed[1].content, 'Summarize this.');
  assert.match(windowed[0].content, /\.\.\.\[truncated\]$/);
  assert.ok(totalEstimatedTokens(windowed) <= 300);
});

test('both system and latest oversized still stay within maxTokens budget', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys '.repeat(600) },
    { role: 'user', content: 'usr '.repeat(600) },
  ];

  const windowed = applySlidingWindow(messages, { maxTokens: 200 });
  assert.equal(windowed.length, 2);
  assert.ok(totalEstimatedTokens(windowed) <= 200);
});

test('estimateTokens returns 0 for empty strings and positive conservative estimates otherwise', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('hello world') > 0);
});