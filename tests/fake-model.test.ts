import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { createFakeModel } from "./helpers/fake-model.ts";
import { createMockPi } from "./helpers/mock-pi.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

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

test("Pi keeps an answer in its source branch when a user-input wrapper delays delivery", { timeout: 5000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ask-tree-"));
  const mock = createMockPi({ select: ["1. A"] });
  const fake = createFakeModel([{ content: [{ type: "text", text: "received" }] }]);
  const manager = SessionManager.inMemory(dir);
  const stateType = "ask-user-state-v1";
  const question = { id: 1, question: "Choose?", options: ["A", "B"] };
  const answer = "質問 #1「Choose?」への回答: A";
  const root = manager.appendMessage({ role: "user", content: "Start", timestamp: Date.now() });
  const source = manager.appendCustomEntry(stateType, { kind: "question", question });
  manager.branch(root);
  manager.appendCustomEntry(stateType, { kind: "question", question });
  const destination = manager.appendCustomEntry(stateType, { kind: "delivery", id: 1, message: answer });
  manager.branch(source);
  const inputEntered = deferred();
  const releaseInput = deferred();
  const accepted = deferred();
  const settled = deferred();
  try {
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: join(dir, "agent"), additionalExtensionPaths: [resolve("extensions/index.ts")],
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        pi.on("input", async event => {
          if (event.source !== "extension") return;
          inputEntered.resolve();
          await releaseInput.promise;
          return { action: "transform", text: `Wrapped: ${event.text}` };
        });
        pi.on("message_start", event => {
          if ((event.message.role === "custom" || event.message.role === "user") &&
              JSON.stringify(event.message.content).includes(answer)) accepted.resolve();
        });
        pi.on("agent_settled", () => { settled.resolve(); });
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: dir, agentDir: join(dir, "agent"), resourceLoader: loader, model: fake.model,
      sessionManager: manager, noTools: "builtin",
    });
    try {
      session.modelRuntime.hasConfiguredAuth = () => true;
      session.agent.streamFunction = fake.stream;
      await session.bindExtensions({ uiContext: mock.context.ui, mode: "rpc" });
      await session.prompt("/answer 1");
      const milestone = await Promise.race([
        inputEntered.promise.then(() => "in input wrapper"),
        accepted.promise.then(() => "accepted"),
      ]);
      if (milestone === "in input wrapper") {
        await session.navigateTree(destination);
        releaseInput.resolve();
      }
      await settled.promise;
      assert.ok(fake.requests[0].messages.some(message => message.role === "user" && JSON.stringify(message.content).includes(answer)));
      const branch = manager.getBranch();
      assert.ok(branch.some(entry => entry.id === source), "the received answer must be on the source branch");
      assert.equal(mock.widgets.has("ask-pending"), false);
      const answered = manager.getLeafId()!;
      await session.navigateTree(destination);
      assert.match(mock.widgets.get("ask-pending")![0], /#1 Choose/);
      await session.navigateTree(answered);
      assert.equal(mock.widgets.has("ask-pending"), false);
    } finally {
      releaseInput.resolve();
      session.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a deferred delivery during Pi settlement cannot send its answer to a sibling branch", { timeout: 5000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ask-settle-"));
  const manager = SessionManager.inMemory(dir);
  const root = manager.appendMessage({ role: "user", content: "Start", timestamp: Date.now() });
  const data = { kind: "question", question: { id: 1, question: "Choose?", options: ["A", "B"] } };
  const destination = manager.appendCustomEntry("ask-user-state-v1", data);
  manager.branch(root);
  const source = manager.appendCustomEntry("ask-user-state-v1", data);
  const settling = deferred();
  const releaseSettlement = deferred();
  const deliverySettled = deferred();
  const selectionOpened = deferred();
  const releaseSelection = deferred();
  let settlements = 0;
  const errors: unknown[] = [];
  let abortedContext: string | undefined;
  const mock = createMockPi({ select: ["1. A", "1. A"] });
  const select = mock.context.ui.select;
  mock.context.ui.select = async (...args) => {
    selectionOpened.resolve();
    await releaseSelection.promise;
    return select(...args);
  };
  const fake = createFakeModel([
    { content: [{ type: "text", text: "first" }] },
    { content: [{ type: "text", text: "second" }] },
  ]);
  try {
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: join(dir, "agent"), additionalExtensionPaths: [resolve("extensions/index.ts")],
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        pi.on("agent_settled", async () => {
          if (++settlements > 1) {
            deliverySettled.resolve();
            return;
          }
          settling.resolve();
          await releaseSettlement.promise;
        });
      }],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: dir, agentDir: join(dir, "agent"), resourceLoader: loader, model: fake.model,
      sessionManager: manager, noTools: "builtin",
    });
    try {
      session.modelRuntime.hasConfiguredAuth = () => true;
      session.agent.streamFunction = (model, context, options) => {
        if (options?.signal?.aborted) {
          abortedContext = JSON.stringify(context.messages);
          options.signal.throwIfAborted();
        }
        return fake.stream(model, context, options);
      };
      await session.bindExtensions({ uiContext: mock.context.ui, mode: "rpc", onError: error => errors.push(error) });
      const answering = session.prompt("/answer 1");
      await selectionOpened.promise;
      const initialRun = session.prompt("Prime the run");
      await settling.promise;
      releaseSelection.resolve();
      await answering;
      const sourceAttempt = manager.getLeafId()!;
      assert.ok(manager.getBranch().some(entry => entry.id === source));
      assert.equal(manager.getLeafEntry()?.type, "custom");
      assert.equal((await session.navigateTree(destination)).cancelled, false);
      releaseSettlement.resolve();
      await initialRun;
      await deliverySettled.promise;

      assert.deepEqual(errors, []);
      assert.equal(fake.requests.length, 1, "the deferred answer must not prompt the model on the sibling branch");
      assert.ok(abortedContext);
      assert.ok(!abortedContext.includes("への回答: A"));
      assert.ok(!JSON.stringify(manager.getBranch()).includes("への回答: A"));
      assert.match(mock.widgets.get("ask-pending")![0], /#1 Choose/);
      await session.navigateTree(sourceAttempt);
      assert.match(mock.widgets.get("ask-pending")![0], /#1 Choose/);
      await session.prompt("/answer 1");
      await session.waitForIdle();
      assert.equal(fake.requests.length, 2);
      assert.ok(fake.requests[1].messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("への回答: A")));
      assert.equal(mock.widgets.has("ask-pending"), false);
    } finally {
      releaseSelection.resolve();
      releaseSettlement.resolve();
      session.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
