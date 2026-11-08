import { test } from 'node:test';
import assert from 'node:assert/strict';
import register from '../extensions/ask.ts';

function setup() {
  let tool, command;
  const handlers = new Map(), sent = [], notifications = [], selections = [], inputs = [], entries = [];
  let branch = entries;
  let widget;
  register({
    registerTool(value) { tool = value; },
    registerCommand(_name, value) { command = value; },
    on(name, handler) { handlers.set(name, handler); },
    sendUserMessage(...args) { sent.push(args); },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  });
  const ctx = { hasUI: true, sessionManager: { getBranch: () => branch }, ui: {
    async select() { return selections.shift(); },
    async input() { return inputs.shift(); },
    notify(...args) { notifications.push(args); },
    setWidget(_key, value) { widget = value; },
  } };
  const ask = (params, context = ctx, signal = undefined) => tool.execute('id', params, signal, undefined, context);
  return { ask, command, ctx, handlers, sent, notifications, selections, inputs, entries, setBranch: value => { branch = value; }, executionMode: tool.executionMode, get widget() { return widget; } };
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
  assert.match(s.widget[0], /#1/);
  s.handlers.get('message_start')({ message: { role: 'user', content: [{ type: 'text', text: s.sent[0][0] }] } }, s.ctx);
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
  s.setBranch([]);
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

test('aborting a synchronous question dismisses its dialog', async () => {
  const s = setup();
  const controller = new AbortController();
  s.ctx.ui.select = (_title, _choices, options) => new Promise(resolve => {
    if (options?.signal?.aborted) return resolve(undefined);
    options?.signal?.addEventListener('abort', () => resolve(undefined), { once: true });
  });
  const result = s.ask({ ...question, mode: 'sync' }, s.ctx, controller.signal);
  controller.abort();
  const timeout = new Promise(resolve => setTimeout(() => resolve('dialog remained open'), 250));
  assert.notEqual(await Promise.race([result, timeout]), 'dialog remained open');
});

test('questions do not serialize unrelated tools in the same agent response', () => {
  const s = setup();
  assert.notEqual(s.executionMode, 'sequential');
});

test('concurrent synchronous questions open one dialog at a time', async () => {
  const s = setup();
  const openDialogs = [];
  s.ctx.ui.select = title => new Promise(resolve => openDialogs.push({ title, resolve }));
  const first = s.ask({ ...question, mode: 'sync' });
  const second = s.ask({ ...question, question: 'Second?', mode: 'sync' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(openDialogs.map(dialog => dialog.title), ['Choose?']);
  openDialogs[0].resolve('1. A');
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(openDialogs.map(dialog => dialog.title), ['Choose?', 'Second?']);
  openDialogs[1].resolve('2. B');
  assert.equal((await second).details.answer, 'B');
});


test('a failed answer delivery leaves the question available for retry', async () => {
  const s = setup();
  await s.ask({ ...question, mode: 'async' });
  s.selections.push('1. A');
  await s.command.handler('1', s.ctx);
  assert.match(s.widget[0], /#1/);
  s.selections.push('2. B');
  await s.command.handler('1', s.ctx);
  assert.equal(s.sent.length, 2);
});

test('aborting a synchronous free-text input dismisses it', async () => {
  const s = setup();
  const controller = new AbortController();
  s.selections.push('3. その他（自由入力）');
  let inputStarted;
  const ready = new Promise(resolve => { inputStarted = resolve; });
  s.ctx.ui.input = (_title, _placeholder, options) => new Promise(resolve => {
    inputStarted();
    if (options?.signal?.aborted) return resolve(undefined);
    options?.signal?.addEventListener('abort', () => resolve(undefined), { once: true });
  });
  const result = s.ask({ ...question, mode: 'sync' }, s.ctx, controller.signal);
  await ready;
  controller.abort();
  const timeout = new Promise(resolve => setTimeout(() => resolve('input remained open'), 250));
  assert.notEqual(await Promise.race([result, timeout]), 'input remained open');
});

test('unrelated user messages do not clear pending questions', async () => {
  const s = setup();
  await s.ask({ ...question, mode: 'async' });
  s.selections.push('1. A');
  await s.command.handler('1', s.ctx);
  s.handlers.get('message_start')({ message: { role: 'user', content: [{ type: 'text', text: 'another message' }] } }, s.ctx);
  assert.match(s.widget[0], /#1/);
});


test('pending questions are restored from the active session branch', async () => {
  const s = setup();
  await s.ask({ ...question, mode: 'async' });
  const saved = [...s.entries];
  s.setBranch([]);
  s.handlers.get('session_tree')({}, s.ctx);
  assert.equal(s.widget, undefined);
  s.setBranch(saved);
  s.handlers.get('session_tree')({}, s.ctx);
  assert.match(s.widget[0], /#1 Choose/);
  s.selections.push('2. B');
  await s.command.handler('1', s.ctx);
  assert.match(s.sent[0][0], /B/);
});

test('reloading restores a failed delivery but not an accepted answer', async () => {
  const s = setup();
  await s.ask({ ...question, mode: 'async' });
  s.selections.push('1. A');
  await s.command.handler('1', s.ctx);
  s.handlers.get('session_start')({}, s.ctx);
  assert.match(s.widget[0], /#1/);
  s.entries.push({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: s.sent[0][0] }] } });
  s.handlers.get('session_start')({}, s.ctx);
  assert.equal(s.widget, undefined);
});

test('an aborted queued question returns without waiting for the active dialog', async () => {
  const s = setup();
  const opened = [];
  s.ctx.ui.select = title => new Promise(resolve => opened.push({ title, resolve }));
  const first = s.ask({ ...question, mode: 'sync' });
  await new Promise(resolve => setImmediate(resolve));
  const controller = new AbortController();
  const second = s.ask({ ...question, question: 'Second?', mode: 'sync' }, s.ctx, controller.signal);
  controller.abort();
  const timeout = new Promise(resolve => setTimeout(() => resolve('blocked'), 250));
  assert.notEqual(await Promise.race([second, timeout]), 'blocked');
  opened[0].resolve('1. A');
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened.map(dialog => dialog.title), ['Choose?']);
});

test('a queued answer does not open after switching sessions', async () => {
  const s = setup();
  const opened = [];
  s.ctx.ui.select = title => new Promise(resolve => opened.push({ title, resolve }));
  const first = s.ask({ ...question, mode: 'sync' });
  await new Promise(resolve => setImmediate(resolve));
  await s.ask({ ...question, question: 'Pending?', mode: 'async' });
  const second = s.command.handler('2', s.ctx);
  s.setBranch([]);
  s.handlers.get('session_tree')({}, s.ctx);
  const noticesBefore = s.notifications.length;
  opened[0].resolve('1. A');
  await first;
  await second;
  assert.deepEqual(opened.map(dialog => dialog.title), ['Choose?']);
  assert.equal(s.notifications.length, noticesBefore);
});

test('many long pending questions keep the widget compact while retaining every question', async () => {
  const s = setup();
  for (let i = 0; i < 8; i++) {
    await s.ask({ question: 'Long question '.repeat(80), options: ['A', 'B'], mode: 'async' });
  }
  assert.ok(s.widget.length <= 6);
  assert.ok(s.widget.every(line => [...line].length <= 120));
  await s.command.handler('', s.ctx);
  assert.match(s.notifications.at(-1)[0], /8/);
  s.selections.push('1. A');
  await s.command.handler('8', s.ctx);
  assert.equal(s.sent.length, 1);
});

test('a prefixed answer is acknowledged after input transformation', async () => {
  const s = setup();
  await s.ask({ ...question, mode: 'async' });
  s.selections.push('1. A');
  await s.command.handler('1', s.ctx);
  s.handlers.get('message_start')({ message: { role: 'user', content: [{ type: 'text', text: `Context: ${s.sent[0][0]}` }] } }, s.ctx);
  assert.equal(s.widget, undefined);
});


test('a transformed answer remains acknowledged after restoring the session', async () => {
  const s = setup();
  await s.ask({ ...question, mode: 'async' });
  s.selections.push('2. B');
  await s.command.handler('1', s.ctx);
  s.entries.push({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: `Context: ${s.sent[0][0]}` }] } });
  s.handlers.get('session_start')({}, s.ctx);
  assert.equal(s.widget, undefined);
});

test('ambiguous transformed messages do not acknowledge a different question', async () => {
  const s = setup();
  await s.ask({ question: 'First question with a longer title?', options: ['A', 'B'], mode: 'async' });
  await s.ask({ question: 'Second?', options: ['A', 'B'], mode: 'async' });
  s.selections.push('1. A', '2. B');
  await s.command.handler('1', s.ctx);
  await s.command.handler('2', s.ctx);
  const message = `Previous context: ${s.sent[0][0]}\nNew answer: ${s.sent[1][0]}`;
  s.handlers.get('message_start')({ message: { role: 'user', content: [{ type: 'text', text: message }] } }, s.ctx);
  assert.match(s.widget[0], /#1/);
  assert.match(s.widget[0], /#2/);
  s.entries.push({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: message }] } });
  s.handlers.get('session_start')({}, s.ctx);
  assert.match(s.widget[0], /#1/);
  assert.match(s.widget[0], /#2/);
});

test('multiple matching attempts for the same question remain unambiguous', async () => {
  const s = setup();
  await s.ask({ ...question, mode: 'async' });
  s.selections.push('1. A', '2. B');
  await s.command.handler('1', s.ctx);
  await s.command.handler('1', s.ctx);
  const message = `${s.sent[0][0]}\n${s.sent[1][0]}`;
  s.handlers.get('message_start')({ message: { role: 'user', content: [{ type: 'text', text: message }] } }, s.ctx);
  assert.equal(s.widget, undefined);
});
