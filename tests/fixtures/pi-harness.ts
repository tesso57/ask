import register from "../../extensions/ask.ts";
export default function(pi) {
  pi.registerProvider("ask-test", {
    baseUrl: `http://127.0.0.1:${process.env.ASK_FAKE_PORT}/v1`, apiKey: "test", api: "openai-completions",
    models: [{id: "test-model", name: "test-model", reasoning: false, input: ["text"], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 128000, maxTokens: 8192}],
  });
  pi.on("input", event => event.source === "extension"
    ? { action: "transform", text: `Additional context: ${event.text}` }
    : undefined);
  register(pi);
}
