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
  let branchRevision = 0;

  function summarize(text: string, limit = 24): string {
    const chars = [...text.replace(/\s+/g, " ").trim()];
    return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : chars.join("");
  }

  function refresh(ctx: ExtensionContext) {
    const questions = [...pending.values()];
    const visible = questions.slice(0, 3).map(q => `#${q.id} ${summarize(q.question)}`);
    const remaining = questions.length - visible.length;
    ctx.ui.setWidget("ask-pending", questions.length
      ? ["回答待ち: " + visible.join(" / ") + (remaining ? ` / ほか ${remaining} 件` : ""), "回答: /answer [番号]（省略時は一覧から選択）", "取り下げ: /ask-dismiss <番号>"]
      : undefined);
  }

  async function withDialog<T>(show: () => Promise<T | undefined>, signal?: AbortSignal, canOpen: () => boolean = () => true): Promise<T | undefined> {
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
      return await show();
    } finally {
      release();
    }
  }

  function choose(q: Question, ctx: ExtensionContext, signal?: AbortSignal, canOpen: () => boolean = () => true): Promise<string | undefined> {
    return withDialog(() => showQuestion(q, ctx, signal), signal, canOpen);
  }

  async function pickQuestion(ctx: ExtensionContext): Promise<Question | undefined> {
    const revision = branchRevision;
    return withDialog(async () => {
      const questions = [...pending.values()];
      if (!questions.length) return undefined;
      const choices = questions.map(q => `#${q.id} ${summarize(q.question, 100)}`);
      const selected = await ctx.ui.select("回答する質問を選択", choices);
      if (selected === undefined) return undefined;
      const q = questions[choices.indexOf(selected)];
      return q && branchRevision === revision && pending.get(q.id) === q ? q : undefined;
    }, undefined, () => branchRevision === revision);
  }

  async function showQuestion(q: Question, ctx: ExtensionContext, signal?: AbortSignal): Promise<string | undefined> {
    // Number choices so an option named like the free-text entry stays distinct.
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
      const options = params.options.map(option => option.trim());
      if (!params.question.trim() || options.some(option => !option) || new Set(options).size !== options.length) {
        return { content: [{ type: "text", text: "Provide a non-empty question and distinct, non-empty options." }], details: { status: "invalid" }, isError: true };
      }
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

  function findQuestion(args: string, ctx: ExtensionContext): Question | undefined {
    const q = pending.get(Number(args.trim()));
    if (!q) ctx.ui.notify(pending.size ? `質問番号を指定してください: ${[...pending.keys()].join(", ")}` : "回答待ちの質問はありません", "warning");
    return q;
  }

  function deliver(q: Question, message: string) {
    // Pi queues user messages without a delivery acknowledgment. Persist the attempt so
    // a later user message can acknowledge it, including after a session restart.
    pi.appendEntry(entryType, { kind: "delivery", id: q.id, message });
    deliveries.set(message, q);
    pi.sendUserMessage(message, { deliverAs: "steer" });
  }

  pi.registerCommand("answer", {
    description: "Answer a pending question: /answer [number]",
    handler: async (args, ctx) => {
      const revision = branchRevision;
      const q = args.trim() ? findQuestion(args, ctx) : pending.size ? await pickQuestion(ctx) : findQuestion(args, ctx);
      if (!q) return;
      const stillPending = () => branchRevision === revision && pending.get(q.id) === q;
      const answer = await choose(q, ctx, undefined, stillPending);
      if (answer === undefined) {
        if (stillPending()) ctx.ui.notify(`質問 #${q.id} は回答待ちのままです`, "info");
        return;
      }
      // A session switch or another answer may have removed the question while the dialog was open.
      if (!stillPending()) return;
      deliver(q, `質問 #${q.id}「${q.question}」への回答: ${answer}`);
    },
  });

  pi.registerCommand("ask-dismiss", {
    description: "Dismiss a pending question without answering it: /ask-dismiss <number>",
    handler: async (args, ctx) => {
      const q = findQuestion(args, ctx);
      if (!q) return;
      deliver(q, `ユーザーは質問 #${q.id}「${q.question}」を取り下げました。未回答であり、選択や承認を意味しません。`);
    },
  });

  function messageText(message: MessageStartEvent["message"]): string | undefined {
    if (message.role !== "user") return undefined;
    const content = message.content;
    return typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n");
  }

  function accept(text: string | undefined) {
    if (text === undefined) return false;
    // Input extensions may wrap a reply with context. A wrapped message can
    // mention several replies, so only acknowledge it if the question is unambiguous.
    let q = deliveries.get(text);
    if (!q) {
      for (const [message, question] of deliveries) {
        if (!text.includes(message)) continue;
        if (q && q !== question) return false;
        q = question;
      }
    }
    if (!q || pending.get(q.id) !== q) return false;
    pending.delete(q.id);
    for (const [message, question] of deliveries) if (question === q) deliveries.delete(message);
    return true;
  }

  pi.on("message_start", (event, ctx) => {
    if (accept(messageText(event.message))) refresh(ctx);
  });

  function restore(ctx: ExtensionContext) {
    branchRevision++;
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
