// C-WINDOW-1 ON, END TO END: the floor golden's harness (the same fixtures, scripted LLM and seams) with a
// composeGroundingPolicy record turning every switch on. The verdict-diff golden pins that with the record ABSENT the floor
// is byte-identical; this file pins what the record changes, through a full resolveFeatureCompose run:
//   - the large-target fixture (a ~39 KB file, line hint ~l.405-406): the decompose prompt shows the WHOLE file, through
//     the open drafter module's context (widened by the closed core) and the journal says so;
//   - the verify-red fixture (TS2304): the attempt record written to the gap store carries tc_lessons, the composer's
//     grounding and check_executed, and an attribution; the [fc-grounding-attr] line is journaled (the harness
//     normalises the tag to [fc-<ID>]);
//   - the ancestor-lessons fixture: a no-effect lock recorded by an attempt whose own check never ran is voided, and the
//     journal names it.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const iso = await isolateRuntimeRoot("cwin-on", { superRepo: true, who: "test/drafter-split/compose-grounding-on.test.ts" });
const { createHarness, CORPUS, BIG_SRC } = await import("./harness.js");
const H = createHarness(iso.root, iso.runtime);
afterAll(() => H.restore());

const ON = { read_widening: 1, edit_site_whole_file_max_chars: 49_152, void_partial_grounding_locks: 1, void_unexecuted_check_locks: 1, tc_symbol_window_lines: 30 };
const fixture = (prefix: string) => {
  const fx = CORPUS.find((f) => f.name.startsWith(prefix));
  expect(fx).toBeDefined();
  return fx!;
};
let seq = 0;
const run = async (prefix: string) => {
  const fc = await import(`../../src/resolvers/feature-compose.ts?cwin-on=${++seq}`);
  return H.run(fc, fixture(prefix));
};

describe("composeGroundingPolicy on: a full compose run", () => {
  it("setup: the isolated super-repo holds the record", () => {
    expect(typeof iso.superRepo).toBe("string");
    mkdirSync(join(iso.superRepo!, "policies"), { recursive: true });
    writeFileSync(join(iso.superRepo!, "policies", "composeGroundingPolicy.json"), JSON.stringify(ON));
    H.install();
  });

  it("large target with a line hint: the decompose prompt shows the whole file (head, the hinted site, tail)", async () => {
    expect(BIG_SRC.length).toBeGreaterThan(6000 * 4);
    const r = await run("directed / large target, explicit line hint");
    expect(r.decompose_prompt).toContain("export function filler0(n: number)");
    expect(r.decompose_prompt).toContain("const deepMarker = n * 3;");
    expect(r.decompose_prompt).toContain("export function filler519(n: number)");
    expect(r.console.some((l: string) => l.startsWith("[fc-grounding] whole-file grounding: repos/demo-vessel/src/big.ts"))).toBe(true);
    // drafter-v1 returns the core's already whole-file floor context unchanged, so the closed widening step
    // need not run. The prompt assertions above prove the whole target reached the drafter in either case.
  }, 60_000);

  it("verify red (TS2304): the attempt record carries tc_lessons, the composer's grounding, check_executed and the attribution", async () => {
    const r = await run("directed / verify red");
    const rows = r.gap_writes.map((w: string) => { try { return JSON.parse(w); } catch { return null; } }).filter(Boolean);
    const recs = rows.flatMap((g: any) => (g?.classification_metadata?.failure_lessons ?? []) as any[]).filter((l: any) => l && l.attribution);
    expect(recs.length).toBeGreaterThan(0);
    const last = recs[recs.length - 1];
    expect(last.tc_lessons?.[0]?.ts_code).toBe("TS2304");
    expect(last.grounding?.[0]).toMatchObject({ path: "repos/demo-vessel/src/compute.ts", mode: "whole" });
    expect(last.attribution).toMatchObject({ grounding_mode: "whole", locks_voided: 0, tc_lesson_consumed: false });
    expect(r.console.some((l: string) => /^\[fc-[^\]]+\] gap=ds-2 grounding_mode=whole locks_voided=0 tc_lesson_consumed=false/.test(l))).toBe(true);
  }, 60_000);

  it("ancestor lessons: the lock recorded by an attempt whose own check never ran is voided and journaled", async () => {
    const r = await run("directed / ancestor lessons");
    expect(r.console.some((l: string) => /^\[fc-grounding\] voided 1 no-effect lock\(s\) on gap ds-14: repos\/demo-vessel\/src\/compute\.ts:4-5 \(unexecuted_check\)$/.test(l))).toBe(true);
  }, 60_000);
});
