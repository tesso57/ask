import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionToolContext, SessionManager } from "@earendil-works/pi-coding-agent";
import register from "../extensions/index.ts";
import { createMockPi } from "./helpers/mock-pi.ts";

function setup() {
  const mock = createMockPi();
  mock.context.mode = "rpc";
  register(mock.pi);
  const tool = mock.tools.get("ask_user");
  assert.ok(tool);
  const ask = () => tool.execute("test", { question: "Choose?", options: ["A", "B"], mode: "async" }, new AbortController().signal, undefined, mock.context as unknown as ExtensionToolContext);
  return { ...mock, ask };
}

test("pending questions follow the real session branch", async () => {
  const mock = setup();
  const session = mock.sessionManager;
  const root = session.appendMessage({ role: "user", content: [{ type: "text", text: "Start" }], timestamp: Date.now() });
  await mock.ask();
  const questionBranch = session.getLeafId();
  assert.ok(questionBranch);
  assert.match(mock.widgets.get("ask-pending")![0], /#1 Choose/);

  session.branch(root);
  await mock.emit("session_tree", { type: "session_tree" });
  assert.equal(mock.widgets.has("ask-pending"), false);
  session.branch(questionBranch);
  await mock.emit("session_tree", { type: "session_tree" });
  assert.match(mock.widgets.get("ask-pending")![0], /#1 Choose/);

  mock.responses.select.push("1. A");
  await mock.runCommand("answer", "1");
  const message = { ...mock.messages[0].message, role: "custom" as const, timestamp: Date.now() };
  await mock.emit("message_start", { type: "message_start", message });
  session.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
  assert.equal(mock.widgets.has("ask-pending"), false);
  const answeredBranch = session.getLeafId();
  assert.ok(answeredBranch);

  session.branch(questionBranch);
  await mock.emit("session_tree", { type: "session_tree" });
  assert.match(mock.widgets.get("ask-pending")![0], /#1 Choose/);
  session.branch(answeredBranch);
  await mock.emit("session_tree", { type: "session_tree" });
  assert.equal(mock.widgets.has("ask-pending"), false);
});

test("legacy control characters are sanitized without reopening answered history", async () => {
  const mock = setup();
  const session = mock.sessionManager;
  const question = "Choose?\u001b]52;c;SGVsbG8=\u0007";
  const questionBranch = session.appendCustomEntry("ask-user-state-v1", {
    kind: "question", question: { id: 1, question, options: ["A", "B\u001b[2J"] },
  });
  const text = `質問 #1「${question}」への回答: A`;
  session.appendCustomEntry("ask-user-state-v1", { kind: "delivery", id: 1, message: text });
  session.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
  await mock.emit("session_start", { type: "session_start" });
  assert.equal(mock.widgets.has("ask-pending"), false);

  session.branch(questionBranch);
  await mock.emit("session_tree", { type: "session_tree" });
  assert.ok(!mock.widgets.get("ask-pending")!.join("").includes("\u001b"));
  mock.responses.select.push("2. B");
  await mock.runCommand("answer", "1");
  const sent = mock.messages[0].message.content;
  assert.ok(typeof sent === "string");
  assert.ok(!sent.includes("\u001b"));
});

test("legacy wrapped answers restore while unreceived attempts stay pending", async () => {
  const mock = setup();
  const session = mock.sessionManager;
  await mock.ask();
  const text = "質問 #1「Choose?」への回答: A";
  const attempt = session.appendCustomEntry("ask-user-state-v1", { kind: "delivery", id: 1, message: text });
  const message = { role: "user" as const, content: `Context: ${text}\nEnd`, timestamp: Date.now() };
  await mock.emit("session_start", { type: "session_start" });
  assert.match(mock.widgets.get("ask-pending")![0], /#1 Choose/);
  await mock.emit("message_start", { type: "message_start", message });
  assert.match(mock.widgets.get("ask-pending")![0], /#1 Choose/);
  session.appendMessage(message);
  await mock.emit("session_start", { type: "session_start" });
  assert.equal(mock.widgets.has("ask-pending"), false);

  session.branch(attempt);
  await mock.emit("session_tree", { type: "session_tree" });
  await mock.runCommand("ask-dismiss", "1");
  const sent = mock.messages[0].message;
  session.appendMessage(message);
  await mock.emit("session_start", { type: "session_start" });
  assert.match(mock.widgets.get("ask-pending")![0], /#1 Choose/);
  session.appendCustomMessageEntry(sent.customType, sent.content, sent.display, sent.details);
  await mock.emit("session_start", { type: "session_start" });
  assert.equal(mock.widgets.has("ask-pending"), false);
});

test("a delayed receipt on a sibling branch cannot acknowledge an identical answer", async () => {
  const mock = setup();
  const session = mock.sessionManager;
  const root = session.appendMessage({ role: "user", content: "Start", timestamp: Date.now() });
  const tree = () => mock.emit("session_tree", { type: "session_tree" });
  const answer = async () => {
    mock.responses.select.push("1. A");
    await mock.runCommand("answer", "1");
    return mock.messages.at(-1)!.message;
  };
  const receive = async (sent: (typeof mock.messages)[number]["message"]) => {
    await mock.emit("message_start", {
      type: "message_start", message: { ...sent, role: "custom", timestamp: Date.now() },
    });
    session.appendCustomMessageEntry(sent.customType, sent.content, sent.display, sent.details);
  };

  await mock.ask();
  const old = await answer();
  const oldBranch = session.getLeafId()!;
  session.branch(root);
  await tree();
  await mock.ask();
  const current = await answer();
  const retry = await answer();
  assert.equal(current.content, old.content);
  assert.equal(retry.content, old.content);
  assert.equal(new Set([old.details, current.details, retry.details]).size, 3);

  await receive({ ...old, content: `Wrapped: ${old.content}` });
  assert.match(mock.widgets.get("ask-pending")![0], /#1 Choose/);
  await tree();
  assert.match(mock.widgets.get("ask-pending")![0], /#1 Choose/);
  await receive(retry);
  assert.equal(mock.widgets.has("ask-pending"), false);
  await receive(current);
  await tree();
  assert.equal(mock.widgets.has("ask-pending"), false);

  session.branch(oldBranch);
  await tree();
  assert.match(mock.widgets.get("ask-pending")![0], /#1 Choose/);
  await receive(old);
  assert.equal(mock.widgets.has("ask-pending"), false);
});

test("pending questions restore even when older user messages have missing content", async () => {
  for (const content of [null, undefined, [null, { type: "text", text: null }, { type: "text", text: "Older note" }]]) {
    const mock = setup();
    const session = mock.sessionManager;
    session.appendMessage({ role: "user", content, timestamp: Date.now() } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
    await mock.ask();
    await mock.emit("session_start", { type: "session_start" });
    assert.match(mock.widgets.get("ask-pending")![0], /#1 Choose/);
  }
});
