import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Question = { id: number; question: string; options: string[] };

export default function (pi: ExtensionAPI) {
  let nextId = 1;
  const pending = new Map<number, Question>();
  const other = "その他（自由入力）";

  function refresh(ctx: any) {
    ctx.ui.setWidget("ask-pending", pending.size
      ? ["回答待ちの質問: " + [...pending.values()].map(q => `#${q.id} ${q.question}`).join(" / "), "回答: /answer <番号>"]
      : undefined);
  }

  async function choose(q: Question, ctx: any): Promise<string | undefined> {
    // Number the items so duplicate labels and a label equal to 'other' stay distinct.
    const choices = q.options.map((option, i) => `${i + 1}. ${option}`);
    const custom = `${choices.length + 1}. ${other}`;
    const selected = await ctx.ui.select(q.question, [...choices, custom]);
    if (selected === undefined) return undefined;
    if (selected === custom) {
      const answer = await ctx.ui.input("自由入力");
      return answer?.trim() || undefined;
    }
    const index = choices.indexOf(selected);
    return index < 0 ? undefined : q.options[index];
  }

  pi.registerTool({
    name: "ask_user",
    label: "Ask user",
    description: "Ask the user a question with choices and an always-available free-text answer. Use async for optional preferences while continuing independent work; use sync only when the answer is required before proceeding. Never treat an unanswered or cancelled question as approval.",
    promptGuidelines: ["Use ask_user when a user decision is needed. Prefer async when independent work can continue; do not proceed with work that depends on an unanswered required decision."],
    parameters: Type.Object({
      question: Type.String({ description: "A self-contained question" }),
      options: Type.Array(Type.String(), { minItems: 2, maxItems: 6, description: "Distinct concise choices; free text is provided automatically" }),
      mode: Type.Union([Type.Literal("async"), Type.Literal("sync")], { description: "async returns immediately; sync waits for the answer" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) return { content: [{ type: "text", text: "Cannot ask: this session has no interactive UI. No answer was given." }], details: { status: "unavailable" } };
      const q = { id: nextId++, question: params.question, options: params.options };
      if (params.mode === "sync") {
        const answer = await choose(q, ctx);
        return { content: [{ type: "text", text: answer === undefined ? "Question cancelled; no answer was given." : `User answered: ${answer}` }], details: { status: answer === undefined ? "cancelled" : "answered", answer } };
      }
      pending.set(q.id, q);
      refresh(ctx);
      ctx.ui.notify(`質問 #${q.id}: ${q.question} — /answer ${q.id} で回答`, "info");
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
      const answer = await choose(q, ctx);
      if (answer === undefined) {
        ctx.ui.notify(`質問 #${id} は回答待ちのままです`, "info");
        return;
      }
      // A session switch or another answer may have removed the question while the dialog was open.
      if (pending.get(id) !== q) return;
      pending.delete(id);
      refresh(ctx);
      pi.sendUserMessage(`質問 #${id}「${q.question}」への回答: ${answer}`, { deliverAs: "steer" });
    },
  });

  pi.on("session_start", (_event, ctx) => { pending.clear(); refresh(ctx); });
  pi.on("session_tree", (_event, ctx) => { pending.clear(); refresh(ctx); });
}
