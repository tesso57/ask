import { test } from 'node:test';
import assert from 'node:assert/strict';
import register from '../extensions/ask.ts';

function setup() {
  let tool, command;
  const handlers = new Map(), sent = [], notifications = [], selections = [], inputs = [];
  let widget;
  register({
    registerTool(value) { tool = value; },
    registerCommand(_name, value) { command = value; },
    on(name, handler) { handlers.set(name, handler); },
    sendUserMessage(...args) { sent.push(args); },
  });
  const ctx = { hasUI: true, ui: {
    async select() { return selections.shift(); },
    async input() { return inputs.shift(); },
    notify(...args) { notifications.push(args); },
    setWidget(_key, value) { widget = value; },
  } };
  const ask = (params, context = ctx) => tool.execute('id', params, undefined, undefined, context);
  return { ask, command, ctx, handlers, sent, notifications, selections, inputs, get widget() { return widget; } };
}
const question = { question: 'Choose?', options: ['A', 'B'] };

test('async returns immediately, and delivers a later free-text answer', async () => {
  const s = setup();
  const result = await s.ask({ ...question, mode: 'async' });
  assert.deepEqual(result.details, { status: 'pending', id: 1 });
  assert.match(s.widget[0], /#1 Choose\?/);
  s.selections.push('3. その他（自由入力）'); s.inputs.push('custom answer');
  await s.command.handler('1', s.ctx);
  assert.match(s.sent[0][0], /custom answer/);
  assert.equal(s.sent[0][1].deliverAs, 'steer');
  assert.equal(s.widget, undefined);
});

test('sync returns the selected answer or cancellation', async () => {
  const s = setup();
  s.selections.push('2. B');
  assert.equal((await s.ask({ ...question, mode: 'sync' })).details.answer, 'B');
  s.selections.push(undefined);
  assert.equal((await s.ask({ ...question, mode: 'sync' })).details.status, 'cancelled');
});

test('cancelled async response remains pending; session changes clear it', async () => {
  const s = setup();
  await s.ask({ ...question, mode: 'async' });
  s.selections.push(undefined);
  await s.command.handler('1', s.ctx);
  assert.match(s.widget[0], /#1/);
  s.handlers.get('session_tree')({}, s.ctx);
  assert.equal(s.widget, undefined);
  await s.command.handler('1', s.ctx);
  assert.equal(s.sent.length, 0);
});

test('noninteractive sessions do not create pending questions', async () => {
  const s = setup();
  assert.equal((await s.ask({ ...question, mode: 'async' }, { hasUI: false })).details.status, 'unavailable');
  assert.equal(s.widget, undefined);
});
