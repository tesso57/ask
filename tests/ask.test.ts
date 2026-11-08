import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAskHarness as setup, type Dialog } from './helpers/ask-harness.ts';

const question = { question: 'Choose?', options: ['A', 'B'] };

test('async returns immediately, and delivers a later free-text answer', async () => {
  const s = setup();
  const result = await s.ask({ ...question, mode: 'async' });
  assert.deepEqual(result.details, { status: 'pending', id: 1 });
  assert.match(s.widget![0], /#1 Choose\?/);
  s.selections.push('3. その他（自由入力）'); s.inputs.push('custom answer');
  await s.command.handler('1', s.ctx);
  assert.match(s.sent[0][0], /custom answer/);
  assert.equal(s.sent[0][1].deliverAs, 'steer');
  assert.match(s.widget![0], /#1/);
  s.handlers.get('message_start')!({ message: { role: 'user', content: [{ type: 'text', text: s.sent[0][0] }] } }, s.ctx);
  assert.equal(s.widget, undefined);
});

test('sync returns the selected answer or cancellation', async () => {
  const s = setup();
  s.selections.push('2. B');
  assert.equal((await s.ask({ ...question, mode: 'sync' })).details.answer, 'B');
  s.selections.push(undefined);
  assert.equal((await s.ask({ ...question, mode: 'sync' })).details.status, 'cancelled');
});

test('cancelled async response remains pending; switching to another branch hides it', async () => {
  const s = setup();
  await s.ask({ ...question, mode: 'async' });
  s.selections.push(undefined);
  await s.command.handler('1', s.ctx);
  assert.match(s.widget![0], /#1/);
  s.setBranch([]);
  s.handlers.get('session_tree')!({}, s.ctx);
  assert.equal(s.widget, undefined);
  await s.command.handler('1', s.ctx);
  assert.equal(s.sent.length, 0);
});

test('noninteractive sessions do not create pending questions', async () => {
  const s = setup();
  assert.equal((await s.ask({ ...question, mode: 'async' }, { ...s.ctx, hasUI: false })).details.status, 'unavailable');
  assert.equal(s.widget, undefined);
});

test('aborting a synchronous question dismisses its dialog', async () => {
  const s = setup();
  const controller = new AbortController();
  s.ctx.ui.select = (_title, _choices, options) => new Promise<string | undefined>(resolve => {
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
  const openDialogs: Dialog[] = [];
  s.ctx.ui.select = title => new Promise<string | undefined>(resolve => openDialogs.push({ title, resolve }));
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
  assert.match(s.widget![0], /#1/);
  s.selections.push('2. B');
  await s.command.handler('1', s.ctx);
  assert.equal(s.sent.length, 2);
});

test('aborting a synchronous free-text input dismisses it', async () => {
  const s = setup();
  const controller = new AbortController();
  s.selections.push('3. その他（自由入力）');
  let inputStarted!: () => void;
  const ready = new Promise<void>(resolve => { inputStarted = resolve; });
  s.ctx.ui.input = (_title, _placeholder, options) => new Promise<string | undefined>(resolve => {
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
  s.handlers.get('message_start')!({ message: { role: 'user', content: [{ type: 'text', text: 'another message' }] } }, s.ctx);
  assert.match(s.widget![0], /#1/);
});


test('pending questions are restored from the active session branch', async () => {
  const s = setup();
  await s.ask({ ...question, mode: 'async' });
  const saved = [...s.entries];
  s.setBranch([]);
  s.handlers.get('session_tree')!({}, s.ctx);
  assert.equal(s.widget, undefined);
  s.setBranch(saved);
  s.handlers.get('session_tree')!({}, s.ctx);
  assert.match(s.widget![0], /#1 Choose/);
  s.selections.push('2. B');
  await s.command.handler('1', s.ctx);
  assert.match(s.sent[0][0], /B/);
});

test('reloading restores a failed delivery but not an accepted answer', async () => {
  const s = setup();
  await s.ask({ ...question, mode: 'async' });
  s.selections.push('1. A');
  await s.command.handler('1', s.ctx);
  s.handlers.get('session_start')!({}, s.ctx);
  assert.match(s.widget![0], /#1/);
  s.entries.push({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: s.sent[0][0] }] } });
  s.handlers.get('session_start')!({}, s.ctx);
  assert.equal(s.widget, undefined);
});

test('an aborted queued question returns without waiting for the active dialog', async () => {
  const s = setup();
  const opened: Dialog[] = [];
  s.ctx.ui.select = title => new Promise<string | undefined>(resolve => opened.push({ title, resolve }));
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
  const opened: Dialog[] = [];
  s.ctx.ui.select = title => new Promise<string | undefined>(resolve => opened.push({ title, resolve }));
  const first = s.ask({ ...question, mode: 'sync' });
  await new Promise(resolve => setImmediate(resolve));
  await s.ask({ ...question, question: 'Pending?', mode: 'async' });
  const second = s.command.handler('2', s.ctx);
  s.setBranch([]);
  s.handlers.get('session_tree')!({}, s.ctx);
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
  assert.ok(s.widget!.length <= 6);
  assert.ok(s.widget!.every(line => [...line].length <= 120));
  let listed = false;
  s.ctx.ui.select = async (_title, choices) => { listed = choices.some(choice => choice.startsWith('#8 ')); return undefined; };
  await s.command.handler('', s.ctx);
  assert.equal(listed, true);
  s.ctx.ui.select = async () => '1. A';
  await s.command.handler('8', s.ctx);
  assert.equal(s.sent.length, 1);
});

test('a prefixed answer is acknowledged after input transformation', async () => {
  const s = setup();
  await s.ask({ ...question, mode: 'async' });
  s.selections.push('1. A');
  await s.command.handler('1', s.ctx);
  s.handlers.get('message_start')!({ message: { role: 'user', content: [{ type: 'text', text: `Context: ${s.sent[0][0]}` }] } }, s.ctx);
  assert.equal(s.widget, undefined);
});


test('a transformed answer remains acknowledged after restoring the session', async () => {
  const s = setup();
  await s.ask({ ...question, mode: 'async' });
  s.selections.push('2. B');
  await s.command.handler('1', s.ctx);
  s.entries.push({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: `Context: ${s.sent[0][0]}` }] } });
  s.handlers.get('session_start')!({}, s.ctx);
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
  s.handlers.get('message_start')!({ message: { role: 'user', content: [{ type: 'text', text: message }] } }, s.ctx);
  assert.match(s.widget![0], /#1/);
  assert.match(s.widget![0], /#2/);
  s.entries.push({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: message }] } });
  s.handlers.get('session_start')!({}, s.ctx);
  assert.match(s.widget![0], /#1/);
  assert.match(s.widget![0], /#2/);
});

test('multiple matching attempts for the same question remain unambiguous', async () => {
  const s = setup();
  await s.ask({ ...question, mode: 'async' });
  s.selections.push('1. A', '2. B');
  await s.command.handler('1', s.ctx);
  await s.command.handler('1', s.ctx);
  const message = `${s.sent[0][0]}\n${s.sent[1][0]}`;
  s.handlers.get('message_start')!({ message: { role: 'user', content: [{ type: 'text', text: message }] } }, s.ctx);
  assert.equal(s.widget, undefined);
});


test('a user can dismiss a pending question without giving an answer', async () => {
  const s = setup();
  await s.ask({ ...question, mode: 'async' });
  await s.dismiss.handler('1', s.ctx);
  assert.match(s.sent[0][0], /取り下げ/);
  assert.match(s.sent[0][0], /未回答/);
  assert.match(s.widget![0], /#1/);
  s.handlers.get('message_start')!({ message: { role: 'user', content: [{ type: 'text', text: s.sent[0][0] }] } }, s.ctx);
  assert.equal(s.widget, undefined);
  s.entries.push({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: s.sent[0][0] }] } });
  s.handlers.get('session_start')!({}, s.ctx);
  assert.equal(s.widget, undefined);
});

test('a failed dismissal remains pending and can be retried', async () => {
  const s = setup();
  await s.ask({ ...question, mode: 'async' });
  await s.dismiss.handler('1', s.ctx);
  assert.match(s.widget![0], /#1/);
  await s.dismiss.handler('1', s.ctx);
  assert.equal(s.sent.length, 2);
});

test('invalid questions do not present empty or indistinguishable choices', async () => {
  const cases = [
    { question: '   ', options: ['A', 'B'], mode: 'sync' as const },
    { question: 'Choose?', options: ['A', '  '], mode: 'sync' as const },
    { question: 'Choose?', options: ['A', ' A '], mode: 'async' as const },
  ];
  for (const params of cases) {
    const s = setup();
    const result = await s.ask(params);
    assert.equal(result.details.status, 'invalid');
    assert.equal(result.isError, true);
    assert.equal(s.widget, undefined);
    assert.equal(s.entries.length, 0);
  }
});

test('answer without a number lets the user choose a pending question by title', async () => {
  const s = setup();
  for (const question of ['One?', 'Two?', 'Three?', 'Four?']) {
    await s.ask({ question, options: ['A', 'B'], mode: 'async' });
  }
  const dialogs: { title: string; choices: string[] }[] = [];
  s.ctx.ui.select = async (title, choices) => {
    dialogs.push({ title, choices });
    return dialogs.length === 1 ? choices.find(choice => choice.includes('#4') && choice.includes('Four?')) : '2. B';
  };
  await s.command.handler('', s.ctx);
  assert.equal(dialogs.length, 2);
  assert.equal(dialogs[1].title, 'Four?');
  assert.match(s.sent[0][0], /#4「Four\?」への回答: B/);
});

test('cancelling the pending question picker sends no answer', async () => {
  const s = setup();
  await s.ask({ ...question, mode: 'async' });
  let opened = false;
  s.ctx.ui.select = async () => { opened = true; return undefined; };
  await s.command.handler('', s.ctx);
  assert.equal(opened, true);
  assert.equal(s.sent.length, 0);
  assert.match(s.widget![0], /#1/);
});

test('a queued question picker does not open on a different session branch', async () => {
  const s = setup();
  const opened: Dialog[] = [];
  s.ctx.ui.select = title => new Promise<string | undefined>(resolve => opened.push({ title, resolve }));
  const first = s.ask({ ...question, mode: 'sync' });
  await new Promise(resolve => setImmediate(resolve));
  await s.ask({ question: 'Old branch?', options: ['A', 'B'], mode: 'async' });
  const picker = s.command.handler('', s.ctx);
  s.setBranch([]);
  s.handlers.get('session_tree')!({}, s.ctx);
  await s.ask({ question: 'New branch?', options: ['A', 'B'], mode: 'async' });
  opened[0].resolve('1. A');
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened.map(dialog => dialog.title), ['Choose?']);
  await picker;
});

test('a question picker open during branch navigation does not submit to the new branch', async () => {
  const s = setup();
  await s.ask({ ...question, mode: 'async' });
  const saved = [...s.entries];
  const opened: Dialog[] = [];
  s.ctx.ui.select = title => new Promise<string | undefined>(resolve => opened.push({ title, resolve }));
  const picker = s.command.handler('', s.ctx);
  await new Promise(resolve => setImmediate(resolve));
  s.setBranch(saved);
  s.handlers.get('session_tree')!({}, s.ctx);
  opened[0].resolve('#1 Choose?');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened.length, 1);
  await picker;
  assert.equal(s.sent.length, 0);
});

test('an answer dialog open during branch navigation does not submit to the new branch', async () => {
  const s = setup();
  await s.ask({ ...question, mode: 'async' });
  const saved = [...s.entries];
  const opened: Dialog[] = [];
  s.ctx.ui.select = title => new Promise<string | undefined>(resolve => opened.push({ title, resolve }));
  const answering = s.command.handler('1', s.ctx);
  await new Promise(resolve => setImmediate(resolve));
  s.setBranch(saved);
  s.handlers.get('session_tree')!({}, s.ctx);
  opened[0].resolve('1. A');
  await answering;
  assert.equal(s.sent.length, 0);
});
