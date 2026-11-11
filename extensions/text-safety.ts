import { stripVTControlCharacters } from "node:util";

export const unsafeControls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

export function safeTerminalText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
