// THE ORACLE-LABEL READER (repair_autonomy link 5). Verdicts recorded about a trace are an operator act when an
// operator wrote them, so the evaluator must read the labels on a closure's provenance traces before it can call the
// closure the system's own. No reader was wired (labels: null), so every closure read REVIEW (unjudged) on labels.
// The labels are served: activity-api's goal_verification_label shape, read here through discovery at use time, one
// equality read per trace id (readOracleLabels). Its class context (fixLiveAt, forwarding and node-self keys, the key
// class map) is not served, so a label that exists still reads REVIEW; only a closure whose traces carry no label is
// judged on labels.
// Through the real resolver, every row input injected except the label reader, whose transport is replaced:
//   MUST-FAIL  a closure whose provenance traces carry no label is JUDGED (counted), no longer REVIEW on labels;
//   MUST-FAIL  the read asks the label shape for each provenance trace by execution_id, once per trace;
//   CONTROL    a label on a provenance trace still reads REVIEW (unjudged), never clean, with no class context served;
//   CONTROL    no producer or a failed read: unjudged; a page at the read's cap or one trace's labels from two orgs: unread.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useUngatedRowsSource } from "../helpers/ungated-rows-source.js";
import { isolateLearnedStateInProcess } from "../resolvers/isolated-gap-store-run.js";
useUngatedRowsSource();

const ROOT = join(tmpdir(), `sf-labels-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sfr = await import("../../src/resolvers/self-fact-reconcile.js") as Record<string, unknown>;
const resolveSelfFactReconcile = sfr["resolveSelfFactReconcile"] as (p: unknown) => Promise<unknown>;
const setDeps = sfr["__setJudgementDepsForTests"] as (d: Record<string, unknown> | null) => void;
const setIo = (sfr["__setOracleLabelIoForTests"] ?? (() => {})) as (io: unknown) => void;

const SUPER = join(ROOT, "super");
const saved: Record<string, string | undefined> = {};
const git = (...a: string[]) => { const p = Bun.spawnSync(["git", "-C", SUPER, ...a], { stdout: "pipe", stderr: "pipe" }); if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr)); };
const NOW = Date.parse("2026-10-22T12:00:00Z");
const h = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();
const sha = (c: string) => c.repeat(40);
const SITE = "repos/v/src/thing.ts";
const CHECK = "test/thing.check.ts";
const SOURCES: Record<string, string> = { [CHECK]: `import { thing } from "../src/thing.js";\nexpect(thing()).toBe("fixed_value");\n`, "src/thing.ts": `export function thing() { return "fixed_value"; }\n` };
const GAP = "g-labels";
const TRACE = "exec-provenance-1";
const AUTHORING = "exec-authoring-1";
const row = { id: GAP, status: "closed", source: "substrate_detected", first_detected_at: h(100), closed_at: h(48), reopen_count: 0,
  classification_metadata: { edit_site: SITE, check_supply: { state: "armed", test_file: CHECK }, predicate_birth_verdict: "present", closed_reason: "landed_verified", close_basis: "absent", landed_sha: sha("a"), execution_id: TRACE } };
const ev = (over: Record<string, unknown>) => ({ gap_id: GAP, outcome: "written", principal_kind: "in-process", key_id: null, operator_marker: false, store: "local", ...over });
const deps = {
  ledger: (kind: string) => kind === "attemptIntent" ? [{ key: "att-l", at: h(50), record: { attempt_id: "att-l", route: "gap_to_feature", gap_id: GAP, directed: false, authoring_execution_id: AUTHORING } }]
    : kind === "landingEvent" ? [{ key: "spool:att-l", at: h(50), record: { event: "commit", repo: "/workspace/git/vessels/v", sha: sha("a"), at: h(50), attempt_id: "att-l" } }] : [],
  ledgerPresent: () => true, spool: () => [], readGaps: async () => [row],
  readEvents: async () => ({ events: [ev({ fields_changed: ["status"], status_from: "absent", ts: h(100) }), ev({ fields_changed: ["classification_metadata.check_supply"], ts: h(90) })], matched: 2 }),
  keymap: async () => null,
  locate: (s: string) => ({ repo: "v", dir: "/clones/v", fullSha: s }), cloneOf: (v: string) => (v === "v" ? "/clones/v" : null), revParse: (_d: string, s: string) => s,
  fixCommit: () => ({ author: "Substrate Autonomous", at: h(50), files: ["src/thing.ts"], on_origin_dev: true }),
  siteCommits: () => [], firstCommit: () => ({ sha: sha("e"), author: "Substrate Autonomous", at: h(95), lane: true, files: [CHECK] }),
  revertsOf: () => [], commit: () => null, show: (_d: string, _s: string, p: string) => SOURCES[p] ?? null,
  scopeActs: async (sites: string[]) => new Map(sites.map((x) => [x, []])), persist: () => ({ appended: true }), now: () => NOW, log: () => {},
};
/** The label store as the shape answers it: {success, content: JSON rows}. */
let LABELS: Record<string, Array<Record<string, unknown>>> = {};
let URLS: string[] | null = ["http://producer.invalid/v2/impulses/resolve"];
let FAIL = false;
const ASKED: Array<Record<string, unknown>> = [];
const io = {
  urls: async () => URLS,
  post: async (_u: string, body: unknown) => {
    const p = (body as { impulse: { pointer: Record<string, unknown> } }).impulse.pointer;
    ASKED.push(p);
    if (FAIL) return null;
    return { success: true, content: JSON.stringify(LABELS[String(p["execution_id"])] ?? []), metadata: { shape: "goal_verification_label" } };
  },
};

beforeAll(() => {
  for (const k of ["SUPER_REPO_ROOT", "PROFILE", "PROFILE_EFFECTIVE", "GAP_STORE_ENDPOINT"]) saved[k] = process.env[k];
  delete process.env["PROFILE"]; delete process.env["PROFILE_EFFECTIVE"]; delete process.env["GAP_STORE_ENDPOINT"];
  process.env["SUPER_REPO_ROOT"] = SUPER;
  mkdirSync(join(SUPER, "scripts", "substrate"), { recursive: true });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeFileSync(join(SUPER, "scripts", "substrate", "self-facts.json"), JSON.stringify({ rows: [{ id: "repair_autonomy", instrument: "repair_autonomy", profiles: ["*"], edit_site: "repos/development-vessel/src/resolvers/self-fact-reconcile.ts", must_fail: "fixture:operator-armed-verified-landing", window_hours: 168 }] }));
  git("add", "."); git("commit", "-q", "-m", "rows"); git("update-ref", "refs/remotes/origin/dev", "HEAD");
  // Every input but the label reader (deps.labels is NOT given: the default reader runs, over the replaced transport).
  setDeps(deps);
  setIo(io);
});
beforeEach(() => { LABELS = {}; URLS = ["http://producer.invalid/v2/impulses/resolve"]; FAIL = false; ASKED.length = 0; });
afterAll(() => {
  setDeps(null); setIo(null);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});
type J = { gap_id: string; verdict: string; reason: string };
const judge = async (): Promise<J> => {
  const r = (await resolveSelfFactReconcile({ type: "self_fact_reconcile", file_gaps: false, plant_canary: false } as never)) as { body: { judgements: Record<string, J[]> } };
  return r.body.judgements["repair_autonomy"]!.find((j) => j.gap_id === GAP)!;
};
const label = (over: Record<string, unknown> = {}) => ({ execution_id: TRACE, org_id: "organizations:o1", labeler: "human", source: "human", verdict: "achieved", created_at: h(60), principal_kind: "session", principal_key_id: null, ...over });

describe("repair_autonomy: the oracle labels on a closure's provenance traces are read through their served shape", () => {
  it("MUST-FAIL: a closure whose provenance traces carry no label is judged (counted), not REVIEW on labels", async () => {
    const j = await judge();
    expect({ verdict: j.verdict, review: j.reason.includes("oracle labels unread") }, j.reason).toEqual({ verdict: "counted", review: false });
  });
  it("MUST-FAIL: the read asks goal_verification_label for each provenance trace by execution_id, once per trace", async () => {
    await judge();
    expect(ASKED.map((p) => [p["type"], p["execution_id"]]).sort()).toEqual([["goal_verification_label", AUTHORING], ["goal_verification_label", TRACE]]);
  });
  it("CONTROL: a label on a provenance trace still reads REVIEW (unjudged) while no class context is served", async () => {
    LABELS = { [TRACE]: [label()] };
    const j = await judge();
    expect({ verdict: j.verdict, review: j.reason.includes("REVIEW") }, j.reason).toEqual({ verdict: "unjudged", review: true });
  });
  it("CONTROL: no producer, or a failed read, reads unjudged", async () => {
    const cases: Array<[string, () => void]> = [["no producer", () => { URLS = null; }], ["failed read", () => { FAIL = true; }]];
    const out: Record<string, string> = {};
    for (const [name, arrange] of cases) { LABELS = {}; URLS = ["http://producer.invalid/v2/impulses/resolve"]; FAIL = false; arrange(); out[name] = (await judge()).verdict; }
    expect(out).toEqual({ "no producer": "unjudged", "failed read": "unjudged" });
  });
  it("CONTROL: the reader returns unread (null) for a page at the read's cap and for one trace's labels from two orgs; one org under the cap is read", async () => {
    const read = sfr["readOracleLabels"] as (ids: string[], io: unknown) => Promise<{ labels: unknown[] } | null>;
    const at = async (rows: Array<Record<string, unknown>>) => { LABELS = { [TRACE]: rows }; return read([TRACE], io); };
    const ok = await at([label(), label({ labeler: "automated" })]);
    expect({
      capped: await at(Array.from({ length: 100 }, () => label())),
      two_orgs: await at([label({ org_id: "organizations:o1" }), label({ org_id: "organizations:o2" })]),
      one_org: ok === null ? null : ok.labels.length,
    }).toEqual({ capped: null, two_orgs: null, one_org: 2 });
  });
});
