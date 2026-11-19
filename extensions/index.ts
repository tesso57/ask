import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, MessageStartEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { showInlineQuestion } from "./question-ui.ts";
import { safeTerminalText, unsafeControls } from "./text-safety.ts";

type Question = { id: number; question: string; options: string[] };
type DeliveryMessage = Extract<MessageStartEvent["message"], { role: "custom" }>;
type StoredEntry =
  | { kind: "question"; question: Question }
  | { kind: "attempt"; id: number; attemptId: string; answerDigest?: string }
  | { kind: "delivery"; id: number; message: string };

const entryType = "ask-user-state-v1";
const deliveryType = "ask-user-delivery-v2";

function isStoredEntry(value: unknown): value is StoredEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (entry.kind === "attempt") return Number.isSafeInteger(entry.id) && typeof entry.attemptId === "string" && !!entry.attemptId;
  if (entry.kind === "delivery") return Number.isSafeInteger(entry.id) && typeof entry.message === "string";
  if (entry.kind !== "question" || !entry.question || typeof entry.question !== "object") return false;
  const q = entry.question as Record<string, unknown>;
  return Number.isSafeInteger(q.id) && (q.id as number) > 0 && typeof q.question === "string" && Array.isArray(q.options) && q.options.every(option => typeof option === "string");
}

export default function (pi: ExtensionAPI) {
  let nextId = 1;
  const pending = new Map<number, Question>();
  const deliveries = new Map<string, Question>();
  const answerDialogs = new Map<Question, Set<AbortController>>();
  const other = "その他（自由入力）";
  let dialogTail: Promise<void> = Promise.resolve();
  let branchRevision = 0;
  let branchController = new AbortController();
  let pendingController = new AbortController();

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

  async function pickQuestion(ctx: ExtensionContext, branchSignal: AbortSignal): Promise<Question | undefined> {
    const revision = branchRevision;
    const signal = AbortSignal.any([branchSignal, pendingController.signal]);
    return withDialog(async () => {
      const pageSize = 5;
      let page = 0;
      while (!signal.aborted && branchRevision === revision) {
        const questions = [...pending.values()];
        if (!questions.length) return undefined;
        const totalPages = Math.ceil(questions.length / pageSize);
        page = Math.min(page, totalPages - 1);
        const pageQuestions = questions.slice(page * pageSize, (page + 1) * pageSize);
        const choices = pageQuestions.map(q => `#${q.id} ${summarize(q.question, 60)}`);
        const previous = "← 前へ";
        const next = "次へ →";
        const options = [...choices, ...(page > 0 ? [previous] : []), ...(page + 1 < totalPages ? [next] : [])];
        const title = totalPages > 1 ? `回答する質問を選択 (${page + 1}/${totalPages})` : "回答する質問を選択";
        const selected = await ctx.ui.select(title, options, { signal });
        if (selected === undefined || signal.aborted || branchRevision !== revision) return undefined;
        if (selected === previous && page > 0) { page--; continue; }
        if (selected === next && page + 1 < totalPages) { page++; continue; }
        const q = pageQuestions[choices.indexOf(selected)];
        if (!q) return undefined;
        if (pending.get(q.id) === q) return q;
        ctx.ui.notify(`質問 #${q.id} は回答待ちではありません`, "info");
      }
      return undefined;
    }, signal, () => branchRevision === revision);
  }

  async function showQuestion(q: Question, ctx: ExtensionContext, signal?: AbortSignal): Promise<string | undefined> {
    if (ctx.mode === "tui") {
      const answer = await showInlineQuestion(ctx, q, signal);
      if (answer && unsafeControls.test(answer)) {
        ctx.ui.notify("制御文字を含む回答は送信できません", "warning");
        return undefined;
      }
      return answer;
    }
    const choices = q.options.map((option, i) => `${i + 1}. ${option}`);
    const custom = `${choices.length + 1}. ${other}`;
    const selected = await ctx.ui.select(q.question, [...choices, custom], { signal });
    if (selected === undefined) return undefined;
    if (selected === custom) {
      const answer = await ctx.ui.input("自由入力", undefined, { signal });
      if (answer && unsafeControls.test(answer)) {
        ctx.ui.notify("制御文字を含む回答は送信できません", "warning");
        return undefined;
      }
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
      if (!params.question.trim() || options.some(option => !option) || new Set(options).size !== options.length || [params.question, ...params.options].some(text => unsafeControls.test(text))) {
        return { content: [{ type: "text", text: "Provide a non-empty question and distinct, non-empty options without terminal control characters." }], details: { status: "invalid" }, isError: true };
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

  async function deliver(q: Question, ctx: ExtensionCommandContext, answer?: string) {
    const signal = branchController.signal;
    if (!ctx.isIdle() && !ctx.signal) await ctx.waitForIdle();
    if (signal.aborted || pending.get(q.id) !== q) return;
    const attemptId = randomUUID();
    const message = answer === undefined
      ? `ユーザーは質問 #${q.id}「${q.question}」を取り下げました。未回答であり、選択や承認を意味しません。`
      : `質問 #${q.id}「${q.question}」への回答: ${answer}`;
    const receipt = answer === undefined ? {} : { answerDigest: createHash("sha256").update(message).digest("hex") };
    pi.appendEntry(entryType, { kind: "attempt", id: q.id, attemptId, ...receipt } satisfies StoredEntry);
    deliveries.set(attemptId, q);
    pi.sendMessage({ customType: deliveryType, content: message, display: true, details: attemptId }, {
      deliverAs: "steer", triggerTurn: true,
    });
  }

  pi.registerCommand("answer", {
    description: "Answer a pending question: /answer [number]",
    handler: async (args, ctx) => {
      const revision = branchRevision;
      const branchSignal = branchController.signal;
      const q = args.trim() ? findQuestion(args, ctx) : pending.size ? await pickQuestion(ctx, branchSignal) : findQuestion(args, ctx);
      if (!q) return;
      const controller = new AbortController();
      const dialogs = answerDialogs.get(q) ?? new Set<AbortController>();
      dialogs.add(controller);
      answerDialogs.set(q, dialogs);
      const signal = AbortSignal.any([branchSignal, controller.signal]);
      const stillPending = () => !signal.aborted && branchRevision === revision && pending.get(q.id) === q;
      try {
        const answer = await choose(q, ctx, signal, stillPending);
        if (answer === undefined) {
          if (stillPending()) ctx.ui.notify(`質問 #${q.id} は回答待ちのままです`, "info");
          return;
        }
        if (!stillPending()) return;
        await deliver(q, ctx, answer);
      } finally {
        dialogs.delete(controller);
        if (!dialogs.size) answerDialogs.delete(q);
      }
    },
  });

  pi.registerCommand("ask-dismiss", {
    description: "Dismiss a pending question without answering it: /ask-dismiss <number>",
    handler: async (args, ctx) => {
      const q = findQuestion(args, ctx);
      if (!q) return;
      await deliver(q, ctx);
    },
  });

  function messageText(message: MessageStartEvent["message"]): string | undefined {
    if (message.role !== "user") return undefined;
    const content = message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return undefined;
    return content.flatMap(part => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
  }

  function accept(q: Question | undefined) {
    if (!q || pending.get(q.id) !== q) return false;
    pending.delete(q.id);
    if (!pending.size) {
      pendingController.abort();
      pendingController = new AbortController();
    }
    for (const controller of answerDialogs.get(q) ?? []) controller.abort();
    for (const [attemptId, question] of deliveries) if (question === q) deliveries.delete(attemptId);
    return true;
  }

  function acceptDelivery(details: unknown) {
    return typeof details === "string" && accept(deliveries.get(details));
  }

  function hasAttemptOnBranch(attemptId: unknown, ctx: ExtensionContext) {
    return typeof attemptId === "string" && ctx.sessionManager.getBranch().some(entry =>
      entry.type === "custom" && entry.customType === entryType &&
      isStoredEntry(entry.data) && entry.data.kind === "attempt" && entry.data.attemptId === attemptId,
    );
  }

  function discard(message: DeliveryMessage) {
    message.display = false;
    message.content = [];
    delete message.details;
  }

  pi.on("before_agent_start", (event, ctx) => {
    if (event.messageType !== "custom" || event.message.customType !== deliveryType) return;
    if (hasAttemptOnBranch(event.message.details, ctx)) return;
    discard(event.message);
    ctx.abort();
  });

  pi.on("message_start", ({ message }, ctx) => {
    if (message.role !== "custom" || message.customType !== deliveryType) return;
    if (!hasAttemptOnBranch(message.details, ctx)) {
      discard(message);
      return;
    }
    if (acceptDelivery(message.details)) refresh(ctx);
  });

  pi.on("context", ({ messages }) => {
    return { messages: messages.filter(message =>
      message.role !== "custom" || message.customType !== deliveryType || message.details !== undefined,
    ) };
  });

  function restore(ctx: ExtensionContext) {
    branchController.abort();
    branchController = new AbortController();
    branchRevision++;
    pending.clear();
    deliveries.clear();
    nextId = 1;
    const legacy = new Map<string, Question>();
    const forgetLegacy = (q: Question) => {
      for (const [message, question] of legacy) if (question === q) legacy.delete(message);
    };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === entryType) {
        const data = entry.data;
        if (!isStoredEntry(data)) continue;
        if (data.kind === "question") {
          const q = { ...data.question, question: safeTerminalText(data.question.question), options: data.question.options.map(safeTerminalText) };
          pending.set(q.id, q);
          nextId = Math.max(nextId, q.id + 1);
        } else {
          const q = pending.get(data.id);
          if (!q) continue;
          if (data.kind === "attempt") {
            deliveries.set(data.attemptId, q);
            forgetLegacy(q);
          } else if (data.message) {
            legacy.set(data.message, q);
          }
        }
      } else if (entry.type === "custom_message" && entry.customType === deliveryType) {
        acceptDelivery(entry.details);
      } else if (entry.type === "message" && legacy.size) {
        const text = messageText(entry.message);
        if (text === undefined) continue;
        const exact = legacy.get(text);
        const matching = exact ? [exact] : [...new Set(
          [...legacy].filter(([message]) => text.includes(message)).map(([, q]) => q),
        )];
        const q = matching[0];
        if (matching.length === 1 && accept(q)) forgetLegacy(q);
      }
    }
    refresh(ctx);
  }
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => branchController.abort());
}
