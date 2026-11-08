import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

test("Pi loads the extension and registers its tool and commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ask-smoke-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: join(dir, "agent"),
      additionalExtensionPaths: [resolve("extensions/index.ts")],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    const extension = result.extensions.find(item => item.resolvedPath === resolve("extensions/index.ts"));
    assert.ok(extension, "Pi did not load the extension");
    assert.ok(extension.tools.has("ask_user"));
    assert.ok(extension.commands.has("answer"));
    assert.ok(extension.commands.has("ask-dismiss"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("Pi continues to load the previously documented extension path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ask-legacy-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: join(dir, "agent"),
      additionalExtensionPaths: [resolve("extensions/ask.ts")],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    const extension = result.extensions.find(item => item.resolvedPath === resolve("extensions/ask.ts"));
    assert.ok(extension?.tools.has("ask_user"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
