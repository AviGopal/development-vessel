// THE DRAFTER SEES THE WHOLE EDIT SITE, AND A LOCK MADE BLIND DOES NOT OUTLIVE THE BLINDNESS (C-window-1).
//
// Measured on the lane's failed composes: an explicit line hint in a gap ("~l.N-M") centres the edit-site window (one
// 6000-char slice) on a few hundred lines of a file several windows long, while the fix also needs the file's imports and
// sites windows away. Drafts edit inside the window, have no effect on the gap's own check, and LOCK the region they edited
// (no_effect_vs_parent), so the only window the drafter can see fills with refusals.
//
// Expected (class-level; the tables vary file size, site placement, record provenance and policy):
//   - the gap's edit-site file is grounded WHOLE when it fits the shaped budget (composeGroundingPolicy), and the composer
//     records what it showed; any other target, or an edit site over the budget, keeps the single window;
//   - a lock recorded while its file was grounded PARTIALLY (or by an attempt whose own check never executed) is void while
//     the drafter sees the file whole; the prompt says so instead of listing it as refused;
//   - GUARD (docs, G6): a genuine no-effect lock recorded under WHOLE grounding with the check executing is STILL refused;
//     an unreadable policy voids nothing; a draft cannot claim a grounding (the record is the composer's);
//   - UNKNOWN IS LOUD (G3): a lock record naming a grounding mode this code does not know is kept and reported; a policy key
//     this code does not read is reported;
//   - a validated drafter-module context is widened to show the whole edit site (the module's window is replaced);
//   - each attempt is attributed: grounding_mode, locks_voided, tc_lesson_consumed, per_assertion_delta.
//
// Seams: targetGrounding / widenDrafterContext / composeAttemptEvidence (feature-compose) and the C-window-1 section of
// retry-evidence, reached as optional exports so their absence reads as a red assertion. No network, no live tree.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;
const re = (await import("../../src/resolvers/retry-evidence.js")) as Record<string, any>;

const P = "repos/demo-vessel/src/resolvers/big-module.ts";
const WINDOW = 6000;
const BUDGET = 49_152;
const EDIT_SITE = { path: P, max_whole_chars: BUDGET };
const has = (name: string, from: Record<string, any>): boolean => typeof from[name] === "function";
const span = (start: number, end: number, base = "b0", text_sha = `t${start}`) => ({ path: P, start, end, text_sha, base });
const FAILING = [
  { name: "module check (i): the first assertion", error: "error: expect(received).toBeNull()", received: "Received: \"x\"" },
  { name: "module check (ii): the second assertion", error: "error: expect(received).not.toBe(expected)" },
];

/** A file of `chars` characters (± one line) with a marker line at each fraction of its length. */
function fileOf(chars: number, fractions: readonly number[]): { content: string; lines: number; markers: string[] } {
  const n = Math.max(3, Math.round(chars / 59));
  const lines: string[] = [];
  for (let i = 1; i <= n; i++) lines.push(`// line ${String(i).padStart(5, "0")} ${"x".repeat(44)}`);
  const markers = fractions.map((f, k) => {
    const at = Math.min(n - 1, Math.max(0, Math.floor(f * (n - 1))));
    lines[at] = `export const SITE_${k}_MARK = ${at + 1}; // ${"s".repeat(30)}`;
    return `SITE_${k}_MARK`;
  });
  return { content: lines.join("\n"), lines: n, markers };
}
const SPREAD = [0.02, 0.5, 0.98];

describe("whole-file grounding of the edit site (G1: sizes below, at and above the budget; sites spread)", () => {
  const sizes: Array<[string, number]> = [
    ["smaller than one window", 3_000],
    ["just over one window", 7_000],
    ["several windows", 29_000],
    ["just under the budget", BUDGET - 200],
    ["just over the budget", BUDGET + 200],
    ["far over the budget", 140_000],
  ];
  for (const [label, chars] of sizes) {
    it(`${label} (${chars} chars): whole iff within the budget; whole shows every site, else one window`, () => {
      expect(has("targetGrounding", fc)).toBe(true);
      const f = fileOf(chars, SPREAD);
      const hint = { start: Math.floor(f.lines * 0.6), end: Math.floor(f.lines * 0.6) + 20 };
      const g = fc.targetGrounding(P, f.content, WINDOW, [], "", hint, EDIT_SITE);
      if (f.content.length <= BUDGET) {
        expect(g.entry).toEqual({ path: P, mode: "whole", start_line: 1, end_line: f.lines, file_chars: f.content.length });
        for (const m of f.markers) expect(g.sliced.slice).toContain(m);
      } else {
        expect(g.entry.mode).toBe("slice");
        expect(g.sliced.slice.length).toBeLessThanOrEqual(WINDOW);
        expect(f.markers.every((m) => g.sliced.slice.includes(m))).toBe(false);
      }
    });
  }

  it("exactly at the budget is whole; one char over is a window", () => {
    expect(has("targetGrounding", fc)).toBe(true);
    const f = fileOf(20_000, SPREAD);
    const at = fc.targetGrounding(P, f.content, WINDOW, [], "", null, { path: P, max_whole_chars: f.content.length });
    expect(at.entry.mode).toBe("whole");
    const over = fc.targetGrounding(P, f.content, WINDOW, [], "", null, { path: P, max_whole_chars: f.content.length - 1 });
    expect(over.entry.mode).toBe("slice");
  });

  it("RED at parent: a single window centred on a hint hides sites spread across a file several windows long", () => {
    const f = fileOf(29_000, SPREAD);
    const s = fc.focusedSlice(f.content, WINDOW, [], "", { start: Math.floor(f.lines * 0.6), end: Math.floor(f.lines * 0.6) + 20 }).slice as string;
    expect(s.length).toBeLessThanOrEqual(WINDOW);
    expect(f.markers.every((m) => s.includes(m))).toBe(false);
  });

  it("the whole edit site is rendered with absolute line numbers (the apply step's boundary check reads them)", () => {
    expect(has("targetGrounding", fc)).toBe(true);
    const f = fileOf(29_000, SPREAD);
    const g = fc.targetGrounding(P, f.content, WINDOW, [], "", null, EDIT_SITE);
    const block = fc.groundingFileBlock(P, f.content, g.sliced, true) as string;
    const lines = f.content.split("\n");
    for (const m of f.markers) {
      const i = lines.findIndex((l) => l.includes(m));
      expect(block).toContain(`${i + 1}\t${lines[i]}`);
    }
    expect(block).not.toContain("head omitted");
  });

  it("a target that is not the edit site, and no edit site at all (policy off), keep the single window", () => {
    expect(has("targetGrounding", fc)).toBe(true);
    const f = fileOf(29_000, SPREAD);
    const other = fc.targetGrounding("repos/demo-vessel/src/other.ts", f.content, WINDOW, [], "", null, EDIT_SITE);
    expect(other.entry.mode).toBe("slice");
    expect(other.sliced.slice.length).toBeLessThanOrEqual(WINDOW);
    const off = fc.targetGrounding(P, f.content, WINDOW, [], "", null, null);
    expect(off.entry.mode).toBe("slice");
  });
});

describe("the lock void rule (G1 table, G6 guard, G3 unknown)", () => {
  const RULES = { void_partial_grounding_locks: 1, void_unexecuted_check_locks: 1 };
  const executed = { own_check: { test_file: "test/x.test.ts", failing: FAILING } };
  const LARGE = 29_000;
  const SMALL = 4_000;
  type Case = [string, Record<string, unknown>, number | null, "partial_grounding" | "unexecuted_check" | null];
  const cases: Case[] = [
    // [label, record extras, file chars grounded whole now (null = not whole now), expected void reason]
    ["legacy record, large file, whole now", { ...executed }, LARGE, "partial_grounding"],
    ["legacy record, large file, not whole now", { ...executed }, null, null],
    ["legacy record, small file (fit the old slice), whole now", { ...executed }, SMALL, null],
    ["recorded slice, whole now", { ...executed, check_executed: true, grounding: [{ path: P, mode: "slice", start_line: 100, end_line: 200, file_chars: LARGE }] }, LARGE, "partial_grounding"],
    ["recorded slice of a small file, whole now", { ...executed, check_executed: true, grounding: [{ path: P, mode: "slice", start_line: 1, end_line: 40, file_chars: SMALL }] }, SMALL, "partial_grounding"],
    ["recorded whole, whole now (GENUINE)", { ...executed, check_executed: true, grounding: [{ path: P, mode: "whole", start_line: 1, end_line: 491, file_chars: LARGE }] }, LARGE, null],
    ["recorded whole, not whole now", { ...executed, check_executed: true, grounding: [{ path: P, mode: "whole", start_line: 1, end_line: 491, file_chars: LARGE }] }, null, null],
    ["recorded for another file only, whole now", { ...executed, check_executed: true, grounding: [{ path: "repos/demo-vessel/src/x.ts", mode: "whole", start_line: 1, end_line: 9, file_chars: 90 }] }, LARGE, "partial_grounding"],
    ["check never executed (recorded false)", { check_executed: false }, null, "unexecuted_check"],
    ["check never executed (legacy: module crashed)", { own_check: { test_file: "t", failing: [{ name: "Unhandled error between tests" }] } }, null, "unexecuted_check"],
    ["check never executed (legacy: no own check)", {}, LARGE, "unexecuted_check"],
  ];
  for (const [label, extra, wholeNow, expected] of cases) {
    it(`${label} → ${expected ?? "kept"}`, () => {
      expect(has("effectiveLockLessons", re)).toBe(true);
      const rec = { no_effect_vs_parent: true, edited_spans: [span(300, 302)], ...extra };
      const whole = new Map(wholeNow === null ? [] : [[P, wholeNow]]);
      const r = re.effectiveLockLessons([rec], whole, RULES);
      expect(r.voided.map((v: any) => v.reason)).toEqual(expected ? [expected] : []);
      expect(re.noEffectSpans(r.lessons).length).toBe(expected ? 0 : 1);
    });
  }

  // GREEN AT BASE AND AFTER (G6): voiding loosens a refusal gate, so the gate's own refusal of a genuine lock is pinned on
  // both sides of the change (at base through the raw lessons, after through the lessons this attempt enforces).
  it("GUARD (docs): a genuine no-effect lock recorded under WHOLE grounding with the check executing is STILL refused", () => {
    const f = fileOf(29_000, SPREAD);
    const genuine = { no_effect_vs_parent: true, edited_spans: [re.spanRecord(P, f.content, 250, 256)], grounding: [{ path: P, mode: "whole", start_line: 1, end_line: f.lines, file_chars: f.content.length }], check_executed: true, ...executed };
    const enforced = has("effectiveLockLessons", re) ? re.effectiveLockLessons([genuine], new Map([[P, f.content.length]]), RULES) : { lessons: [genuine], voided: [] };
    expect(enforced.voided).toEqual([]);
    expect(re.noEffectOverlapRefusal(P, f.content, { start: 254, end: 255 }, enforced.lessons)).toContain("NO-EFFECT REGION REFUSED");
    expect(re.noEffectOverlapRefusal(P, f.content, { start: 254, end: 255 }, [genuine])).toContain("NO-EFFECT REGION REFUSED");
  });

  it("G3: a lock record naming a grounding mode this code does not know is KEPT and reported, never decided silently", () => {
    expect(has("effectiveLockLessons", re)).toBe(true);
    const odd = { no_effect_vs_parent: true, edited_spans: [span(300, 302)], ...executed, check_executed: true, grounding: [{ path: P, mode: "multi", start_line: 1, end_line: 9, file_chars: LARGE }] };
    const r = re.effectiveLockLessons([odd], new Map([[P, LARGE]]), RULES);
    expect(r.voided).toEqual([]);
    expect(re.noEffectSpans(r.lessons).length).toBe(1);
    expect(r.unrecognised).toEqual([{ path: P, start: 300, end: 302, mode: "multi" }]);
  });

  it("an unreadable policy (rules null) voids nothing; each rule can be switched off by the policy", () => {
    expect(has("effectiveLockLessons", re)).toBe(true);
    const legacy = { no_effect_vs_parent: true, edited_spans: [span(385, 388)], ...executed };
    expect(re.effectiveLockLessons([legacy], new Map([[P, LARGE]]), null).voided).toEqual([]);
    expect(re.effectiveLockLessons([legacy], new Map([[P, LARGE]]), { void_partial_grounding_locks: 0, void_unexecuted_check_locks: 1 }).voided).toEqual([]);
    const unexecuted = { no_effect_vs_parent: true, edited_spans: [span(300, 301)], check_executed: false };
    expect(re.effectiveLockLessons([unexecuted], new Map(), { void_partial_grounding_locks: 1, void_unexecuted_check_locks: 0 }).voided).toEqual([]);
  });

  it("many legacy locks spread across a large file (several records, several spans each) are all void under whole grounding", () => {
    expect(has("effectiveLockLessons", re)).toBe(true);
    const recs = [[[385, 388], [329, 329], [24, 24]], [[313, 313], [96, 96]], [[482, 484]], [[140, 140]], [[477, 477], [17, 17]]]
      .map((ss) => ({ no_effect_vs_parent: true, edited_spans: ss.map(([a, b]) => span(a!, b!)), ...executed }));
    const r = re.effectiveLockLessons(recs, new Map([[P, LARGE]]), RULES);
    expect(r.voided.length).toBe(9);
    expect(re.noEffectSpans(r.lessons)).toEqual([]);
  });

  it("the prompt names the void locks as editable and no longer lists them as refused", () => {
    expect(has("effectiveLockLessons", re)).toBe(true);
    const legacy = { at: "2026-01-01T00:00:00Z", stage: "own_check", class: "verify_failed", no_effect_vs_parent: true, edited_spans: [span(377, 377), span(317, 317)], ...executed };
    const block = re.attemptEvidenceBlock(re.effectiveLockLessons([legacy], new Map([[P, LARGE]]), RULES).lessons) as string;
    expect(block).toContain("lock VOID now");
    expect(block).toContain(`${P}:377-377`);
    expect(block).not.toContain("REFUSED REGIONS");
  });
});

describe("the grounding record is the composer's, never the draft's", () => {
  const verifyFail = { vessel: "demo-vessel", errors: "verify", exit_code: 1, ok: false, output: "", stage: "own_check", own: { test_file: "test/x.test.ts", failing: FAILING, no_effect_vs_parent: true } };

  it("composeAttemptEvidence writes the composer's grounding and check_executed; a grounding carried on an applied op is ignored", () => {
    const composerSaw = [{ path: P, mode: "slice", start_line: 292, end_line: 391, file_chars: 29_000 }];
    const draftClaim = [{ path: P, mode: "whole", start_line: 1, end_line: 491, file_chars: 29_000 }];
    const applied = [{ ok: true, base_span: span(300, 301), grounding: draftClaim }];
    const { record } = fc.composeAttemptEvidence(applied, [], [verifyFail], false, null, { grounding: composerSaw });
    expect(record.grounding).toEqual(composerSaw);
    expect(record.check_executed).toBe(true);
    const bare = fc.composeAttemptEvidence(applied, [], [verifyFail], false, null).record;
    expect(bare.grounding).toBeUndefined();
    expect(bare.check_executed).toBeUndefined();
  });

  it("so the record written under a partial grounding is voided once the file is grounded whole, and one written under whole is kept", () => {
    expect(has("effectiveLockLessons", re)).toBe(true);
    const mk = (mode: string) => fc.composeAttemptEvidence([{ ok: true, base_span: span(300, 301) }], [], [verifyFail], false, null, { grounding: [{ path: P, mode, start_line: 1, end_line: 491, file_chars: 29_000 }] }).record;
    const RULES = { void_partial_grounding_locks: 1, void_unexecuted_check_locks: 1 };
    const W = new Map([[P, 29_000]]);
    expect(re.effectiveLockLessons([mk("slice")], W, RULES).voided.length).toBe(1);
    expect(re.effectiveLockLessons([mk("whole")], W, RULES).voided.length).toBe(0);
  });
});

describe("the drafter module's context shows the whole edit site", () => {
  it("widenDrafterContext replaces the module's numbered window with the whole file and appends the typecheck-lesson block once", () => {
    expect(has("widenDrafterContext", fc)).toBe(true);
    const f = fileOf(29_000, SPREAD);
    const w = fc.focusedSlice(f.content, WINDOW, [], "", { start: 300, end: 320 }).slice as string;
    const startLine = f.content.slice(0, f.content.indexOf(w)).split("\n").length;
    const numberedWindow = w.split("\n").map((l, i) => `${startLine + i}\t${l}`).join("\n");
    const ctx = { grounding: `head\n----- ${P} -----\n${numberedWindow}\n… (windowed around the change site; head/tail omitted)\ntail`, targetWindows: { [P]: w }, priorFeedback: "", principles: "", composeLessons: "", netNewTargets: [], opBudgetHint: 24, journal: [], version: "drafter-v1" };
    const tc = "\n\nTYPECHECK LESSONS FROM THE PREVIOUS ATTEMPTS (x)";
    const r = fc.widenDrafterContext(ctx, { [P]: f.content }, tc);
    expect(r.ctx.targetWindows[P]).toBe(f.content);
    for (const m of f.markers) expect(r.ctx.grounding).toContain(m);
    expect(r.ctx.grounding.split("TYPECHECK LESSONS FROM THE PREVIOUS ATTEMPTS").length).toBe(2);
    expect(fc.widenDrafterContext(r.ctx, { [P]: f.content }, tc).widened).toEqual([]);
    expect(r.missed).toEqual([]);
  });

  it("G6: a context whose window for a whole-grounded path cannot be replaced is reported missed (the compose then uses the floor)", () => {
    expect(has("widenDrafterContext", fc)).toBe(true);
    const f = fileOf(29_000, SPREAD);
    const w = fc.focusedSlice(f.content, WINDOW, [], "", { start: 300, end: 320 }).slice as string;
    const ctx = { grounding: `head\n----- ${P} -----\n(the module rendered something else)`, targetWindows: { [P]: w }, priorFeedback: "", principles: "", composeLessons: "", netNewTargets: [], opBudgetHint: 24, journal: [], version: "drafter-v1" };
    expect(fc.widenDrafterContext(ctx, { [P]: f.content }, "").missed).toEqual([P]);
    const src = readFileSync(join(import.meta.dir, "../../src/resolvers/feature-compose.ts"), "utf8");
    const at = src.indexOf("if (w.missed.length > 0) {");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 300)).toContain("draftedCtx = null;");
  });
});

describe("attribution (law 12)", () => {
  it("per_assertion_delta compares this run of the own check with the gap's last run of it", () => {
    expect(has("perAssertionDelta", re)).toBe(true);
    const prior = [{ own_check: { failing: [{ name: "i" }, { name: "ii" }, { name: "iii" }, { name: "iv" }] } }, { class: "no_effect_region" }];
    expect(re.perAssertionDelta(prior, [{ name: "ii" }, { name: "iii" }, { name: "v" }], true)).toEqual({ newly_green: ["i", "iv"], newly_red: ["v"], still_red: 2 });
    expect(re.perAssertionDelta(prior, null, false)).toBeNull();
    expect(re.perAssertionDelta([], [], true)).toBeNull();
  });

  it("the attribution journal line carries the four fields and matches its published grep", () => {
    expect(has("groundingAttributionLine", re)).toBe(true);
    const line = re.groundingAttributionLine("gap-x", { grounding_mode: "whole", locks_voided: 9, tc_lesson_consumed: true, per_assertion_delta: { newly_green: ["i"], newly_red: [], still_red: 3 } });
    expect(line).toMatch(new RegExp(re.GROUNDING_ATTRIBUTION_GREP));
    expect(line).toContain("grounding_mode=whole locks_voided=9 tc_lesson_consumed=true per_assertion_delta=green+1/red+0/still_red=3");
  });
});

describe("the policy is shaped (law 1, G5), and ABSENT MEANS OFF", () => {
  const ROOT = join(tmpdir(), `cwin-policy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const SUPER = join(ROOT, "super");
  mkdirSync(join(SUPER, "policies"), { recursive: true });
  afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ } });
  const f = join(SUPER, "policies", "composeGroundingPolicy.json");
  const OFF = { read_widening: 0, edit_site_whole_file_max_chars: BUDGET, void_partial_grounding_locks: 0, void_unexecuted_check_locks: 0, tc_symbol_window_lines: 30 };

  it("absent (or no clone): the defaults, every switch off (the floor and the goldens are unchanged)", async () => {
    expect(has("readComposeGroundingPolicy", re)).toBe(true);
    expect(await re.readComposeGroundingPolicy(SUPER)).toMatchObject({ ok: true, source: "default", policy: OFF });
    expect(await re.readComposeGroundingPolicy(null)).toMatchObject({ ok: true, source: "default", policy: OFF });
  });

  it("present: read at use time and merged over the defaults; a key this code does not read is reported (G3)", async () => {
    expect(has("readComposeGroundingPolicy", re)).toBe(true);
    writeFileSync(f, JSON.stringify({ read_widening: 1, void_partial_grounding_locks: 1, void_unexecuted_check_locks: 1, multi_window: 1 }));
    const r = await re.readComposeGroundingPolicy(SUPER);
    expect(r.ok && r.source).toBe("policy");
    expect(r.policy).toEqual({ ...OFF, read_widening: 1, void_partial_grounding_locks: 1, void_unexecuted_check_locks: 1 });
    expect(r.ignored_keys).toEqual(["multi_window"]);
    rmSync(f);
  });

  const bad: Array<[string, string]> = [
    ["not JSON", "{not json"],
    ["an array", "[]"],
    ["an integer out of range", JSON.stringify({ edit_site_whole_file_max_chars: 5 })],
    ["a switch that is not 0/1", JSON.stringify({ read_widening: 2 })],
    ["a boolean where an integer is required", JSON.stringify({ read_widening: true })],
    ["a fraction", JSON.stringify({ tc_symbol_window_lines: 7.5 })],
  ];
  for (const [label, text] of bad) {
    it(`present but ${label}: ok false (the composer then widens and voids nothing)`, async () => {
      expect(has("readComposeGroundingPolicy", re)).toBe(true);
      writeFileSync(f, text);
      expect((await re.readComposeGroundingPolicy(SUPER)).ok).toBe(false);
      rmSync(f);
    });
  }
});
