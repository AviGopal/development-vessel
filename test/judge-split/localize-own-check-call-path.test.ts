// THE LOCALIZER READS THE CALL PATH ADMISSION GROUNDED ON. A row whose edit_site names no file (a directory with
// function names) is admitted when its own check's code-reachable baseline names an existing in-scope file on its call
// path (gap-admission ownCheckCallPathFiles). gap_to_feature then localized it from its text alone: the grep found no
// confident file, and the pick was marked localization_failed, filed a "needs a change-site" question and fired an
// escalation, every time. localizeGap now takes the same reader's first file before any search, and a search pick the
// autonomy scope excludes is no confident file. The reader names no file for a call path that runs through an excluded
// file (first or later): the red tests run through lane core, so no in-scope file on it is a landable target.
// Driven through an auto-pick tick of resolveGapToFeature (judge-split harness: in-memory store, routed fetch with
// unrouted calls recorded, stand-in compose and question writer), plus localizeGap directly for the controls.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginPin, endPin, restoreHarness, seed, writesFor, calls, git, route, SCRATCH, RUN, type Row } from "./harness.js";
import { autoPick, PICK_LOG } from "./pick-fixture.js";

const g2f = await import("../../src/landing/gap-localize.js");
const VESSEL = "activity-api";
const CLONE = join(SCRATCH, "clones", VESSEL);
const TF = "src/lib/caller-fault-abstains.test.ts";
const TITLES = ["MUST-FAIL — the caller fault is classified and attributed to the calling step > failureClassOf names malformed_request"];
const FC = `repos/${VESSEL}/src/lib/failure-class.ts`;
const PU = `repos/${VESSEL}/src/lib/posterior-update.ts`;
// The vessel's clone with an origin/dev: a baseline decides only at that sha.
mkdirSync(join(CLONE, "src", "lib"), { recursive: true });
writeFileSync(join(CLONE, "src", "lib", "failure-class.ts"), "export function failureClassOf(): string { return 'x'; }\n");
writeFileSync(join(CLONE, "src", "lib", "posterior-update.ts"), "export function computeDeltas(): number { return 0; }\n");
writeFileSync(join(CLONE, TF), "import { test } from 'bun:test';\ntest('x', () => {});\n");
git(CLONE, "init", "-q");
git(CLONE, "add", "-A");
git(CLONE, "commit", "-q", "-m", "fixture");
git(CLONE, "update-ref", "refs/remotes/origin/dev", "HEAD");
const HEAD = git(CLONE, "rev-parse", "origin/dev");

const reading = (verdict: string, call_path: Row[] = [{ path: PU, fn: "computeDeltas", line: 1 }, { path: FC, fn: "failureClassOf", line: 1 }], base_sha = HEAD) => ({
  gap_id: "x", vessel: VESSEL, test_file: TF, only_tests: TITLES, base_sha, verdict, red: [], failing: [], expect_count: 1,
  call_path, call_path_source: "static", env_signals: [], env_policy: "policy", dispatch_id: "d", measured_at: "2026-01-01T00:00:00Z",
});
const DIR_SITE = `repos/${VESSEL}/src (computeDeltas, failureClassOf, propagateCreditAlongChain)`;
const meta = (extra: Row): Row => ({
  edit_site: DIR_SITE, falsifier: "class2", investigated_at: "2026-10-01T00:00:00.000Z",
  evidence_resolve: { shape: "test_suite", input: { vessel: VESSEL, test_file: TF, only_tests: TITLES }, zero_field: "requested_not_passing" }, ...extra,
});
const row = (stem: string, extra: Row): Row => ({ id: `${stem}-${RUN}`, category: "systematic_failure", summary: "credit writers grade caller-fault outcomes", classification_metadata: meta(extra) });
/** The autonomy scope a test runs under (the pool's autonomyScope record): `excluded` paths, else the harness's open scope. */
const scopeExcluding = (excluded: string[]) => route({
  name: "pool autonomyScope", match: (_u, b) => b?.impulse?.type === "poolImpulse" && b.impulse.shape === "autonomyScope",
  respond: () => Response.json({ body: { impulses: [{ shape: "autonomyScope", updated_at: "2026-01-01T00:00:00Z", body: { excluded_paths: excluded, reason: "pin fixture scope" } }] } }),
});
const policy = (await import("../../src/judge/gap-policy.js")) as Record<string, unknown>;
const setScopeDeps = policy.__setAutonomyScopeDepsForTests as (d: unknown) => void;

beforeEach(() => { beginPin(); setScopeDeps(null); });
// The escalation fetch is unrouted, so a pass that fires it is caught here as a fetch violation.
afterEach(() => { setScopeDeps(null); });
afterAll(() => restoreHarness());

describe("a gap admitted on its own check's call path is localized to that file", () => {
  // The live row's scope: posterior-update.ts, first on its call path, is excluded; failure-class.ts is not. The red
  // tests run through the excluded file, so neither admission nor the localizer takes failure-class.ts from the path.
  it("MUST-FAIL the credit-writers row shape is not picked: admission refuses it by scope, no compose, no escalation", async () => {
    scopeExcluding([PU]);
    const g = seed(row("lcp-cw", { own_check_baseline: reading("red_code_reachable") }));
    const { picked } = await autoPick();
    const guards = endPin([PICK_LOG]);
    expect(picked).not.toBe(g.id);
    expect(calls.compose.length).toBe(0);
    expect(writesFor(g.id).some((w) => w.meta?.localization_failed === true)).toBe(false);
    expect(guards.fetch).toEqual([]);
  });

  it("MUST-FAIL localizeGap takes no call-path target from a path through an excluded file (first or later), with no fetch", async () => {
    scopeExcluding([PU]);
    for (const [stem, cp] of [["lcp-direct", undefined], ["lcp-later", [{ path: FC, fn: "failureClassOf", line: 1 }, { path: PU, fn: "computeDeltas", line: 1 }]]] as const) {
      const r = await g2f.localizeGap(row(stem, { own_check_baseline: reading("red_code_reachable", cp as Row[] | undefined) }), { useLlm: false });
      expect(r?.method).not.toBe("own_check_call_path");
      expect(r?.file ?? null).not.toBe(FC);
    }
    expect(endPin([PICK_LOG]).fetch).toEqual([]);
  });

  it("CONTROL a call path whose existing files are all in scope: its first file is the target, before any search", async () => {
    scopeExcluding([`repos/${VESSEL}/src/unrelated.ts`]);
    const r = await g2f.localizeGap(row("lcp-inscope", { own_check_baseline: reading("red_code_reachable", [{ path: FC, fn: "failureClassOf", line: 1 }]) }), { useLlm: true });
    expect(r?.file).toBe(FC);
    expect(r?.method).toBe("own_check_call_path");
    expect(endPin([PICK_LOG]).fetch).toEqual([]);
  });

  it("MUST-FAIL with nothing excluded the call path's own order decides: its first existing file is the target", async () => {
    const r = await g2f.localizeGap(row("lcp-open", { own_check_baseline: reading("red_code_reachable") }), { useLlm: false });
    expect(r?.file).toBe(PU);
    expect(r?.method).toBe("own_check_call_path");
    endPin([PICK_LOG]);
  });
});

describe("a search pick is held to the autonomy scope", () => {
  // One runtime file holds the quoted symbol, so the grep finds a sole match.
  const SOLE = `repos/${VESSEL}/src/sole-${RUN}.ts`;
  mkdirSync(join(SCRATCH, "runtime", VESSEL, "src"), { recursive: true });
  writeFileSync(join(SCRATCH, "runtime", VESSEL, "src", `sole-${RUN}.ts`), `export const soleMarkerSymbol${RUN} = 1;\n`);
  const searchRow = (stem: string): Row => ({ ...row(stem, {}), summary: `the value "soleMarkerSymbol${RUN}" is wrong` });

  it("CONTROL in scope, the sole grep match is the target, as before", async () => {
    const r = await g2f.localizeGap(searchRow("lcp-sole-in"), { useLlm: false });
    expect(r?.file).toBe(SOLE);
    expect(r?.method).toBe("grep_unique");
    endPin([PICK_LOG]);
  });

  it("MUST-FAIL an unreadable scope refuses the sole match too (fail closed), and the compose floor withholds on the same read", async () => {
    setScopeDeps({ live: async () => ({ excluded: [], readable: false, reason: "pin fixture: unreadable" }), boundS: () => 0, now: Date.now });
    const r = await g2f.localizeGap(searchRow("lcp-sole-unread"), { useLlm: false });
    expect(r).toBeNull();
    // The downstream gate on the same condition: autonomyScopeFloor (feature-compose's floor) excludes every applied path.
    const floor = (policy.autonomyScopeFloor as (s: unknown, p: string[]) => { hits: string[]; unreadable: string | null })({ excluded: [], readable: false, reason: "down" }, [FC]);
    expect(floor.hits.length).toBeGreaterThan(0);
    expect(floor.unreadable).toContain("unreadable");
    endPin([PICK_LOG]);
  });

  it("MUST-FAIL an excluded sole match is no confident file (null, not the excluded file)", async () => {
    scopeExcluding([SOLE]);
    const r = await g2f.localizeGap(searchRow("lcp-sole-ex"), { useLlm: false });
    expect(r).toBeNull();
    endPin([PICK_LOG]);
  });
});

describe("CONTROLS: anything else falls through to today's localization", () => {
  /** localizeGap on the row as given and with its reading removed: the reading must change nothing. */
  async function sameAsWithoutReading(stem: string, ocb: Row) {
    const withIt = await g2f.localizeGap(row(stem, { own_check_baseline: ocb }), { useLlm: false });
    const without = await g2f.localizeGap(row(`${stem}-none`, {}), { useLlm: false });
    expect(withIt?.method).not.toBe("own_check_call_path");
    expect(withIt?.file ?? null).toBe(without?.file ?? null);
  }

  it("CONTROL a bare existing edit_site is unchanged: it is named, not the call path", async () => {
    const r = await g2f.localizeGap(row("lcp-bare", { edit_site: PU, own_check_baseline: reading("red_code_reachable") }), { useLlm: false });
    expect(r?.file).toBe(PU);
    expect(r?.method).toBe("metadata_edit_site");
    endPin([PICK_LOG]);
  });

  it("CONTROL green_at_parent, unrunnable, a missing call-path file and a stale reading are ignored", async () => {
    await sameAsWithoutReading("lcp-green", reading("green_at_parent"));
    await sameAsWithoutReading("lcp-unrun", reading("unrunnable"));
    await sameAsWithoutReading("lcp-missing", reading("red_code_reachable", [{ path: `repos/${VESSEL}/src/lib/missing.ts`, fn: "f", line: 1 }]));
    await sameAsWithoutReading("lcp-stale", reading("red_code_reachable", undefined, "d".repeat(40)));
    endPin([PICK_LOG]);
  });

  it("CONTROL a call path whose existing files are all excluded is ignored", async () => {
    scopeExcluding([PU, FC]);
    await sameAsWithoutReading("lcp-allexcl", reading("red_code_reachable"));
    endPin([PICK_LOG]);
  });
});
