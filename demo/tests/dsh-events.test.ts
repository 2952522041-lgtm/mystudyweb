import assert from 'node:assert/strict';
import test from 'node:test';

import { DshEventCollector } from '../electron/dsh-events.ts';

type Notification = { method: string; params: Record<string, unknown> };

function event(
  sessionId: string,
  type: string,
  data: Record<string, unknown> = {},
): Notification {
  return {
    method: 'session.event',
    params: { sessionId, event: { type, data } },
  };
}

function receipt(sessionId: string, messageId: string): Notification {
  return event(sessionId, 'agent/inbox/spliced', {
    inserted: [{ id: messageId }],
  });
}

function idle(sessionId: string): Notification {
  return { method: 'session.status', params: { sessionId, status: 'idle' } };
}

function assistant(
  sessionId: string,
  text: string,
  extra: Record<string, unknown> = {},
): Notification {
  return event(sessionId, 'assistant/message', {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'private reasoning' },
        { type: 'text', text },
      ],
    },
    ...extra,
  });
}

function end(sessionId: string, kind: string): Notification {
  return event(sessionId, 'turn/end', { turn: 1, reason: { kind } });
}

void test('preserves structured terminal authentication failure without exposing provider text', () => {
  const collector = new DshEventCollector('safe', 'm-safe');
  collector.observe(receipt('safe', 'm-safe'));
  collector.observe(event('safe', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'HTTP_ERROR', status: 401, message: 'private-key private-body' } } }));
  assert.throws(() => collector.result(), error => error instanceof Error && /authentication/.test(error.message) && !/private/.test(error.message));
});

void test('preserves truncation when reasoning consumes the entire visible-output budget', () => {
  const collector = new DshEventCollector('s-1', 'm-1');
  collector.observe(receipt('s-1', 'm-1'));
  collector.observe(end('s-1', 'max-tokens'));
  assert.deepEqual(collector.result(), { content: '', finishReason: 'length' });
});

void test('collects only the matched turn and exposes visible text after completed turn', () => {
  const collector = new DshEventCollector('s-1', 'm-1');
  collector.observe(idle('s-1'));
  collector.observe(assistant('s-1', 'before receipt'));
  collector.observe(receipt('s-1', 'm-other'));
  assert.equal(collector.done, false);

  collector.observe(receipt('s-1', 'm-1'));
  collector.observe(event('s-1', 'turn/start', { turn: 1 }));
  collector.observe(assistant('s-1', 'answer'));
  collector.observe(idle('s-1'));
  assert.equal(collector.done, false, 'idle alone is not a result');
  collector.observe(end('s-1', 'completed'));

  assert.equal(collector.done, true);
  assert.deepEqual(collector.result(), {
    content: 'answer',
    finishReason: 'stop',
  });
});

void test('ignores notifications from another session, including a matching message id', () => {
  const collector = new DshEventCollector('s-1', 'm-1');
  collector.observe(receipt('s-other', 'm-1'));
  collector.observe(assistant('s-other', 'wrong session'));
  collector.observe(end('s-other', 'completed'));
  collector.observe(idle('s-other'));
  assert.equal(collector.done, false);
  assert.throws(() => collector.result(), /DSH/);
});

void test('returns length for max-tokens even when the visible text is complete JSON', () => {
  const collector = new DshEventCollector('s-1', 'm-1');
  collector.observe(receipt('s-1', 'm-1'));
  collector.observe(assistant('s-1', '{"ok":true}'));
  collector.observe(end('s-1', 'max-tokens'));
  collector.observe(idle('s-1'));
  assert.deepEqual(collector.result(), {
    content: '{"ok":true}',
    finishReason: 'length',
  });
});

void test('does not turn partial error output into success or leak provider error text', () => {
  const secret = 'sk-this-must-not-appear';
  const collector = new DshEventCollector('s-1', 'm-1');
  collector.observe(receipt('s-1', 'm-1'));
  collector.observe(assistant('s-1', 'partial'));
  collector.observe(
    event('s-1', 'turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: secret, code: 'AUTH' } },
    }),
  );
  assert.equal(collector.done, true);
  assert.throws(
    () => collector.result(),
    (value: unknown) => {
      assert.ok(value instanceof Error);
      assert.match(value.message, /DSH/);
      assert.equal(value.message.includes(secret), false);
      return true;
    },
  );
});

void test('rejects an empty visible body and never emits reasoning text', () => {
  const collector = new DshEventCollector('s-1', 'm-1');
  collector.observe(receipt('s-1', 'm-1'));
  collector.observe(
    event('s-1', 'assistant/message', {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'do not leak this' }],
      },
    }),
  );
  collector.observe(end('s-1', 'completed'));
  assert.equal(collector.content, '');
  assert.equal(collector.done, true);
  assert.throws(() => collector.result(), /DSH/);
});

void test('uses the durable message as authority when verified text deltas precede it', () => {
  const collector = new DshEventCollector('s-1', 'm-1');
  collector.observe(receipt('s-1', 'm-1'));
  collector.observe(
    event('s-1', 'assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'du' },
    }),
  );
  collector.observe(
    event('s-1', 'assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'reasoning-delta', index: 1, text: 'secret' },
    }),
  );
  collector.observe(assistant('s-1', 'durable'));
  collector.observe(end('s-1', 'completed'));
  assert.deepEqual(collector.result(), {
    content: 'durable',
    finishReason: 'stop',
  });
});

void test('rejects an unknown turn termination instead of treating idle as success', () => {
  const collector = new DshEventCollector('s-1', 'm-1');
  collector.observe(receipt('s-1', 'm-1'));
  collector.observe(assistant('s-1', 'answer'));
  collector.observe(end('s-1', 'future-reason'));
  assert.equal(collector.done, true);
  assert.throws(() => collector.result(), /DSH/);
});

void test('accepts an explicit final stream finish without mistaking idle for completion', () => {
  const collector = new DshEventCollector('s-1', 'm-1');
  collector.observe(receipt('s-1', 'm-1'));
  collector.observe(
    assistant('s-1', 'stream answer', {
      stream: [
        {
          type: 'text-chunks',
          time0: 1,
          index: 0,
          dt: [],
          texts: ['stream answer'],
        },
        {
          type: 'chunk',
          time: 2,
          chunk: { type: 'finish', reason: { kind: 'stop' } },
        },
      ],
    }),
  );
  assert.equal(collector.done, true);
  assert.deepEqual(collector.result(), {
    content: 'stream answer',
    finishReason: 'stop',
  });
});
