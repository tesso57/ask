import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { showInlineQuestion } from "../extensions/question-ui.ts";

function setup(signal?: AbortSignal) {
  let component!: Component & { dispose?(): void };
  const tui = { requestRender() {}, terminal: { rows: 24, columns: 80 } } as unknown as TUI;
  const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
  const notifications: string[] = [];
  const context = { ui: {
    notify(message: string) { notifications.push(message); },
    custom(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: string | undefined) => void) => Component) {
      return new Promise<string | undefined>(resolve => {
        component = factory(tui, theme, {} as KeybindingsManager, result => { component?.dispose?.(); resolve(result); });
      });
    },
  } } as unknown as ExtensionContext;
  const result = showInlineQuestion(context, { question: "Choose?", options: ["A", "B"] }, signal);
  return { result, notifications, get component() { return component; } };
}

test("typing immediately submits free text without selecting Other", async () => {
  const s = setup();
  assert.ok(s.component.render(60).some(line => line.includes("Choose?")));
  s.component.handleInput!("hello");
  const rendered = s.component.render(60).join("\n");
  assert.ok(rendered.includes("1. A") && rendered.includes("2. B") && rendered.includes("hello"));
  s.component.handleInput!("\r");
  assert.equal(await s.result, "hello");
});

test("arrow keys still select a predefined option", async () => {
  const s = setup();
  s.component.handleInput!("\u001b[B");
  s.component.handleInput!("\r");
  assert.equal(await s.result, "B");
});

test("Escape clears typed input and then cancels the question", async () => {
  const s = setup();
  s.component.handleInput!("hello");
  s.component.handleInput!("\u001b");
  s.component.handleInput!("\u001b");
  assert.equal(await s.result, undefined);
});

test("aborting closes the inline UI", async () => {
  const controller = new AbortController();
  const s = setup(controller.signal);
  controller.abort();
  assert.equal(await s.result, undefined);
});

test("selecting Other still focuses the inline input", async () => {
  const s = setup();
  s.component.handleInput!("\u001b[B");
  s.component.handleInput!("\u001b[B");
  s.component.handleInput!("\r");
  s.component.handleInput!("日本語の回答");
  s.component.handleInput!("\r");
  assert.equal(await s.result, "日本語の回答");
});

test("inline question renders within narrow terminal widths", () => {
  const s = setup();
  for (const width of [1, 2, 10, 40]) {
    for (const line of s.component.render(width)) {
      assert.ok(visibleWidth(line) <= width, `line ${JSON.stringify(line)} exceeds width ${width} with ${visibleWidth(line)}`);
    }
  }
});


test("control characters are not rendered or turned into an option selection", async () => {
  const s = setup();
  s.component.handleInput!("unsafe\u009dtext");
  assert.ok(!s.component.render(80).join("").includes("\u009d"));
  assert.ok(s.notifications.some(message => message.includes("制御文字")));
  let finished = false;
  void s.result.then(() => { finished = true; });
  s.component.handleInput!("\r");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  s.component.handleInput!("safe answer");
  s.component.handleInput!("\r");
  assert.equal(await s.result, "safe answer");
});


test("typing j or k enters text rather than moving the selection", async () => {
  const s = setup();
  s.component.handleInput!("j");
  s.component.handleInput!("k");
  s.component.handleInput!("\r");
  assert.equal(await s.result, "jk");
});
