import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionToolContext, SessionManager } from "@earendil-works/pi-coding-agent";
import register from "../extensions/index.ts";
import { createMockPi } from "./helpers/mock-pi.ts";

type Question = { id: number; question: string };
type StateRecord = { kind: "question"; question: Question } | { kind: "attempt"; id: number; attemptId: string };

function expectedPending(path: ReturnType<SessionManager["getBranch"]>): Question[] {
  const records = path.flatMap((entry, position) =>
    entry.type === "custom" && entry.customType === "ask-user-state-v1"
      ? [{ data: entry.data as StateRecord, position }]
      : [],
  );
  // A question is resolved if the path contains an attempt after it and a receipt after that attempt.
  return records.flatMap(({ data, position }) => {
    if (data.kind !== "question") return [];
    const received = records.some(({ data: attempt, position: sentAt }) =>
      sentAt > position && attempt.kind === "attempt" && attempt.id === data.question.id &&
      path.some((entry, receivedAt) => receivedAt > sentAt && entry.type === "custom_message" &&
        entry.customType === "ask-user-delivery-v2" && entry.details === attempt.attemptId),
    );
    return received ? [] : [data.question];
  });
}

test("v2 pending questions agree with the ordered branch history before and after restoration", async () => {
  const mock = createMockPi();
  mock.context.mode = "rpc";
  register(mock.pi);
  const session = mock.sessionManager;
  const tool = mock.tools.get("ask_user")!;
  const ask = (question: string) => tool.execute("test", { question, options: ["A", "B"], mode: "async" },
    new AbortController().signal, undefined, mock.context as unknown as ExtensionToolContext);
  const dismiss = async () => {
    await mock.runCommand("ask-dismiss", "1");
    return mock.messages.at(-1)!.message;
  };
  const receive = async (sent: (typeof mock.messages)[number]["message"]) => {
    const message = { ...sent, role: "custom" as const, timestamp: 0 };
    await mock.emit("message_start", { type: "message_start", message });
    session.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
  };
  const check = (expectedIds: number[]) => {
    const pending = expectedPending(session.getBranch());
    assert.deepEqual(pending.map(q => q.id), expectedIds);
    const displayed = pending.slice(0, 3).map(q => `#${q.id} ${q.question}`).join(" / ");
    const more = pending.length > 3 ? ` / ほか ${pending.length - 3} 件` : "";
    assert.equal(mock.widgets.get("ask-pending")?.[0], pending.length ? `回答待ち: ${displayed}${more}` : undefined);
  };
  const navigate = async (leaf: string) => {
    session.branch(leaf);
    await mock.emit("session_tree", { type: "session_tree" });
  };

  const root = session.appendMessage({ role: "user", content: "Start", timestamp: 0 });
  for (const question of ["First?", "Second?", "Third?", "Fourth?"]) await ask(question);
  const first = await dismiss();
  const retry = await dismiss();
  assert.equal(retry.content, first.content);
  assert.notEqual(retry.details, first.details);
  const beforeReceipt = session.getLeafId()!;

  const quote = { role: "user" as const, content: `Quote: ${retry.content}`, timestamp: 0 };
  await mock.emit("message_start", { type: "message_start", message: quote });
  session.appendMessage(quote);
  check([1, 2, 3, 4]);
  await receive(retry);
  check([2, 3, 4]);
  await receive(retry);
  await receive(first);
  check([2, 3, 4]);
  const answered = session.getLeafId()!;
  await mock.emit("session_start", { type: "session_start" });
  check([2, 3, 4]);

  await navigate(root);
  await ask("First?");
  const sibling = await dismiss();
  assert.equal(sibling.content, first.content);
  await receive(first);
  check([1]);
  await receive(sibling);
  check([]);

  await navigate(beforeReceipt);
  check([1, 2, 3, 4]);
  await navigate(answered);
  check([2, 3, 4]);
});
