import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { createFakeModel } from "./helpers/fake-model.ts";
import { createMockPi } from "./helpers/mock-pi.ts";

async function runQuestion(mode: "sync" | "async") {
  const dir = await mkdtemp(join(tmpdir(), "pi-ask-fake-"));
  const mock = createMockPi({ select: ["3. その他（自由入力）"], input: ["custom answer"] });
  const fake = createFakeModel([
    { content: [{ type: "toolCall", id: "ask-1", name: "ask_user", arguments: { question: "Choose?", options: ["A", "B"], mode } }] },
    { content: [{ type: "text", text: "continued" }] },
  ]);
  try {
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: join(dir, "agent"), additionalExtensionPaths: [resolve("extensions/index.ts")],
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: dir, agentDir: join(dir, "agent"), resourceLoader: loader, model: fake.model,
      sessionManager: SessionManager.inMemory(dir), noTools: "builtin",
    });
    try {
      session.modelRuntime.hasConfiguredAuth = () => true;
      session.agent.streamFunction = fake.stream;
      await session.bindExtensions({ uiContext: mock.context.ui, mode: "rpc" });
      await session.prompt("Choose how to proceed");
      const result = session.messages.find(message => message.role === "toolResult" && message.toolName === "ask_user");
      assert.ok(result && result.role === "toolResult");
      assert.equal(result.isError, false);
      assert.equal(fake.requests.length, 2);
      const delivered = fake.requests[1].messages.find(message => message.role === "toolResult" && message.toolName === "ask_user");
      assert.ok(delivered && delivered.role === "toolResult");
      assert.ok(session.messages.some(message => message.role === "assistant" && message.content.some(item => item.type === "text" && item.text === "continued")));
      return { result: delivered, dialogs: mock.dialogs, widgets: mock.widgets, branch: session.sessionManager.getBranch() };
    } finally {
      session.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a real Pi session returns a synchronous free-text answer to the model", async () => {
  const { result, dialogs, widgets } = await runQuestion("sync");
  assert.ok(result.content.some(item => item.type === "text" && item.text.includes("custom answer")));
  assert.deepEqual(dialogs.map(dialog => dialog.kind), ["select", "input"]);
  assert.equal(widgets.has("ask-pending"), false);
});

test("a real Pi session continues while an asynchronous question is pending", async () => {
  const { result, dialogs, widgets, branch } = await runQuestion("async");
  assert.ok(result.content.some(item => item.type === "text" && item.text.includes("pending")));
  assert.deepEqual(dialogs, []);
  assert.match(widgets.get("ask-pending")![0], /#1 Choose/);
  assert.ok(branch.some(entry => entry.type === "custom" && entry.customType === "ask-user-state-v1"));
});
