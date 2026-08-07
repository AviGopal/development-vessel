import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The memory store is the substrate's authoritative memory, and this write path accepts
 * "at least a title or a body". That let a composed walk whose content binding produced
 * nothing write a titled shell and collect a success: the artifact exists, reads as
 * delivered, and holds nothing. The destructive variant is worse — the upsert replaced the
 * row wholesale, so an empty-bodied re-write BLANKED a note that already had content.
 */
// WORKSPACE_ROOT is captured in a module-level const in config.ts, so the store location
// must be set BEFORE the resolver module is first evaluated — hence the dynamic import.
const ORIGINAL_ROOT = process.env["WORKSPACE_ROOT"];
let dir: string;
let resolveMemoryNoteWrite: (p: { type: "memoryNote_write"; [k: string]: unknown }) => Promise<{ body: unknown }>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "memnote-"));
  process.env["WORKSPACE_ROOT"] = dir;
  ({ resolveMemoryNoteWrite } = await import("../../src/resolvers/memory-note"));
});

afterAll(async () => {
  if (ORIGINAL_ROOT === undefined) delete process.env["WORKSPACE_ROOT"];
  else process.env["WORKSPACE_ROOT"] = ORIGINAL_ROOT;
  await rm(dir, { recursive: true, force: true });
});

describe("resolveMemoryNoteWrite — empty body", () => {
  it("OBSERVED LIVE: refuses to create a titled shell with no body", async () => {
    // dispatch 08841a58 asked for a summary note and created it with body "".
    const res = await resolveMemoryNoteWrite({
      type: "memoryNote_write",
      title: "llm-resolver-vessel-purpose",
      content: "",
    });
    const body = res.body as { action?: string; reason?: string };
    expect(body.action).toBe("rejected");
    expect(body.reason).toContain("empty body");
  });

  it("treats whitespace as empty, since a walk that lost its content often emits a newline", async () => {
    const res = await resolveMemoryNoteWrite({
      type: "memoryNote_write",
      title: "whitespace-only",
      content: "   \n\t ",
    });
    expect((res.body as { action?: string }).action).toBe("rejected");
  });

  it("DESTRUCTIVE CASE: refuses to blank an existing note's body", async () => {
    const first = await resolveMemoryNoteWrite({
      type: "memoryNote_write",
      title: "vessel-summary",
      content: "The vessel resolves LLM completions through discovery.",
    });
    expect((first.body as { action?: string }).action).toBe("created");

    const second = await resolveMemoryNoteWrite({
      type: "memoryNote_write",
      title: "vessel-summary",
      content: "",
    });
    const body = second.body as { action?: string; reason?: string };
    expect(body.action).toBe("rejected");
    expect(body.reason).toContain("overwrite the existing body");

    // And the original content must still be there — refusing is only worth anything if
    // the note survived the refusal.
    const read = await resolveMemoryNoteWrite({
      type: "memoryNote_write",
      title: "vessel-summary",
      content: "The vessel resolves LLM completions through discovery.",
    });
    expect((read.body as { action?: string }).action).toBe("updated");
  });

  it("still accepts a real body, and still upserts", async () => {
    const a = await resolveMemoryNoteWrite({ type: "memoryNote_write", title: "t", content: "first" });
    expect((a.body as { action?: string }).action).toBe("created");
    const b = await resolveMemoryNoteWrite({ type: "memoryNote_write", title: "t", content: "second" });
    expect((b.body as { action?: string }).action).toBe("updated");
  });

  it("keeps rejecting a write with neither title nor body, as before", async () => {
    const res = await resolveMemoryNoteWrite({ type: "memoryNote_write" });
    expect((res.body as { action?: string }).action).toBe("rejected");
  });
});
