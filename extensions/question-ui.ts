import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type EditorTheme } from "@earendil-works/pi-tui";
import { unsafeControls } from "./text-safety.ts";

type Question = { question: string; options: string[] };

/** TUI-only picker: typing starts a free-text answer without leaving the options. */
export async function showInlineQuestion(ctx: ExtensionContext, question: Question, signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted) return undefined;
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    let selected = 0;
    let editing = false;
    const editorTheme: EditorTheme = {
      borderColor: text => theme.fg("accent", text),
      selectList: {
        selectedPrefix: text => theme.fg("accent", text),
        selectedText: text => theme.fg("accent", text),
        description: text => theme.fg("muted", text),
        scrollInfo: text => theme.fg("dim", text),
        noMatch: text => theme.fg("warning", text),
      },
    };
    const editor = new Editor(tui, editorTheme);
    const refresh = () => tui.requestRender();
    const abort = () => done(undefined);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) queueMicrotask(abort);
    editor.onChange = value => {
      if (unsafeControls.test(value)) {
        editor.setText("");
        ctx.ui.notify("制御文字を含む入力は破棄しました", "warning");
      }
    };
    editor.onSubmit = value => {
      const answer = value.trim();
      if (answer) done(answer);
    };

    return {
      get focused() { return editor.focused; },
      set focused(value: boolean) { editor.focused = value; },
      invalidate() { editor.invalidate(); },
      dispose() { signal?.removeEventListener("abort", abort); },
      handleInput(data: string) {
        if (matchesKey(data, Key.escape)) {
          if (editing) { editing = false; editor.setText(""); refresh(); }
          else done(undefined);
          return;
        }
        if (!editing) {
          if (matchesKey(data, Key.up)) { selected = Math.max(0, selected - 1); refresh(); return; }
          if (matchesKey(data, Key.down)) { selected = Math.min(question.options.length, selected + 1); refresh(); return; }
          if (matchesKey(data, Key.enter)) {
            if (selected < question.options.length) done(question.options[selected]);
            else { editing = true; refresh(); }
            return;
          }
          editing = true;
        }
        editor.handleInput(data);
        refresh();
      },
      render(width: number) {
        const lines: string[] = [];
        const w = Math.max(1, width);
        const add = (prefix: string, text: string) => {
          if (visibleWidth(prefix) >= w) {
            lines.push(...wrapTextWithAnsi(prefix + text, w));
            return;
          }
          const available = w - visibleWidth(prefix);
          const wrapped = wrapTextWithAnsi(text, available);
          wrapped.forEach((line, i) => lines.push((i ? " ".repeat(visibleWidth(prefix)) : prefix) + line));
        };
        lines.push(theme.fg("accent", "─".repeat(w)));
        add(" ", theme.fg("text", question.question));
        lines.push("");
        for (const [index, option] of [...question.options, "その他（自由入力）"].entries()) {
          const active = !editing && index === selected;
          add(active ? theme.fg("accent", "> ") : "  ", theme.fg(active ? "accent" : "text", `${index + 1}. ${option}`));
        }
        lines.push("");
        add(" ", theme.fg("muted", "自由入力：そのまま入力できます"));
        lines.push(...editor.render(w));
        add(" ", theme.fg("dim", editing ? "Enter で送信 · Esc で入力を消す" : "↑↓ で選択 · Enter で決定 · 直接入力もできます"));
        lines.push(theme.fg("accent", "─".repeat(w)));
        return lines.map(line => visibleWidth(line) > w ? truncateToWidth(line, w, "") : line);
      },
    };
  }, { blocked: { kind: "question", message: question.question } });
}
