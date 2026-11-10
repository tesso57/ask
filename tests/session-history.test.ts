import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionToolContext, SessionManager } from "@earendil-works/pi-coding-agent";
import register from "../extensions/index.ts";
import { createMockPi } from "./helpers/mock-pi.ts";

function setup() {
  const mock = createMockPi();
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
  const text = mock.userMessages[0].content;
  assert.ok(typeof text === "string");
  const message = { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
  await mock.emit("message_start", { type: "message_start", message });
  session.appendMessage(message);
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
  const sent = mock.userMessages[0].content;
  assert.ok(typeof sent === "string");
  assert.ok(!sent.includes("\u001b"));
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
