// A DECOMPOSE THAT ENDS WITH NO OPS SAYS WHY, AND THE WHY BECOMES A LESSON (check-first).
//
// When the anchor re-draft's JSON parse returned null, `plan` became null while the stale ops were
// kept, and the compose ended with "plan had no ops": no log line, no lesson, no trace. The drafter
// returning an empty ops list ended the same way, also unrecorded. A failure the drafter never hears
// about is a failure it repeats.
//
// CONTRACT: recordDecomposeNoOps logs a distinct line for each cause ("re-draft unparseable",
// "drafter returned no ops") and records a compose lesson through appendComposeLesson's signature with
// stage "decompose". The compose's no-ops exit calls it, and the anchor re-draft marks a null parse.
// The recorder is injected here so no gap store or concept-db is touched.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as fc from "../../src/resolvers/feature-compose.js";

type Rec = { cls: string; reason: string; gap: unknown; attempt: Record<string, unknown> | undefined };
let lines: string[] = [];
const spies: Array<ReturnType<typeof spyOn>> = [];
beforeEach(() => { lines = []; for (const m of ["log", "warn", "error"] as const) spies.push(spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); })); });
afterEach(() => { while (spies.length) spies.pop()!.mockRestore(); });

const recordDecomposeNoOps = (fc as Record<string, unknown>)["recordDecomposeNoOps"] as
  | ((cause: string, planRaw: string, gap: unknown, record: (cls: string, reason: string, vessels: string, gap?: unknown, attempt?: Record<string, unknown>) => Promise<void>) => Promise<void>)
  | undefined;

async function run(cause: string): Promise<Rec[]> {
  const recs: Rec[] = [];
  expect(typeof recordDecomposeNoOps).toBe("function");
  await recordDecomposeNoOps!(cause, "I could not produce JSON, here is prose", { id: "gap-null-redraft" }, async (cls, reason, _v, gap, attempt) => { recs.push({ cls, reason, gap, attempt }); });
  return recs;
}

describe("decompose with no usable plan", () => {
  it("[MUST-FAIL] an unparseable re-draft logs 're-draft unparseable' and records a decompose lesson naming it", async () => {
    const recs = await run("redraft_unparseable");
    expect(lines.some((l) => l.includes("re-draft unparseable") && l.includes("gap-null-redraft"))).toBe(true);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.reason).toContain("re-draft unparseable");
    expect(recs[0]!.attempt?.["stage"]).toBe("decompose");
    expect((recs[0]!.gap as { id?: string }).id).toBe("gap-null-redraft");
  });

  it("[MUST-FAIL] empty drafter ops record a lesson naming 'drafter returned no ops'", async () => {
    const recs = await run("drafter_no_ops");
    expect(recs).toHaveLength(1);
    expect(recs[0]!.reason).toContain("drafter returned no ops");
    expect(recs[0]!.attempt?.["stage"]).toBe("decompose");
  });

  it("[MUST-FAIL] the compose wires it: a null re-draft parse is marked, and the no-ops exit records the lesson", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/resolvers/feature-compose.ts"), "utf8");
    expect(/plan = parseJsonObject\(planRaw\);\s*if \(plan\) \{[^}]*\}\s*else \{\s*redraftUnparseable = true;/.test(src)).toBe(true);
    const rec = src.indexOf("await recordDecomposeNoOps(redraftUnparseable ? \"redraft_unparseable\" : \"drafter_no_ops\"");
    const exit = src.indexOf("stage: \"decompose\", error: noOpsError");
    expect(rec).toBeGreaterThan(0);
    expect(exit).toBeGreaterThan(rec);
  });
});
