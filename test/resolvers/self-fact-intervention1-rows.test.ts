// Standing rows for intervention 1 (typed discovery lookup, ias 4719cb4 + dev 8b48805f), evaluated from stubbed
// instruments, and their must-fail controls: each control is shown to FAIL the row when the thing it guards is
// mutated. The rows below are the exact records proposed for scripts/substrate/self-facts.json.
//
// Row A instrument lookup_classification: journal count (journalctl stubbed) + planted failed lookups (the real ias
// HttpDiscoveryAdapter against a refused port and a local server that never answers, unless stubbed).
// Row B instrument typed_seam_sites: git grep over fixture clones and a fixture super-repo with origin/dev refs.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setPlantedLookupForTests,
  __setUnitActiveForTests,
  classifyPlantedLookup,
  countSiteLines,
  refAgeHours,
  evaluateSelfFactRow,
  journal,
  resolveSelfFactReconcile,
  scratchSiteCount,
  selfFactRowLines,
  thisNode,
  type SelfFactRow,
  type SelfFactResult,
  type SelfFactDivergence,
} from "../../src/resolvers/self-fact-reconcile.js";

const ROW_A: SelfFactRow = {
  id: "policy_reads_classify_failed_lookups",
  instrument: "lookup_classification",
  profiles: ["standalone", "hub", "compute"],
  edit_site: "repos/development-vessel/src/config.ts",
  must_fail: "planted failed lookups must read 'lookup failed'",
  window_hours: 1,
  unit: "development-vessel",
  pattern: "(scope|envelope) unreadable.*no (poolImpulse|llmSpendSummaryNode) producer",
  max: 0,
  must_fail_line: "[gap-to-feature] selection skipped: spend envelope envelope unreadable: no poolImpulse producer discovered",
  probe_shapes: ["poolImpulse", "llmSpendSummaryNode"],
  probe_modes: ["timeout", "network"],
  linked_gap: "discovery-lookup-copies-must-migrate-onto-the-typed-ias-seam",
};
const EXC = [":(exclude,glob)**/*.test.ts", ":(exclude,glob)**/*.test.tsx", ":(exclude,glob)**/*.spec.ts", ":(exclude,glob)**/test/**", ":(exclude,glob)**/__tests__/**"];
const ROW_B: SelfFactRow = {
  id: "discovery_lookups_on_typed_seam",
  instrument: "typed_seam_sites",
  profiles: ["standalone", "hub"],
  edit_site: "repos/development-vessel/src/config.ts",
  must_fail: "a scratch repo with one planted site must count exactly 1",
  site_pattern: "type:[[:space:]]*['\"]vesselCapability['\"]",
  pathspecs: [":(glob)src/**/*.ts", ":(glob)src/**/*.tsx", ":(glob)ui/src/**/*.ts", ":(glob)ui/src/**/*.tsx", ...EXC],
  super_repo_pathspecs: [":(glob)packages/*/src/**/*.ts", ":(glob)scripts/**/*.ts", ...EXC],
  exclude_repos: ["discovery-vessel"],
  seam_files: ["ias-executor-ts:src/adapters/discovery-adapter.ts"],
  max: 3,
  linked_gap: "discovery-lookup-copies-must-migrate-onto-the-typed-ias-seam",
};

const real = (r: SelfFactResult | null): SelfFactDivergence[] => (r?.divergences ?? []).filter((d) => !d.canary);
const canaries = (r: SelfFactResult | null): SelfFactDivergence[] => (r?.divergences ?? []).filter((d) => d.canary);

const realJournalRead = journal.read;
afterEach(() => {
  journal.read = realJournalRead;
  __setPlantedLookupForTests(null);
  __setUnitActiveForTests(null);
});

describe("row A: policy reads classify a failed lookup as failed, never as no producer", () => {
  const journalLines = (lines: string[]) => { journal.read = async () => ({ lines }); };
  it("reads clean with 0 matching lines and REAL planted failures (refused port, never-answering discovery), and reports its canary", async () => {
    __setUnitActiveForTests(() => "active");
    journalLines([]);
    const r = await evaluateSelfFactRow(ROW_A);
    expect(r?.source_read).toBe(true);
    expect(real(r)).toEqual([]);
    expect(canaries(r).length).toBe(1);
    expect(r?.note).toContain("4 planted failed lookup(s), 0 misread");
  });
  it("COUNTER must-fail: misread lines in the journal fail the row, keyed by this node", async () => {
    __setUnitActiveForTests(() => "active");
    journalLines([ROW_A.must_fail_line!, "[rhythm-conductor] no family selected: spend envelope envelope unreadable: no llmSpendSummaryNode producer discovered", "unrelated line"]);
    const r = await evaluateSelfFactRow(ROW_A);
    const d = real(r);
    expect(d.length).toBe(1);
    expect(d[0]!.key).toBe(thisNode());
    expect(d[0]!.node).toBe(thisNode());
    expect(d[0]!.detail).toContain("2 line(s)");
  });
  it("BEHAVIOUR must-fail: a seam that turns a failed lookup into an empty answer (the pre-4719cb4 defect) fails the row", async () => {
    __setUnitActiveForTests(() => "active");
    journalLines([]);
    __setPlantedLookupForTests(async (shape) => ({ ok: true, shape, producers: [], cached: false }));
    const r = await evaluateSelfFactRow(ROW_A);
    const d = real(r);
    expect(r?.source_read).toBe(true);
    expect(d.length).toBe(1);
    expect(d[0]!.key).toBe(`${thisNode()}-planted-lookup-misread`);
    expect(d[0]!.detail).toContain("empty answer");
    expect(new RegExp(ROW_A.pattern!).test(d[0]!.detail)).toBe(false);
  });
  it("BEHAVIOUR must-fail: a failure whose wording collapses into absence fails the row", async () => {
    __setUnitActiveForTests(() => "active");
    journalLines([]);
    __setPlantedLookupForTests(async (shape) => ({ ok: false, shape, reason: "timeout", detail: `no ${shape} producer discovered`, cached: false }));
    const d = real(await evaluateSelfFactRow(ROW_A));
    expect(d.map((x) => x.key)).toEqual([`${thisNode()}-planted-lookup-misread`]);
    expect(d[0]!.detail).toContain("matches the defect pattern");
    // The finding must not be counted by its own row when it is logged.
    expect(new RegExp(ROW_A.pattern!).test(d[0]!.detail)).toBe(false);
  });
  it("the pattern as first worded ('scope unreadable|…') reads a CORRECT post-fix failure as the defect, so the row narrows it", async () => {
    __setUnitActiveForTests(() => "active");
    journalLines([]);
    const d = real(await evaluateSelfFactRow({ ...ROW_A, pattern: "scope unreadable|envelope unreadable.*no (poolImpulse|llmSpendSummaryNode) producer" }));
    expect(d.length).toBe(1);
    expect(d[0]!.detail).toContain("matches the defect pattern (scope reader)");
  });
  it("a plant answered WITH producers is unobserved, not clean", async () => {
    __setUnitActiveForTests(() => "active");
    journalLines([]);
    __setPlantedLookupForTests(async (shape) => ({ ok: true, shape, producers: [{ vesselId: "x", endpoint: "http://x", resolveEndpoint: "http://x/r" } as never], cached: false }));
    const r = await evaluateSelfFactRow(ROW_A);
    expect(r?.source_read).toBe(false);
    expect(r?.divergences).toEqual([]);
  });
  it("the counter's own positive control: a pattern that cannot match its must_fail_line reports no canary", async () => {
    __setUnitActiveForTests(() => "active");
    journalLines([]);
    const r = await evaluateSelfFactRow({ ...ROW_A, must_fail_line: "nothing like the defect" });
    expect(canaries(r)).toEqual([]);
  });
  it("refuses a pattern that matches what the row itself logs, and an inactive unit is unobserved", async () => {
    __setUnitActiveForTests(() => "active");
    journalLines([]);
    expect((await evaluateSelfFactRow({ ...ROW_A, pattern: "planted.lookup" }))?.source_read).toBe(false);
    __setUnitActiveForTests(() => "inactive");
    expect((await evaluateSelfFactRow(ROW_A))?.source_read).toBe(false);
  });
  it("classifyPlantedLookup: the real post-fix wording passes, an empty answer and absence wording fail", () => {
    const re = new RegExp(ROW_A.pattern!);
    expect(classifyPlantedLookup({ ok: false }, "poolImpulse lookup failed (timeout): no answer from discovery within 300 ms", re)).toEqual({ planted: true, misread: null });
    expect(classifyPlantedLookup({ ok: true, producers: [] }, "no poolImpulse producer", re).misread).not.toBeNull();
    expect(classifyPlantedLookup({ ok: false }, "no poolImpulse producer", re).misread).not.toBeNull();
  });
});

// ─── row B fixtures: clones with origin/dev refs, and a super-repo ───────────
let root = "";
const SITE = `await fetch(u, { body: JSON.stringify({ pointer: { type: "vesselCapability", shape } }) });\n`;
const SITE_SQ = `const x = { type: 'vesselCapability', shape };\n`;
function git(dir: string, ...args: string[]): void { gitAt(dir, undefined, ...args); }
function gitAt(dir: string, date: string | undefined, ...args: string[]): void {
  const env = date ? { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : process.env;
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}
function repo(dir: string, files: Record<string, string>, ref = true): void {
  mkdirSync(dir, { recursive: true });
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), c); }
  git(dir, "init", "-q"); git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "fixture");
  if (ref) git(dir, "update-ref", "refs/remotes/origin/dev", "HEAD");
}
function commitTo(dir: string, path: string, content: string): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
  git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "more"); git(dir, "update-ref", "refs/remotes/origin/dev", "HEAD");
}
const envBefore = { ...process.env };
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "i1rows-"));
  const clones = join(root, "vessels");
  repo(join(clones, "alpha-vessel"), { "src/a.ts": SITE, "src/a.test.ts": SITE, "src/a.js": SITE, "src/ok.ts": "// mentions vesselCapability in a comment only\n" });
  repo(join(clones, "beta-vessel"), { "ui/src/b.tsx": SITE_SQ, "test/b.ts": SITE });
  repo(join(clones, "discovery-vessel"), { "src/d.ts": SITE + SITE }); // discovery itself: excluded
  repo(join(clones, "ias-executor-ts"), { "src/adapters/discovery-adapter.ts": SITE }); // the seam: excluded
  repo(join(clones, "alpha-vessel-mitosis-1"), { "src/m.ts": SITE }); // a mitosis scratch clone: not the fleet
  const rows = { rows: [ROW_B] };
  repo(join(root, "super"), { "packages/client/src/c.ts": SITE, "scripts/substrate/self-facts.json": JSON.stringify(rows) });
  process.env["MITOSIS_PUSH_CLONE_DIR"] = clones;
  process.env["SUPER_REPO_ROOT"] = join(root, "super");
  process.env["PROFILE_EFFECTIVE"] = "standalone";
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const k of ["MITOSIS_PUSH_CLONE_DIR", "SUPER_REPO_ROOT", "PROFILE_EFFECTIVE"]) { if (envBefore[k] === undefined) delete process.env[k]; else process.env[k] = envBefore[k]; }
});

describe("row B: discovery lookups converge on the typed ias seam", () => {
  it("counts sites at origin/dev across clones and the super-repo, leaving out tests, .js twins, comments, discovery and the seam", async () => {
    const r = await evaluateSelfFactRow(ROW_B);
    expect(r?.source_read).toBe(true);
    expect(r?.note).toMatch(/^3 site\(s\), ceiling 3/);
    expect(real(r).map((d) => d.key)).toEqual(["sites-remaining"]);
    expect(real(r)[0] as { file?: boolean }).toMatchObject({ file: false });
    expect(canaries(r).length).toBe(1);
  });
  it("MUST-FAIL control: the scratch repo counts exactly 1 with the row's own pattern and pathspecs", () => {
    expect(scratchSiteCount(ROW_B.site_pattern!, ROW_B.pathspecs!)).toBe(1);
  });
  it("MUST-FAIL control fails the row when the instrument is mutated (exclusions dropped, or a blind pattern)", async () => {
    expect(scratchSiteCount(ROW_B.site_pattern!, ["src"])).toBe(3);
    expect(canaries(await evaluateSelfFactRow({ ...ROW_B, pathspecs: ["src"] }))).toEqual([]);
    expect(canaries(await evaluateSelfFactRow({ ...ROW_B, site_pattern: "type: vesselCapabilityX" }))).toEqual([]);
  });
  it("a planted extra site raises the count above the ceiling and fails the row", async () => {
    commitTo(join(root, "vessels", "beta-vessel"), "src/new-copy.ts", SITE);
    const r = await evaluateSelfFactRow(ROW_B);
    const over = real(r).find((d) => d.key === "over-ceiling");
    expect(over?.detail).toContain("4 discovery lookup site(s)");
    expect(over?.detail).toContain("beta-vessel:src/new-copy.ts:1");
    expect((over as { file?: boolean }).file).not.toBe(false);
  });
  it("a repo whose origin/dev git cannot read makes the row unobserved, never a lower count", async () => {
    repo(join(root, "vessels", "gamma-vessel"), { "src/g.ts": "export {};\n" }, false);
    const r = await evaluateSelfFactRow(ROW_B);
    expect(r?.source_read).toBe(false);
    expect(r?.note).toContain("gamma-vessel");
    rmSync(join(root, "vessels", "gamma-vessel"), { recursive: true, force: true });
  });
  it("FRESHNESS: a clone whose origin/dev was last fetched or moved beyond max_ref_age_hours makes the row unobserved, not a lower count", async () => {
    const dir = join(root, "vessels", "stale-vessel");
    repo(dir, { "src/s.ts": SITE }, false);
    // The ref last moved 30 h ago and the clone has no FETCH_HEAD: the fleet may have landed sites it cannot see.
    const old = new Date(Date.now() - 30 * 3_600_000);
    gitAt(dir, `@${Math.floor(old.getTime() / 1000)} +0000`, "update-ref", "refs/remotes/origin/dev", "HEAD");
    expect(refAgeHours(dir)!).toBeGreaterThan(29);
    const r = await evaluateSelfFactRow(ROW_B);
    expect(r?.source_read).toBe(false);
    expect(r?.note).toContain("stale-vessel");
    expect(r?.divergences).toEqual([]);
    // A row may allow an older ref: then it counts.
    expect((await evaluateSelfFactRow({ ...ROW_B, max_ref_age_hours: 48 }))?.source_read).toBe(true);
    // A fetch that moved nothing still rewrites FETCH_HEAD: fresh again, and its site counts.
    writeFileSync(join(dir, ".git", "FETCH_HEAD"), "");
    const now = new Date();
    utimesSync(join(dir, ".git", "FETCH_HEAD"), now, now);
    expect(refAgeHours(dir)!).toBeLessThan(1);
    const fresh = await evaluateSelfFactRow(ROW_B);
    expect(fresh?.source_read).toBe(true);
    expect(fresh?.note).toContain("stale-vessel@");
    rmSync(dir, { recursive: true, force: true });
  });
  it("the done-condition predicate: keyed sites-remaining reads divergence_count, and a foreign node reads null", async () => {
    const mine = await resolveSelfFactReconcile({ type: "self_fact_reconcile", facts: [ROW_B.id], key: "sites-remaining", plant_canary: false, file_gaps: false });
    expect((mine.body as { divergence_count: number | null }).divergence_count).toBe(1);
    expect((mine.body as { gaps_emitted: number }).gaps_emitted).toBe(0);
    const other = await resolveSelfFactReconcile({ type: "self_fact_reconcile", facts: [ROW_B.id], key: "sites-remaining", plant_canary: false, file_gaps: false, node: "some-other-node" });
    expect((other.body as { divergence_count: number | null }).divergence_count).toBeNull();
  });
  it("countSiteLines drops seam files and parses ref-prefixed git grep lines", () => {
    expect(countSiteLines(["origin/dev:src/x.ts:4:type: 'vesselCapability'", "origin/dev:src/adapters/discovery-adapter.ts:9:x", ""], "origin/dev", ["src/adapters/discovery-adapter.ts"])).toEqual({ count: 1, sites: ["src/x.ts:4"] });
  });
});

describe("one journal line per row per tick (so 'no divergences here' differs from 'never ran here')", () => {
  it("a tick over an observed row, an unobserved row and a profile-skipped row emits exactly one line each", async () => {
    const OBS: SelfFactRow = { ...ROW_B, id: "seam_sites_none_expected", site_pattern: "NEVER_MATCHES_vesselCapability_x", max: 0 };
    const UNOBS: SelfFactRow = { ...ROW_A, id: "lookup_rows_unit_down" };
    const SKIP: SelfFactRow = { ...ROW_B, id: "hub_only_row", profiles: ["hub"] };
    const sr = join(root, "super-log");
    repo(sr, { "scripts/substrate/self-facts.json": JSON.stringify({ rows: [OBS, UNOBS, SKIP] }) });
    const prev = process.env["SUPER_REPO_ROOT"];
    process.env["SUPER_REPO_ROOT"] = sr;
    __setUnitActiveForTests(() => "inactive");
    const logged: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
    try {
      const res = await resolveSelfFactReconcile({ type: "self_fact_reconcile", plant_canary: false, file_gaps: false });
      expect((res.body as { rows_checked: string[] }).rows_checked).toEqual([OBS.id, UNOBS.id]);
    } finally {
      spy.mockRestore();
      process.env["SUPER_REPO_ROOT"] = prev;
    }
    const lines = logged.filter((l) => l.startsWith("[self-fact]"));
    expect(lines.length).toBe(3);
    expect(lines.filter((l) => l.startsWith(`[self-fact] row ${OBS.id}: observed (`)).length).toBe(1);
    expect(lines.filter((l) => l.startsWith(`[self-fact] row ${UNOBS.id}: unobserved (`)).length).toBe(1);
    expect(lines).toContain(`[self-fact] row ${SKIP.id}: skipped (profile standalone)`);
    // A journal-reading row never counts these lines.
    for (const l of lines) expect(new RegExp(ROW_A.pattern!).test(l)).toBe(false);
  });
  it("every row gets its line, including the gap_birth_verdicts and retry_evidence instruments", async () => {
    const RETRY: SelfFactRow = { id: "retry_evidence_cover", instrument: "retry_evidence", profiles: ["standalone"], edit_site: "x", must_fail: "x", window_hours: 1, journal_unit: "development-vessel" };
    const BIRTH: SelfFactRow = { id: "gap_birth_verdicts_cover", instrument: "gap_birth_verdicts", profiles: ["standalone"], edit_site: "x", must_fail: "x", window_hours: 1 };
    const BIRTH_SKIP: SelfFactRow = { ...BIRTH, id: "gap_birth_verdicts_hub_only", profiles: ["hub"] };
    const sr = join(root, "super-cover");
    repo(sr, { "scripts/substrate/self-facts.json": JSON.stringify({ rows: [RETRY, BIRTH, BIRTH_SKIP] }) });
    const prev = process.env["SUPER_REPO_ROOT"];
    process.env["SUPER_REPO_ROOT"] = sr;
    journal.read = async () => ({ lines: [] });
    const logged: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
    try {
      await resolveSelfFactReconcile({ type: "self_fact_reconcile", plant_canary: false, file_gaps: false });
    } finally {
      spy.mockRestore();
      process.env["SUPER_REPO_ROOT"] = prev;
    }
    const lines = logged.filter((l) => l.startsWith("[self-fact]"));
    expect(lines.length).toBe(3);
    for (const id of [RETRY.id, BIRTH.id]) expect(lines.filter((l) => new RegExp(`^\\[self-fact\\] row ${id}: (observed|unobserved|diverged) \\(`).test(l)).length).toBe(1);
    expect(lines).toContain(`[self-fact] row ${BIRTH_SKIP.id}: skipped (profile standalone)`);
  });
  it("a row holding a fileable finding reads diverged; a report-only finding does not", () => {
    const base = { fact: "r", source_read: true, copies_read: 1, note: "n" };
    const div = (file?: boolean) => ({ fact: "r", key: "k", source: "", copy: "", detail: "", canary: false, ...(file === false ? { file } : {}) });
    expect(selfFactRowLines([{ ...base, divergences: [div()] }], [], [], [], "hub")).toEqual(["[self-fact] row r: diverged (1 finding(s): k)"]);
    expect(selfFactRowLines([{ ...base, divergences: [div(false)] }], [], [], [], "hub")).toEqual(["[self-fact] row r: observed (n)"]);
    expect(selfFactRowLines([{ ...base, divergences: [] }], ["r"], [], [], "hub")).toEqual(["[self-fact] row r: unobserved (must-fail control not reported)"]);
    // A note that quotes a journal row's pattern is masked, so that row never counts the line.
    const quoting = selfFactRowLines([{ ...base, source_read: false, note: "invalid pattern: envelope unreadable: no poolImpulse producer", divergences: [] }], [], [], [], "hub", [ROW_A.pattern!]);
    expect(quoting[0]).toContain("[row pattern]");
    expect(new RegExp(ROW_A.pattern!).test(quoting[0]!)).toBe(false);
  });
});

// THE INSTRUMENT MUST NOT COUNT ITSELF (2026-10-01): Row B once read 66 > 65 because the canary's planted
// lookup was a source literal in this resolver. The canary string is built at runtime; this pins it, so a later
// "simplify the template literal" refactor cannot silently restore the self-count.
describe("typed_seam_sites never counts its own instrument file", () => {
  it("the row's site pattern finds 0 sites in self-fact-reconcile.ts's own source", () => {
    const SITE_PATTERN = "type:[[:space:]]*['\"]vesselCapability['\"]"; // = the discovery_lookups_on_typed_seam row's site_pattern
    const p = Bun.spawnSync(["git", "grep", "--no-index", "-n", "-E", SITE_PATTERN, "--", "src/resolvers/self-fact-reconcile.ts"], { stdout: "pipe", stderr: "pipe" });
    expect([0, 1]).toContain(p.exitCode); // 1 = no match (the expected case); anything else is a broken read
    const lines = new TextDecoder().decode(p.stdout).split("\n");
    expect(countSiteLines(lines, "", []).count).toBe(0);
  });
});
