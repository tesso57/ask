import register from "../../extensions/index.ts";

type Params = { question: string; options: string[]; mode: "sync" | "async" };
type Result = { details: { status: string; answer?: string; id?: number } };
type Tool = {
  execute(id: string, params: Params, signal: AbortSignal | undefined, update: undefined, ctx: Context): Promise<Result>;
  executionMode?: string;
};
type TestMessage = { role: string; content: { type: string; text: string }[] };
type Entry = { type: "custom"; customType: string; data: unknown } | { type: "message"; message: TestMessage };
type Handler = (event: { message?: TestMessage }, context: Context) => void;
type Context = {
  hasUI: boolean;
  sessionManager: { getBranch(): Entry[] };
  ui: {
    select(title: string, choices: string[], options?: { signal?: AbortSignal }): Promise<string | undefined>;
    input(title: string, placeholder?: string, options?: { signal?: AbortSignal }): Promise<string | undefined>;
    notify(message: string, type?: string): void;
    setWidget(key: string, value: string[] | undefined): void;
  };
};
export type Dialog = { title: string; resolve(value: string | undefined): void };

export function createAskHarness() {
  let tool!: Tool;
  const commands = new Map<string, { handler(args: string, ctx: Context): Promise<void> }>();
  const handlers = new Map<string, Handler>();
  const sent: [string, { deliverAs: string }][] = [];
  const notifications: [string, string?][] = [];
  const selections: (string | undefined)[] = [];
  const inputs: (string | undefined)[] = [];
  const entries: Entry[] = [];
  let branch = entries;
  let widget: string[] | undefined;
  const mock = {
    registerTool(value: Tool) { tool = value; },
    registerCommand(name: string, value: { handler(args: string, ctx: Context): Promise<void> }) { commands.set(name, value); },
    on(name: string, handler: Handler) { handlers.set(name, handler); },
    sendUserMessage(...args: [string, { deliverAs: string }]) { sent.push(args); },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
  };
  register(mock as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
  const ctx: Context = { hasUI: true, sessionManager: { getBranch: () => branch }, ui: {
    async select() {
      if (!selections.length) throw new Error("No mock response for select");
      return selections.shift();
    },
    async input() {
      if (!inputs.length) throw new Error("No mock response for input");
      return inputs.shift();
    },
    notify(...args) { notifications.push(args); },
    setWidget(_key, value) { widget = value; },
  } };
  const ask = (params: Params, context = ctx, signal?: AbortSignal) => tool.execute('id', params, signal, undefined, context);
  return { ask, command: commands.get('answer')!, dismiss: commands.get('ask-dismiss')!, ctx, handlers, sent, notifications, selections, inputs, entries, setBranch: (value: Entry[]) => { branch = value; }, executionMode: tool.executionMode, get widget() { return widget; } };
}
