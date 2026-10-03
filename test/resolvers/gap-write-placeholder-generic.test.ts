// EVERY UN-QUOTED {{...}} IS A PLACEHOLDER, WHATEVER IS INSIDE IT (check-first, 2026-10-03).
//
// The every-status placeholder gate matched only {{name}} / {{name.path}}. qa found five template forms
// that still reached the store: an index ({{goal[0]}}), optional chaining ({{goal?.id}}), a filter
// ({{ goal.id | upper }}), a broken path ({{ goal. id }}) and a block helper ({{#each x}}). Each is an
// unrendered template, and none is anything a gap means to say.
//
// CONTRACT: any {{...}} is refused in id, category, source, summary and metadata strings, at every status,
// except: a token quoted in backticks; JSX double braces (an object literal, {{ key: ... }}, or braces
// directly after "="); a value byte-identical to the stored row's value at that field (not the id).
// ${...} is not a placeholder here.
//
// SEAM: fresh module instance under this file's temp root; rows are SEEDED into the store file.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `gap-write-placeholder-generic-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import(`../../src/resolvers/substrate-gap.js?${"gap-write-placeholder-generic"}`);
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;
const { resolveSubstrateGapWrite, gapStoreRootForTest } = sg;

const STORE = join(ROOT, "gaps", "gaps.json");
const AT = "2026-10-03T10:00:00.000Z";
const realFetch = globalThis.fetch;
const REAL = { id: "placeholder-generic-fixture-gap", category: "systematic_failure", source: "human_reported", summary: "a real operator gap", detected_at: AT, status: "open", classification_metadata: { severity: "high" }, created_at: AT, updated_at: AT };
const stored = (id: string): Record<string, any> | undefined => (JSON.parse(readFileSync(STORE, "utf8")) as Array<Record<string, any>>).find((g) => g.id === id);
const writeSummary = (summary: string) => resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...REAL, summary } } as never, { vocabulary: null } as never) as Promise<{ shape: string; body: Record<string, unknown> }>;
const writeMeta = (note: string) => resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...REAL, classification_metadata: { note } } } as never, { vocabulary: null } as never) as Promise<{ shape: string; body: Record<string, unknown> }>;

beforeEach(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  writeFileSync(STORE, JSON.stringify([REAL]));
  globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

describe("substrateGap_write refuses any un-quoted double-brace template", () => {
  it("isolation: the store under test is the temp root of this file", () => {
    expect(gapStoreRootForTest()).toBe(ROOT);
  });

  it("[MUST-FAIL] an indexed slot goal[0] in the summary is refused", async () => {
    const r = await writeSummary("{{goal[0]}}");
    expect(r.shape).toBe("structuredError");
    expect(stored(REAL.id)!.summary).toBe(REAL.summary);
  });

  it("[MUST-FAIL] an optional-chaining slot goal?.id in the summary is refused", async () => {
    const r = await writeSummary("closing {{goal?.id}} now");
    expect(r.shape).toBe("structuredError");
  });

  it("[MUST-FAIL] a filtered slot with a pipe in metadata is refused", async () => {
    const r = await writeMeta("{{ goal.id | upper }}");
    expect(r.shape).toBe("structuredError");
    expect(String(r.body["field"])).toBe("gap.classification_metadata.note");
  });

  it("[MUST-FAIL] a broken path with a space after the dot is refused", async () => {
    const r = await writeSummary("{{ goal. id }}");
    expect(r.shape).toBe("structuredError");
  });

  it("[MUST-FAIL] a block helper #each is refused", async () => {
    const r = await writeMeta("{{#each x}}item{{/each}}");
    expect(r.shape).toBe("structuredError");
  });

  it("[CONTROL] a backtick-quoted filtered token is accepted", async () => {
    const r = await writeSummary("the binder leaves `{{ goal.id | upper }}` unrendered");
    expect(r.shape).toBe("substrateGapWriteResult");
  });

  it("[CONTROL] JSX object-literal braces and attribute braces are accepted", async () => {
    expect((await writeMeta("<div style={{ color: x }}>")).shape).toBe("substrateGapWriteResult");
    expect((await writeMeta("<Panel opts={{...rest}} />")).shape).toBe("substrateGapWriteResult");
  });

  it("[CONTROL] a dollar-brace template literal is not a placeholder", async () => {
    expect((await writeSummary("the url is built as ${base}/v2 and that is the bug")).shape).toBe("substrateGapWriteResult");
  });

  it("[CONTROL] an unterminated double brace is not a token", async () => {
    expect((await writeSummary("an object opens with {{ and never closes")).shape).toBe("substrateGapWriteResult");
  });
});
