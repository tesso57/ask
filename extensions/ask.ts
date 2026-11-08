import type { ExtensionAPI, ExtensionContext, MessageStartEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Question = { id: number; question: string; options: string[] };
type StoredEntry = { kind: "question"; question: Question } | { kind: "delivery"; id: number; message: string };

function isStoredEntry(value: unknown): value is StoredEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (entry.kind === "delivery") return Number.isSafeInteger(entry.id) && typeof entry.message === "string";
  if (entry.kind !== "question" || !entry.question || typeof entry.question !== "object") return false;
  const q = entry.question as Record<string, unknown>;
  return Number.isSafeInteger(q.id) && (q.id as number) > 0 && typeof q.question === "string" && Array.isArray(q.options) && q.options.every(option => typeof option === "string");
}

export default function (pi: ExtensionAPI) {
  let nextId = 1;
  const pending = new Map<number, Question>();
  const deliveries = new Map<string, Question>();
  const other = "その他（自由入力）";
  const entryType = "ask-user-state-v1";
  let dialogTail: Promise<void> = Promise.resolve();

  function summarize(text: string): string {
    const chars = [...text.replace(/\s+/g, " ").trim()];
    return chars.length > 24 ? `${chars.slice(0, 24).join("")}…` : chars.join("");
  }

  function refresh(ctx: ExtensionContext) {
    const questions = [...pending.values()];
    const visible = questions.slice(0, 3).map(q => `#${q.id} ${summarize(q.question)}`);
    const remaining = questions.length - visible.length;
    ctx.ui.setWidget("ask-pending", questions.length
      ? ["回答待ち: " + visible.join(" / ") + (remaining ? ` / ほか ${remaining} 件` : ""), "回答: /answer <番号>（番号一覧: /answer）"]
      : undefined);
  }

  async function choose(q: Question, ctx: ExtensionContext, signal?: AbortSignal, canOpen: () => boolean = () => true): Promise<string | undefined> {
    const previous = dialogTail;
    let release!: () => void;
    dialogTail = new Promise<void>(resolve => { release = resolve; });
    if (signal) {
      const ready = await new Promise<boolean>(resolve => {
        if (signal.aborted) { resolve(false); return; }
        const abort = () => resolve(false);
        signal.addEventListener("abort", abort, { once: true });
        previous.then(() => {
          signal.removeEventListener("abort", abort);
          resolve(true);
        });
      });
      if (!ready) {
        // Keep later dialogs behind the currently active one even though this caller has stopped waiting.
        void previous.then(release);
        return undefined;
      }
    } else {
      await previous;
    }
    try {
      if (signal?.aborted || !canOpen()) return undefined;
      return await showQuestion(q, ctx, signal);
    } finally {
      release();
    }
  }

  async function showQuestion(q: Question, ctx: ExtensionContext, signal?: AbortSignal): Promise<string | undefined> {
    // Number the items so duplicate labels and a label equal to 'other' stay distinct.
    const choices = q.options.map((option, i) => `${i + 1}. ${option}`);
    const custom = `${choices.length + 1}. ${other}`;
    const selected = await ctx.ui.select(q.question, [...choices, custom], { signal });
    if (selected === undefined) return undefined;
    if (selected === custom) {
      const answer = await ctx.ui.input("自由入力", undefined, { signal });
      return answer?.trim() || undefined;
    }
    const index = choices.indexOf(selected);
    return index < 0 ? undefined : q.options[index];
  }

  pi.registerTool({
    name: "ask_user",
    label: "Ask user",
    description: "Ask the user a question with choices and an always-available free-text answer. Use async when independent work can continue, even if the answer will be required later; use sync only when no useful independent work can proceed. Never treat an unanswered or cancelled question as approval.",
    promptGuidelines: ["Use ask_user when a user decision is needed. Prefer async when independent work can continue; do not proceed with work that depends on an unanswered required decision."],
    parameters: Type.Object({
      question: Type.String({ description: "A self-contained question" }),
      options: Type.Array(Type.String(), { minItems: 2, maxItems: 6, description: "Distinct concise choices; free text is provided automatically" }),
      mode: Type.Union([Type.Literal("async"), Type.Literal("sync")], { description: "async returns immediately; sync waits for the answer" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) return { content: [{ type: "text", text: "Cannot ask: this session has no interactive UI. No answer was given." }], details: { status: "unavailable" } };
      const q = { id: nextId++, question: params.question, options: params.options };
      if (params.mode === "sync") {
        const answer = await choose(q, ctx, signal);
        return { content: [{ type: "text", text: answer === undefined ? "Question cancelled; no answer was given." : `User answered: ${answer}` }], details: { status: answer === undefined ? "cancelled" : "answered", answer } };
      }
      pi.appendEntry(entryType, { kind: "question", question: q });
      pending.set(q.id, q);
      refresh(ctx);
      ctx.ui.notify(`質問 #${q.id}: ${summarize(q.question)} — /answer ${q.id} で回答`, "info");
      return { content: [{ type: "text", text: `Question #${q.id} is pending. Continue independent work; do not assume an answer or proceed with work requiring it. The user can answer with /answer ${q.id}.` }], details: { status: "pending", id: q.id } };
    },
  });

  pi.registerCommand("answer", {
    description: "Answer a pending ask_user question: /answer <number>",
    handler: async (args, ctx) => {
      const id = Number(args.trim());
      const q = pending.get(id);
      if (!q) {
        ctx.ui.notify(pending.size ? `質問番号を指定してください: ${[...pending.keys()].join(", ")}` : "回答待ちの質問はありません", "warning");
        return;
      }
      const answer = await choose(q, ctx, undefined, () => pending.get(id) === q);
      if (answer === undefined) {
        if (pending.get(id) === q) ctx.ui.notify(`質問 #${id} は回答待ちのままです`, "info");
        return;
      }
      // A session switch or another answer may have removed the question while the dialog was open.
      if (pending.get(id) !== q) return;
      const message = `質問 #${id}「${q.question}」への回答: ${answer}`;
      // Pi queues user messages without a delivery acknowledgment. Persist the attempt so
      // a later user message can acknowledge it, including after a session restart.
      pi.appendEntry(entryType, { kind: "delivery", id, message });
      deliveries.set(message, q);
      pi.sendUserMessage(message, { deliverAs: "steer" });
    },
  });

  function messageText(message: MessageStartEvent["message"]): string | undefined {
    if (message.role !== "user") return undefined;
    const content = message.content;
    return typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n");
  }

  function accept(text: string | undefined) {
    if (text === undefined) return false;
    const q = deliveries.get(text);
    if (!q || pending.get(q.id) !== q) return false;
    pending.delete(q.id);
    for (const [message, question] of deliveries) if (question === q) deliveries.delete(message);
    return true;
  }

  pi.on("message_start", (event, ctx) => {
    if (accept(messageText(event.message))) refresh(ctx);
  });

  function restore(ctx: ExtensionContext) {
    pending.clear();
    deliveries.clear();
    nextId = 1;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === entryType) {
        const data = entry.data;
        if (!isStoredEntry(data)) continue;
        if (data.kind === "question") {
          const q = data.question;
          pending.set(q.id, q);
          nextId = Math.max(nextId, q.id + 1);
        } else if (data.kind === "delivery") {
          const q = pending.get(data.id);
          if (q) deliveries.set(data.message, q);
        }
      } else if (entry.type === "message") {
        accept(messageText(entry.message));
      }
    }
    refresh(ctx);
  }
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
}
