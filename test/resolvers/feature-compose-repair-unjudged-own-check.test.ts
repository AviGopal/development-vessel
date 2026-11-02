// AN UNJUDGED OWN CHECK REACHES REPAIR AS WHAT IT IS, AND ITS NO-EDIT ROUND DOES NOT END THE LOOP.
//
// Replayed from a performance-gap compose's repair round 2: the gap's own check ran on the draft and printed no "(pass)"
// and no "(fail)" line (ran:true, red:[], unjudged:true). The verify result's own block carried failing: [], the same as a
// green run, so the next repair prompt logged own_failing 0, the round was told nothing was failing, wrote nothing, and
// `if (!anyFixed) break` ended the repair with rounds left. The draft that hung the check was never repaired.
//
//   [MUST-FAIL, independent: exports present at the parent] the repair prompt for that verify result names the unjudged
//               own check ("killed or crashed before any test finished", "fix the cause") and quotes the run's tail; its
//               journal line reads own_unjudged:true, not own_failing 0.
//   [MUST-FAIL] the own block carries the unjudged state and the run's bounded tail (ownNoResultEvidence + its wiring).
//   [MUST-FAIL] a no-edit round with an unjudged own check continues to the next round within the same round cap.
//   [CONTROL]   a judged red run lists its failing tests as today; a judged green run is unchanged; a no-edit round on any
//               other failure still stops; the rounds stay bounded by the cap.
//
// Pure: no LLM, no network, no fs writes.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

await isolateRuntimeRoot("fc-repair-unjudged-own-check", { who: "feature-compose-repair-unjudged-own-check.test.ts" });
const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;

const CHECK = "test/resolvers/execution-traces-list-perf.test.ts";
const EDIT_SITE = "repos/development-vessel/src/routes/execution-traces.ts";
// The gate's real detail for this state, as runVerify appends it.
const DETAIL = "THE GAP'S OWN CHECK PRODUCED NO RESULT on this draft (its test file run alone printed no pass/fail); unverified, not landed.";
const passLines = Array.from({ length: 400 }, (_, i) => `(pass) unrelated suite > passing case number ${i} [0.12ms]`).join("\n");
const pipeline = `== install ==\nok\n== typecheck ==\nTC_EXIT=0\n== tests ==\n${passLines}\n | ${DETAIL}`;
// What the silent own-check run printed: bun's header and the file name, then nothing (the draft's loop never returned).
const SILENT_RUN = `bun test v1.4.2\n\n${CHECK}:\nloading 6000 synthetic execution traces into the list fixture\n`;

/** The verify result as the parent builds it for that run: own { failing: [] }, no result state. */
const parentVerify = () => ({
  vessel: "repos/development-vessel", errors: "verify", exit_code: 0, ok: false, output: pipeline, stage: "own_check",
  own: { test_file: CHECK, failing: [] },
  draft: { own_red: [], introduced: [], new_ts: [], gate_detail: DETAIL },
});

function journal(fn: () => void): string[] {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => { logs.push(String(m)); };
  try { fn(); } finally { console.log = orig; }
  return logs.filter((l) => l.startsWith("[fc-repair] prompt ")).map((l) => l.slice("[fc-repair] prompt ".length));
}

describe("an unjudged own check reaches the repair round as no result, with its tail", () => {
  it("[MUST-FAIL] the replayed repair-2 input: the prompt names the unjudged check, quotes its tail, and journals own_unjudged:true", () => {
    expect(pipeline.length).toBeGreaterThan(4000);
    // The verify result as the fix builds it: the same own block plus its no-result state.
    const fv = { ...parentVerify(), own: { test_file: CHECK, failing: [], unjudged: true, output_tail: SILENT_RUN, exit_code: 143 } };
    let p = "";
    const lines = journal(() => { p = fc["repairPromptLogged"](fv, "", EDIT_SITE, "perf-gap"); });
    expect(p).toContain("FAILING STAGE: own_check");
    expect(p).toContain("the gap's own check produced NO RESULT (killed or crashed before any test finished)");
    expect(p).toContain("fix the cause");
    expect(p).toContain("loading 6000 synthetic execution traces into the list fixture");
    expect(p).toContain("exit code 143, timed out or killed");
    expect(p).not.toContain("OWN CHECK STILL RED");
    // the evidence leads the raw slice
    expect(p.indexOf("NO RESULT (killed")).toBeLessThan(p.indexOf("== install =="));
    expect(lines.length).toBe(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({ gap: "perf-gap", stage: "own_check", form: "evidence", own_unjudged: true });
    expect(rec.own_failing).not.toBe(0);
  });

  it("[MUST-FAIL] a silent run with an empty tail still says so, rather than a blank", () => {
    const fv = { ...parentVerify(), output: "== tests ==\nshort", own: { test_file: CHECK, failing: [], unjudged: true, output_tail: "" } };
    const p: string = fc["buildRepairPrompt"](fv, "", EDIT_SITE);
    expect(p).toContain("FAILING STAGE: own_check");
    expect(p).toContain("produced NO RESULT (killed or crashed before any test finished)");
    expect(p).toContain("The run printed nothing before it ended.");
  });

  it("[MUST-FAIL] the own block's no-result state: unjudged, the last 4 KB of the run, and the shell's non-zero exit only", () => {
    const ev = fc["ownNoResultEvidence"];
    expect(typeof ev).toBe("function");
    const long = "x".repeat(10_000) + "\nLAST LINE OF THE RUN";
    const e = ev(long, 143);
    expect(e.unjudged).toBe(true);
    expect(e.output_tail.length).toBe(fc["OWN_UNJUDGED_TAIL"]);
    expect(fc["OWN_UNJUDGED_TAIL"]).toBe(4096);
    expect(e.output_tail.endsWith("LAST LINE OF THE RUN")).toBe(true);
    expect(e.exit_code).toBe(143);
    // `|| true` reports 0 for every run the shell budget did not end: unknown, not carried
    expect("exit_code" in ev(SILENT_RUN, 0)).toBe(false);
    expect("exit_code" in ev(SILENT_RUN, undefined)).toBe(false);
    expect(ev(SILENT_RUN, 0).output_tail).toBe(SILENT_RUN);
  });

  it("[MUST-FAIL] wiring: a no-result run sets the state, and the own block spreads it after the failing list", () => {
    const src = readFileSync(new URL("../../src/resolvers/feature-compose.ts", import.meta.url), "utf8");
    expect(src.includes("if (red === null) ownNoResult = ownNoResultEvidence(draftRaw, (shO.body as { exit_code?: unknown })?.exit_code);")).toBe(true);
    expect(src.includes("own: { test_file: ownRef.test_file, failing: ownFailing, ...(ownNoResult ?? {}),")).toBe(true);
    // only the run's state: the store_unreadable path never sets it
    expect(src.match(/ownNoResult = /g)?.length).toBe(1);
  });

  it("[CONTROL] a judged red run lists its failing tests as today and journals its count", () => {
    const fv = { ...parentVerify(), own: { test_file: CHECK, failing: [{ name: "lists 6000 traces under 200 ms", expected: "< 200", received: "1840" }] }, draft: { own_red: ["(fail) lists 6000 traces under 200 ms"], introduced: [], new_ts: [], gate_detail: "THE GAP'S OWN CHECK IS STILL RED on this draft" } };
    let p = "";
    const lines = journal(() => { p = fc["repairPromptLogged"](fv, "", EDIT_SITE, "perf-gap"); });
    expect(p).toContain(`OWN CHECK STILL RED (${CHECK})`);
    expect(p).toContain("lists 6000 traces under 200 ms (expected < 200, received 1840)");
    expect(p).not.toContain("NO RESULT (killed");
    const rec = JSON.parse(lines[0]!);
    expect(rec.own_failing).toBe(1);
    expect("own_unjudged" in rec).toBe(false);
  });

  it("[CONTROL] a typecheck failure with no own block keeps today's prompt, byte for byte", () => {
    const output = "src/x.ts(3,5): error TS2304: Cannot find name 'widgt'.\nTC_EXIT=2";
    const fv = { vessel: "repos/activity-api", errors: "verify", exit_code: 2, ok: false, output, stage: "typecheck", draft: { own_red: [], introduced: [], new_ts: [], gate_detail: "src/x.ts(3,5): error TS2304: Cannot find name 'widgt'." } };
    const p: string = fc["buildRepairPrompt"](fv, "", null);
    expect(p.startsWith("A change to vessel repos/activity-api fails `bun run lint`")).toBe(true);
    expect(p).not.toContain("FAILING STAGE");
  });
});

describe("a repair round that writes nothing, with the own check unjudged, does not end the loop", () => {
  const MAX_REPAIR = 4;
  const unjudged = () => ({ ...parentVerify(), own: { test_file: CHECK, failing: [], unjudged: true as const, output_tail: SILENT_RUN } });
  const judgedRed = () => ({ ...parentVerify(), own: { test_file: CHECK, failing: [{ name: "lists 6000 traces under 200 ms" }] } });
  const green = () => ({ vessel: "repos/development-vessel", errors: 0, exit_code: 0, ok: true, output: "", stage: null, own: { test_file: CHECK, failing: [] } });
  /** The loop's shape: rounds while attempt < cap; a no-edit round breaks unless the predicate says it continues. */
  const rounds = (verify: unknown[], cap: number): number => {
    let n = 0;
    for (let attempt = 0; attempt < cap; attempt++) {
      n++;
      if (!fc["unjudgedNoEditRoundContinues"](verify, attempt, cap)) break;
    }
    return n;
  };

  it("[MUST-FAIL] the replayed state: a no-edit round continues to the next round, within the cap", () => {
    const go = fc["unjudgedNoEditRoundContinues"];
    expect(typeof go).toBe("function");
    expect(go([unjudged()], 0, MAX_REPAIR)).toBe(true);
    expect(go([green(), unjudged()], 2, MAX_REPAIR)).toBe(true);
    // the last round does not ask for another
    expect(go([unjudged()], MAX_REPAIR - 1, MAX_REPAIR)).toBe(false);
    // bounded: every round no-edit, the loop runs exactly the cap and never more
    expect(rounds([unjudged()], MAX_REPAIR)).toBe(MAX_REPAIR);
    expect(rounds([unjudged()], MAX_REPAIR + 2)).toBe(MAX_REPAIR + 2);
  });

  it("[MUST-FAIL] wiring: the no-edit branch asks the predicate with the round cap, keeps today's stop line, and falls through to re-verify", () => {
    const src = readFileSync(new URL("../../src/resolvers/feature-compose.ts", import.meta.url), "utf8");
    const at = src.indexOf("    if (!anyFixed) {\n");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, src.indexOf("    verify = [];\n    for (const v of touched) verify.push(await runVerify(v));", at));
    expect(block).toContain("if (!unjudgedNoEditRoundContinues(verify, attempt, repairCap)) {");
    expect(block).toContain("wrote nothing (no parsable fix, unreadable path, or old_string not found) — repair stops`); break; }");
    expect(block.length).toBeLessThan(1200);
    expect(src.includes("const MAX_REPAIR = 4;")).toBe(true);
  });

  it("[CONTROL] any other no-edit round still stops: a judged red, a green, an empty list", () => {
    const go = fc["unjudgedNoEditRoundContinues"];
    expect(go([judgedRed()], 0, MAX_REPAIR)).toBe(false);
    expect(go([green()], 0, MAX_REPAIR)).toBe(false);
    expect(go([], 0, MAX_REPAIR)).toBe(false);
    // an unjudged own block on a vessel that passed does not keep the loop alive
    expect(go([{ ...unjudged(), ok: true }], 0, MAX_REPAIR)).toBe(false);
    expect(rounds([judgedRed()], MAX_REPAIR)).toBe(1);
  });
});
