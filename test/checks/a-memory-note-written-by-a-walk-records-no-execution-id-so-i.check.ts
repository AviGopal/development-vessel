import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mod from "../../src/resolvers/memory-note";

async function withEmptyStore(run: () => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "memory-note-provenance-"));
  const previous = process.env["WORKSPACE_ROOT"];
  process.env["WORKSPACE_ROOT"] = root;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env["WORKSPACE_ROOT"];
    else process.env["WORKSPACE_ROOT"] = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasRunProvenance(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const field of ["execution_id", "executionId", "dispatch_id", "dispatchId"] as const) {
    const id = value[field];
    if (typeof id === "string" && id.trim().length > 0) return true;
  }
  const traces = value["provenance_trace_ids"];
  return Array.isArray(traces) && traces.some(
    (id: unknown) => typeof id === "string" && id.trim().length > 0,
  );
}

test("memoryNote read-back of a memoryNote_write output has nonempty run provenance (true)", async () => {
  await withEmptyStore(async () => {
    await mod.resolveMemoryNoteWrite({
      type: "memoryNote_write",
      note: {
        title: "Downstream evidence",
        body: "A finding produced during a walk.",
        type: "finding",
      },
    });

    // Exercise the actual memoryNote return statement at memory-note.ts:127.
    // No provenance is supplied in the input: an echo cannot satisfy this check.
    const result = await mod.resolveMemoryNote({ type: "memoryNote" });
    expect(result).toMatchObject({ shape: "memoryNote", body: { total: 1 } });
    const body: unknown = result.body;
    const notes: unknown = isRecord(body) ? body["notes"] : undefined;
    expect(Array.isArray(notes)).toBe(true);
    const note: unknown = Array.isArray(notes) ? notes[0] : undefined;
    expect(hasRunProvenance(note)).toBe(true);
  });
});

test("CONTROL: reading an empty memoryNote store returns notes [] and total 0", async () => {
  await withEmptyStore(async () => {
    const result = await mod.resolveMemoryNote({ type: "memoryNote" });
    expect(result).toMatchObject({
      shape: "memoryNote",
      body: { notes: [], total: 0 },
    });
  });
});
