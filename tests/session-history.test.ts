import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAskHarness } from "./helpers/ask-harness.ts";

test("pending questions follow the real session branch", async () => {
  const session = SessionManager.inMemory(process.cwd());
  const root = session.appendMessage({ role: "user", content: [{ type: "text", text: "Start" }], timestamp: Date.now() });
  const s = createAskHarness(session);
  await s.ask({ question: "Choose?", options: ["A", "B"], mode: "async" });
  const questionBranch = session.getLeafId();
  assert.ok(questionBranch);
  assert.match(s.widget![0], /#1 Choose/);

  session.branch(root);
  s.handlers.get("session_tree")!({}, s.ctx);
  assert.equal(s.widget, undefined);
  session.branch(questionBranch);
  s.handlers.get("session_tree")!({}, s.ctx);
  assert.match(s.widget![0], /#1 Choose/);

  s.selections.push("1. A");
  await s.command.handler("1", s.ctx);
  const text = s.sent[0][0];
  const message = { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
  s.handlers.get("message_start")!({ message }, s.ctx);
  session.appendMessage(message);
  assert.equal(s.widget, undefined);
  const answeredBranch = session.getLeafId();
  assert.ok(answeredBranch);

  session.branch(questionBranch);
  s.handlers.get("session_tree")!({}, s.ctx);
  assert.match(s.widget![0], /#1 Choose/);
  session.branch(answeredBranch);
  s.handlers.get("session_tree")!({}, s.ctx);
  assert.equal(s.widget, undefined);
});

test("legacy control characters are sanitized without reopening answered history", async () => {
  const session = SessionManager.inMemory(process.cwd());
  const s = createAskHarness(session);
  const question = "Choose?\u001b]52;c;SGVsbG8=\u0007";
  const questionBranch = session.appendCustomEntry("ask-user-state-v1", {
    kind: "question", question: { id: 1, question, options: ["A", "B\u001b[2J"] },
  });
  const text = `質問 #1「${question}」への回答: A`;
  session.appendCustomEntry("ask-user-state-v1", { kind: "delivery", id: 1, message: text });
  session.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
  s.handlers.get("session_start")!({}, s.ctx);
  assert.equal(s.widget, undefined);

  session.branch(questionBranch);
  s.handlers.get("session_tree")!({}, s.ctx);
  assert.ok(!s.widget!.join("").includes("\u001b"));
  s.selections.push("2. B");
  await s.command.handler("1", s.ctx);
  assert.ok(!s.sent[0][0].includes("\u001b"));
});

test("pending questions restore even when older user messages have missing content", async () => {
  for (const content of [null, undefined, [null, { type: "text", text: null }, { type: "text", text: "Older note" }]]) {
    const session = SessionManager.inMemory(process.cwd());
    session.appendMessage({ role: "user", content, timestamp: Date.now() } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
    const s = createAskHarness(session);
    await s.ask({ question: "Choose?", options: ["A", "B"], mode: "async" });
    s.handlers.get("session_start")!({}, s.ctx);
    assert.match(s.widget![0], /#1 Choose/);
  }
});
