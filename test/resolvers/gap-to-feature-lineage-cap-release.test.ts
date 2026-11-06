// LINEAGE-CAP RELEASE: A CAPPED RECOMMIT LINEAGE WITH NEWER INFORMATION THAN ITS LAST FAILURE, AS A MASKED VARIANT.
//
// Past RECOMMIT_LINEAGE_ATTEMPT_CAP a recommit lineage was held from the auto-pick and nothing released it. The
// activity development-vessel:lineage-cap-release decides it: variant-0 (the control) caps exactly as before and
// logs "would release"; variant-1 admits the row past the cap, here and in the holder election. "Newer information"
// is read from the open lineage's rows only: a falsifier classification stamped after the last failure with the class
// now class1/class2 (the classifier keeps the old stamp on an identical re-classification), or a check_supply arm
// still armed and stamped after it. A lineage with no last_failed_at, an inherited arm, a re-written same class and a
// refused arm release nothing. The decision line is said once per (row, event) per process; the decision's trace is
// posted only when the released row reaches its compose, which also writes it to a pending file. A compose that does
// not come back ok settles it at its exit (not reached); an ok one waits for the attempt ledger's landing verdict
// (#2 regressed -> not reached, else #1 held -> reached), read on a later pass, by a restarted process too.
//
// The auto-pick cases run in their own process (gap-to-feature-lineage-cap-release-pick.cases.ts); their [CONTROL] uses
// only what the parent has, so it runs at the parent too: with no mask in force the pass excludes the same rows.
import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess, runCasesIsolated } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `lineage-cap-release-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const g2f = await import("../../src/resolvers/gap-to-feature.js") as Record<string, any>;

type Row = Record<string, unknown>;
const RUN = process.env["LCR_RUN"] ?? Math.random().toString(36).slice(2, 8);
const ACTIVITY = "development-vessel:lineage-cap-release";
const T_FAIL_ROOT = "2000-01-02T01:00:00.000Z";
const T_FAIL = "2000-01-03T01:00:00.000Z";
const T_AFTER = "2000-01-04T01:00:00.000Z";
const T_BEFORE = "2000-01-01T01:00:00.000Z";
const SITE = "repos/development-vessel/src/resolvers/gap-to-feature.ts";
const row = (id: string, source: string, meta: Row): Row => ({ id, category: "systematic_failure", source, status: "open", summary: `fixture ${id}`, detected_at: "1999-12-30T00:00:00.000Z", classification_metadata: meta });
/** A root (failed 4) and its recommit (failed 3): lineage attempts 7, over the cap of 6. */
const lineage = (tag: string, recommitMeta: Row, rootMeta: Row = {}): Row[] => {
  const root = `lcr-root-${tag}-${RUN}`;
  return [
    row(root, "substrate_detected", { edit_site: SITE, falsifier: "class2", falsifier_classified_at: T_BEFORE, failed_attempts: 4, last_failed_at: T_FAIL_ROOT, ...rootMeta }),
    row(`recommit-lcr-${tag}-${RUN}`, "substrate_detected", { edit_site: SITE, falsifier: "class2", falsifier_classified_at: T_BEFORE, source_gap_id: root, re_commit: true, failed_attempts: 3, last_failed_at: T_FAIL, ...recommitMeta }),
  ];
};
const byIdOf = (rows: Row[]) => new Map(rows.map((r) => [String(r.id), r]));
const recommitOf = (rows: Row[]) => rows.find((r) => String(r.id).startsWith("recommit-"))!;
const ARMED_AFTER = { check_supply: { state: "armed", armed_at: T_AFTER } };
const mask = (v: unknown) => [{ id: "mask-lcr", body: { activity_id: ACTIVITY, active_variant: v, from: "1999-01-01T00:00:00.000Z", until: "2099-01-01T00:00:00.000Z", by: "operator:test", reason: "test" } }];

function capture<T>(fn: () => T): { out: T; lines: string[] } {
  const lines: string[] = [];
  const orig = console.log, origWarn = console.warn;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { return { out: fn(), lines }; } finally { console.log = orig; console.warn = origWarn; }
}

describe("lineageCapReleaseEvidence — newer information read from the open lineage's rows", () => {
  it("[MUST-FAIL] a check armed after the last failure is evidence; the line fields name the root, its source and the last failing step", () => {
    const rows = lineage("armed", { ...ARMED_AFTER, failure_lessons: [{ class: "old", stage: "draft" }, { class: "verify_failed", stage: "typecheck" }] });
    const e = g2f.lineageCapReleaseEvidence(recommitOf(rows), byIdOf(rows));
    expect(e).toMatchObject({ event: "armed", event_at: T_AFTER, last_failed_at: T_FAIL, attempts: 7, root: `lcr-root-armed-${RUN}`, root_source: "substrate_detected", last_failed_step: "verify_failed:typecheck" });
  });
  it("[MUST-FAIL] a classification that CHANGED after the failure, to class1 or class2, is evidence", () => {
    const rows = lineage("reclass", { falsifier: "class1", falsifier_classified_at: T_AFTER });
    expect(g2f.lineageCapReleaseEvidence(recommitOf(rows), byIdOf(rows))).toMatchObject({ event: "falsifier_classified", event_at: T_AFTER });
  });
  it("[CONTROL] the same class re-written after the failure is NOT evidence: the classifier kept its stamp, which predates the failure", () => {
    const rows = lineage("samecls", { falsifier: "class2", falsifier_classified_at: T_BEFORE });
    expect(g2f.lineageCapReleaseEvidence(recommitOf(rows), byIdOf(rows))).toBeNull();
  });
  it("[CONTROL] a classification changed after the failure to a class with no check (none, unresolvable) is not evidence", () => {
    for (const cls of ["none", "unresolvable"]) {
      const rows = lineage(`to-${cls}`, { falsifier: cls, falsifier_classified_at: T_AFTER });
      expect(g2f.lineageCapReleaseEvidence(recommitOf(rows), byIdOf(rows))).toBeNull();
    }
  });
  it("[CONTROL] an arm inherited from the parent, stamped before the lineage's last failure, is not evidence", () => {
    const rows = lineage("inherited", { check_supply: { state: "armed", armed_at: T_BEFORE } }, { check_supply: { state: "armed", armed_at: T_BEFORE } });
    expect(g2f.lineageCapReleaseEvidence(recommitOf(rows), byIdOf(rows))).toBeNull();
  });
  it("[CONTROL] an arm stamped after the failure on a row no longer armed (refused) is not evidence", () => {
    const rows = lineage("refused", { check_supply: { state: "arm_refused", armed_at: T_AFTER } });
    expect(g2f.lineageCapReleaseEvidence(recommitOf(rows), byIdOf(rows))).toBeNull();
  });
  it("[CONTROL] a lineage with no last_failed_at stays capped (no evidence), whatever it carries", () => {
    const rows = lineage("nofail", { ...ARMED_AFTER, last_failed_at: undefined }, { last_failed_at: undefined });
    expect(g2f.lineageCapReleaseEvidence(recommitOf(rows), byIdOf(rows))).toBeNull();
  });
  it("[CONTROL] a predicate_birth_at after the failure is not read (the birth sweep re-stamps it every tick)", () => {
    const rows = lineage("birth", { predicate_birth_at: T_AFTER });
    expect(g2f.lineageCapReleaseEvidence(recommitOf(rows), byIdOf(rows))).toBeNull();
  });
  it("[MUST-FAIL] a root absent from the open read is named unresolved(closed ancestor <id>); no lesson reads unrecorded", () => {
    const rows = lineage("closedroot", ARMED_AFTER);
    const open = rows.filter((r) => String(r.id).startsWith("recommit-"));
    // with its root closed the open lineage sums only the recommit's 3 attempts; the evidence still names the walk's end
    const e = g2f.lineageCapReleaseEvidence(recommitOf(rows), byIdOf(open));
    expect(e).toMatchObject({ root: `recommit-lcr-closedroot-${RUN}`, root_source: `unresolved(closed ancestor lcr-root-closedroot-${RUN})`, last_failed_step: "unrecorded" });
  });
});

describe("lineageCapReleaseDecisions — the variant, the line once per (row, event), no trace at decision time", () => {
  const NOW = Date.parse("2000-01-05T00:00:00.000Z");
  it("[MUST-FAIL] with no mask in force: variant-0, released=false, one 'would release' line; a second pass says nothing", () => {
    let reads = 0, posts = 0;
    g2f.__setLineageCapReleaseDepsForTests({ readMasks: () => { reads++; return []; }, postTrace: async () => { posts++; return 200; } });
    const rows = lineage("v0", ARMED_AFTER);
    const first = capture(() => g2f.lineageCapReleaseDecisions([recommitOf(rows)], byIdOf(rows), NOW));
    const d = first.out.get(String(recommitOf(rows).id));
    expect(d).toMatchObject({ variant: 0, released: false });
    const decisionLines = first.lines.filter((l) => l.includes(`decision=${d.id}`));
    expect(decisionLines).toHaveLength(1);
    expect(decisionLines[0]).toContain(`row=${String(recommitOf(rows).id)} root=lcr-root-v0-${RUN} root_source=substrate_detected event=armed@${T_AFTER} last_failed_at=${T_FAIL} attempts=7 last_failed_step=unrecorded → would release (variant-0: capped as before)`);
    const second = capture(() => g2f.lineageCapReleaseDecisions([recommitOf(rows)], byIdOf(rows), NOW + 60_000));
    expect(second.out.get(String(recommitOf(rows).id))).toMatchObject({ id: d.id, released: false });
    expect(second.lines.filter((l) => l.includes("decision="))).toEqual([]);
    expect(reads).toBe(2);
    expect(posts).toBe(0);
  });
  it("[MUST-FAIL] a mask naming variant-1: released=true, the line says released; still no trace at decision time", () => {
    let posts = 0;
    g2f.__setLineageCapReleaseDepsForTests({ readMasks: () => mask(1), postTrace: async () => { posts++; return 200; } });
    const rows = lineage("v1", ARMED_AFTER);
    const r = capture(() => g2f.lineageCapReleaseDecisions([recommitOf(rows)], byIdOf(rows), NOW));
    expect(r.out.get(String(recommitOf(rows).id))).toMatchObject({ variant: 1, released: true });
    expect(r.lines.some((l) => l.includes("→ released"))).toBe(true);
    expect(posts).toBe(0);
  });
  it("[CONTROL] an unreadable pool, or a mask naming an unknown variant, is variant-0", () => {
    const rows = lineage("unread", ARMED_AFTER);
    g2f.__setLineageCapReleaseDepsForTests({ readMasks: () => { throw new Error("pool down"); } });
    const a = capture(() => g2f.lineageCapReleaseDecisions([recommitOf(rows)], byIdOf(rows), NOW));
    expect(a.out.get(String(recommitOf(rows).id))).toMatchObject({ variant: 0, released: false });
    expect(a.lines.some((l) => l.includes("mask_unread (pool down): variant-0"))).toBe(true);
    g2f.__setLineageCapReleaseDepsForTests({ readMasks: () => mask(7) });
    const b = capture(() => g2f.lineageCapReleaseDecisions([recommitOf(rows)], byIdOf(rows), NOW));
    expect(b.out.get(String(recommitOf(rows).id))).toMatchObject({ variant: 0, released: false });
  });
  it("[CONTROL] capped rows with no newer information: no decision, no mask read, no line", () => {
    let reads = 0;
    g2f.__setLineageCapReleaseDepsForTests({ readMasks: () => { reads++; return mask(1); } });
    const rows = lineage("quiet", {});
    const r = capture(() => g2f.lineageCapReleaseDecisions([recommitOf(rows)], byIdOf(rows), NOW));
    expect(r.out.size).toBe(0);
    expect(reads).toBe(0);
    expect(r.lines).toEqual([]);
  });
});

describe("the released row is graded by its landing verdict, never by an ok exit (consumption)", () => {
  const NOW = Date.parse("2000-01-05T00:00:00.000Z");
  const WINDOW = 60 * 60_000;
  type Reach = { v: { execution_id: string; reached: boolean }; ctx: { source: string; why: string; gap_id?: string } };
  const setup = (variant: number, tag: string, ledger: Record<string, Row> = {}) => {
    const reaches: Reach[] = [], posts: Row[] = [];
    const pendingFile = join(ROOT, `lcr-pending-${tag}-${RUN}.json`);
    const deps = {
      readMasks: () => mask(variant), postTrace: async (t: Row) => { posts.push(t); return 200; },
      pendingFile, settleWindowMs: () => WINDOW,
      settlement: (key: string) => (ledger[key] ? [{ record: ledger[key]! }] : []),
      reach: async (v: Reach["v"], ctx: Reach["ctx"]) => { reaches.push({ v, ctx }); return null; },
    };
    mkdirSync(ROOT, { recursive: true });
    g2f.__setLineageCapReleaseDepsForTests(deps);
    const rows = lineage(`grade-${tag}`, ARMED_AFTER);
    const d = capture(() => g2f.lineageCapReleaseDecisions([recommitOf(rows)], byIdOf(rows), NOW)).out.get(String(recommitOf(rows).id));
    const pending = (): Row[] => { try { return JSON.parse(readFileSync(pendingFile, "utf8")) as Row[]; } catch { return []; } };
    return { d, reaches, posts, pending, deps, ledger };
  };

  it("[MUST-FAIL] the trace at compose writes the release to the pending file, keyed by its attempt id", async () => {
    const { d, posts, pending } = setup(1, "write");
    g2f.traceLineageCapRelease(d, "att-write", NOW);
    await Bun.sleep(0);
    expect(posts.map((p) => p.execution_id)).toEqual([d.id]);
    expect(posts[0]).toMatchObject({ activity_id: `${ACTIVITY}-v1`, output_shapes: ["lineageCapRelease"] });
    expect(pending()).toEqual([expect.objectContaining({ decisionId: d.id, attemptId: "att-write", variant: 1, row: d.row, dispatchedAtMs: NOW })]);
  });
  it("[MUST-FAIL] an ok compose posts NO reach at its exit and stays pending, awaiting its landing verdict", async () => {
    const { d, reaches, pending } = setup(1, "okexit");
    g2f.traceLineageCapRelease(d, "att-okexit", NOW);
    const s = capture(() => g2f.settleLineageCapReleaseAtExit(d, { ok: true, nonAttempt: false, stage: "landed", verdict: "FAVORABLE", attempt: "att-okexit" }, NOW + 1));
    await Bun.sleep(0);
    expect(reaches).toEqual([]);
    expect(pending()).toHaveLength(1);
    expect(s.lines.some((l) => l.includes(`dispatched ${d.id} ok stage=landed`) && l.includes("awaiting its landing verdict"))).toBe(true);
  });
  it("[MUST-FAIL] a compose that did not come back ok settles not reached at its exit (source compose_exit) and leaves pending", async () => {
    const { d, reaches, pending } = setup(1, "failexit");
    g2f.traceLineageCapRelease(d, "att-failexit", NOW);
    g2f.settleLineageCapReleaseAtExit(d, { ok: false, nonAttempt: false, stage: "typecheck", failure_kind: "verify_failed", attempt: "att-failexit" }, NOW + 1);
    await Bun.sleep(0);
    expect(reaches).toEqual([{ v: { execution_id: d.id, reached: false }, ctx: expect.objectContaining({ source: "compose_exit", gap_id: d.row }) }]);
    expect(pending()).toEqual([]);
  });
  it("[CONTROL] a non-attempt posts nothing, leaves pending and is logged ungraded", async () => {
    const { d, reaches, pending } = setup(1, "nonatt");
    g2f.traceLineageCapRelease(d, "att-nonatt", NOW);
    const s = capture(() => g2f.settleLineageCapReleaseAtExit(d, { ok: false, nonAttempt: true, stage: "capacity" }, NOW + 1));
    await Bun.sleep(0);
    expect(reaches).toEqual([]);
    expect(pending()).toEqual([]);
    expect(s.lines.some((l) => l.includes(`ungraded ${d.id}: non-attempt`))).toBe(true);
  });
  it("[MUST-FAIL] on a restarted process (fresh deps, the file alone) the attempt's #1 held settles reached (source landing)", async () => {
    const { d, deps } = setup(1, "held", {});
    g2f.traceLineageCapRelease(d, "att-held", NOW);
    g2f.settleLineageCapReleaseAtExit(d, { ok: true, nonAttempt: false, stage: "landed", attempt: "att-held" }, NOW + 1);
    // the landing restarts the vessel: a new process reads only the pending file and the ledger
    const reaches: Reach[] = [];
    g2f.__setLineageCapReleaseDepsForTests({ ...deps, settlement: (key: string) => (key === "att-held#1" ? [{ record: { verdict: "held", credit_eligible: true } }] : []), reach: async (v: Reach["v"], ctx: Reach["ctx"]) => { reaches.push({ v, ctx }); return null; } });
    const s = capture(() => g2f.settleLineageCapReleasePending(NOW + 10 * 60_000));
    await Bun.sleep(0);
    expect(s.out).toBe(1);
    expect(reaches).toEqual([{ v: { execution_id: d.id, reached: true }, ctx: expect.objectContaining({ source: "landing" }) }]);
    expect(s.lines.some((l) => l.includes(`settled ${d.id} reached=true how=settlement_1`) && l.includes("verdict=held"))).toBe(true);
    expect(JSON.parse(readFileSync(deps.pendingFile, "utf8"))).toEqual([]);
  });
  it("[MUST-FAIL] a #1 verdict other than held settles not reached; a #2 (regressed) settles not reached even beside a #1 held", async () => {
    for (const [tag, ledger] of [["notheld", { "att-notheld#1": { verdict: "regressed" } }], ["second", { "att-second#1": { verdict: "held" }, "att-second#2": { verdict: "regressed" } }]] as const) {
      const { d, reaches } = setup(1, tag, ledger as Record<string, Row>);
      g2f.traceLineageCapRelease(d, `att-${tag}`, NOW);
      g2f.settleLineageCapReleasePending(NOW + 1);
      await Bun.sleep(0);
      expect(reaches).toEqual([{ v: { execution_id: d.id, reached: false }, ctx: expect.objectContaining({ source: "landing" }) }]);
    }
  });
  it("[CONTROL] no settlement yet: kept pending inside the window; past the window it is logged ungraded and dropped", async () => {
    const { d, reaches, pending } = setup(1, "window");
    g2f.traceLineageCapRelease(d, "att-window", NOW);
    expect(g2f.settleLineageCapReleasePending(NOW + WINDOW)).toBe(0);
    expect(pending()).toHaveLength(1);
    const s = capture(() => g2f.settleLineageCapReleasePending(NOW + WINDOW + 41 * 60_000));
    await Bun.sleep(0);
    expect(reaches).toEqual([]);
    expect(pending()).toEqual([]);
    expect(s.lines.some((l) => l.includes(`ungraded ${d.id}: no settlement for attempt att-window within 100 min`))).toBe(true);
  });
  it("[CONTROL] a compose with no attempt id is logged ungraded and never pended", () => {
    const { d, pending } = setup(1, "noatt");
    const s = capture(() => g2f.traceLineageCapRelease(d, undefined, NOW));
    expect(pending()).toEqual([]);
    expect(s.lines.some((l) => l.includes(`ungraded ${d.id}: its compose carries no attempt id`))).toBe(true);
  });
  it("[CONTROL] variant-0: nothing is consumed, so nothing is traced, pended or graded", async () => {
    const { d, reaches, posts, pending } = setup(0, "v0");
    g2f.traceLineageCapRelease(d, "att-v0", NOW);
    g2f.settleLineageCapReleaseAtExit(d, { ok: false, nonAttempt: false }, NOW);
    g2f.traceLineageCapRelease(undefined, "att-none", NOW);
    await Bun.sleep(0);
    expect(posts).toEqual([]);
    expect(reaches).toEqual([]);
    expect(pending()).toEqual([]);
  });
});

describe("source pin: the cap reads the decision, the trace precedes the compose, the exit grades only a not-ok compose", () => {
  const src = readFileSync(join(import.meta.dir, "../../src/resolvers/gap-to-feature.ts"), "utf8");
  it("[MUST-FAIL] isLineageCapped is the parent's predicate AND not released; the exclusion uses the same", () => {
    expect(src).toContain(`const overCap = (g: Record<string, unknown>): boolean => String(g.id ?? "").startsWith("recommit-") && lineageBackoffState(g, gapsById).attempts >= RECOMMIT_LINEAGE_ATTEMPT_CAP;`);
    expect(src).toContain("const isLineageCapped = (g: Record<string, unknown>): boolean => overCap(g) && !capReleased(g);");
    expect(src).toContain(`if (String(g.id ?? "").startsWith("recommit-") && state.attempts >= RECOMMIT_LINEAGE_ATTEMPT_CAP && !capReleased(g)) {`);
    expect(src).toContain(`const capReleased = (g: Record<string, unknown>): boolean => capReleases.get(String(g.id ?? ""))?.released === true;`);
    expect(src).toContain("    if (!pointer.gap_id) settleLineageCapReleasePending(nowMs);\n    const capReleases = pointer.gap_id ? new Map<string, LineageCapReleaseDecision>() : lineageCapReleaseDecisions(gaps.filter(overCap), gapsById, nowMs);");
  });
  it("[MUST-FAIL] the trace (and pending write) is right before the main compose; the exit reads cb.ok, never land.landed", () => {
    expect(src).toMatch(/traceLineageCapRelease\(capRelease, attempt\.id, Date\.now\(\)\);\n  const compose = await resolveFeatureCompose\(\{/);
    expect(src).toMatch(/await gradeComposeOutcome\(gap, cb, spec, pointer\.dry_run, attempt\.id, \{ ask: askHuman, escalate: escalateToDecomposition \}\);\n  settleLineageCapReleaseAtExit\(capRelease, \{ ok: cb\["ok"\] === true, nonAttempt,/);
    expect(src).not.toMatch(/settleLineageCapRelease[A-Za-z]*\([^)]*land\.landed/);
  });
});

// ── the pick itself, over a planted store: run in its own process (see the .cases.ts file's header) ──────────────
const pickRows = runCasesIsolated("./test/resolvers/gap-to-feature-lineage-cap-release-pick.cases.ts");
describe("the auto-pick over a planted store (isolated gap store)", () => {
  for (const r of pickRows) it(r.name, () => { if (!r.ok) console.error(r.detail); expect(r.ok).toBe(true); });
});
