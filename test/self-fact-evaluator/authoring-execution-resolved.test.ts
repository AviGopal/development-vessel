// qa's eval5 review, B3 (R3 labels): repair_autonomy took a landing's provenance trace from intent.authoring_execution_id
// only. The compose path usually registers null there and writes the real id later (setAuthoringExecution ->
// attemptAuthoring.jsonl), which the landing reader never read; a lane landing with a null intent id and no provenance
// field on its row then asked for no labels and read clean. The id is now resolved through attempt-register's own
// reader (authoringOverride), and a lane landing still without a known authoring execution is unjudged, unattributable.
// Through the real resolver; the override is written by the real writer into an isolated ledger directory.
//   MUST-FAIL  intent id null, the real id only in attemptAuthoring, an operator label on it: NOT counted (operator-label);
//   MUST-FAIL  null everywhere (intent and attemptAuthoring, no provenance field on the row): unjudged, unattributable;
//   CONTROL    the real id in attemptAuthoring with no label on it: counted, and the labels were asked for that id.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useUngatedRowsSource } from "../helpers/ungated-rows-source.js";
import { isolateLearnedStateInProcess } from "../resolvers/isolated-gap-store-run.js";
useUngatedRowsSource();

const ROOT = join(tmpdir(), `sf-authoring-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
const LEDGER_DIR = join(ROOT, "attempt-ledger");
mkdirSync(LEDGER_DIR, { recursive: true });
const savedLedger = process.env["ATTEMPT_LEDGER_DIR"];
process.env["ATTEMPT_LEDGER_DIR"] = LEDGER_DIR;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sfr = await import("../../src/resolvers/self-fact-reconcile.js") as Record<string, unknown>;
const { setAuthoringExecution } = await import("../../src/resolvers/attempt-register.js");
const resolveSelfFactReconcile = sfr["resolveSelfFactReconcile"] as (p: unknown) => Promise<unknown>;
const setDeps = sfr["__setJudgementDepsForTests"] as (d: Record<string, unknown> | null) => void;

const SUPER = join(ROOT, "super");
const saved: Record<string, string | undefined> = {};
const git = (...a: string[]) => { const p = Bun.spawnSync(["git", "-C", SUPER, ...a], { stdout: "pipe", stderr: "pipe" }); if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr)); };
const NOW = Date.parse("2026-10-22T12:00:00Z");
const h = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();
const sha = (c: string) => c.repeat(40);
const SITE = "repos/v/src/thing.ts";
const CHECK = "test/thing.check.ts";
const SOURCES: Record<string, string> = { [CHECK]: `import { thing } from "../src/thing.js";\nexpect(thing()).toBe("fixed_value");\n`, "src/thing.ts": `export function thing() { return "fixed_value"; }\n` };
const GAP = "g-authoring-resolved";
// The row carries NO provenance trace field: the authoring execution is the only trace.
const row = { id: GAP, status: "closed", source: "substrate_detected", first_detected_at: h(100), closed_at: h(48), reopen_count: 0,
  classification_metadata: { edit_site: SITE, check_supply: { state: "armed", test_file: CHECK }, predicate_birth_verdict: "present", closed_reason: "landed_verified", close_basis: "absent", landed_sha: sha("a") } };
const ev = (over: Record<string, unknown>) => ({ gap_id: GAP, outcome: "written", principal_kind: "in-process", key_id: null, operator_marker: false, store: "local", route: "in-process", ...over });
const CONTEXT = { fixLiveAt: h(200), keymap: [], forwardingKeys: [], nodeSelfAdminKeys: [] };
let LABELED: Record<string, unknown[]> = {};
let ASKED: string[][] = [];
const deps = (att: string) => ({
  ledger: (kind: string) => kind === "attemptIntent" ? [{ key: att, at: h(50), record: { attempt_id: att, route: "gap_to_feature", gap_id: GAP, directed: false, authoring_execution_id: null } }]
    : kind === "landingEvent" ? [{ key: `spool:${att}`, at: h(50), record: { event: "commit", repo: "/workspace/git/vessels/v", sha: sha("a"), at: h(50), attempt_id: att } }] : [],
  ledgerPresent: () => true, spool: () => [], readGaps: async () => [row],
  readEvents: async () => ({ events: [ev({ fields_changed: ["status"], status_from: "absent", ts: h(100) }), ev({ fields_changed: ["classification_metadata.check_supply"], ts: h(90) })], matched: 2 }),
  keymap: async () => null,
  labels: async (ids: string[]) => { ASKED.push([...ids]); return { labels: ids.flatMap((id) => (LABELED[id] ?? []).map((l) => ({ ...(l as object), execution_id: id }))), context: CONTEXT }; },
  locate: (s: string) => ({ repo: "v", dir: "/clones/v", fullSha: s }), cloneOf: (v: string) => (v === "v" ? "/clones/v" : null), revParse: (_d: string, s: string) => s,
  fixCommit: () => ({ author: "Substrate Autonomous", at: h(50), files: ["src/thing.ts"], on_origin_dev: true }),
  siteCommits: () => [], firstCommit: () => ({ sha: sha("e"), author: "Substrate Autonomous", at: h(95), lane: true, files: [CHECK] }),
  revertsOf: () => [], commit: () => null, show: (_d: string, _s: string, p: string) => SOURCES[p] ?? null,
  scopeActs: async (sites: string[]) => new Map(sites.map((x) => [x, []])), persist: () => ({ appended: true }), now: () => NOW, log: () => {},
});
beforeAll(() => {
  for (const k of ["SUPER_REPO_ROOT", "PROFILE", "PROFILE_EFFECTIVE", "GAP_STORE_ENDPOINT"]) saved[k] = process.env[k];
  delete process.env["PROFILE"]; delete process.env["PROFILE_EFFECTIVE"]; delete process.env["GAP_STORE_ENDPOINT"];
  process.env["SUPER_REPO_ROOT"] = SUPER;
  mkdirSync(join(SUPER, "scripts", "substrate"), { recursive: true });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeFileSync(join(SUPER, "scripts", "substrate", "self-facts.json"), JSON.stringify({ rows: [{ id: "repair_autonomy", instrument: "repair_autonomy", profiles: ["*"], edit_site: "repos/development-vessel/src/resolvers/self-fact-reconcile.ts", must_fail: "fixture:operator-armed-verified-landing", window_hours: 168 }] }));
  git("add", "."); git("commit", "-q", "-m", "rows"); git("update-ref", "refs/remotes/origin/dev", "HEAD");
});
afterAll(() => {
  setDeps(null);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (savedLedger === undefined) delete process.env["ATTEMPT_LEDGER_DIR"]; else process.env["ATTEMPT_LEDGER_DIR"] = savedLedger;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});
type J = { gap_id: string; verdict: string; reason: string; failing_link?: string };
const judge = async (att: string): Promise<J> => {
  setDeps(deps(att));
  const r = (await resolveSelfFactReconcile({ type: "self_fact_reconcile", file_gaps: false, plant_canary: false } as never)) as { body: { judgements: Record<string, J[]> } };
  return r.body.judgements["repair_autonomy"]!.find((j) => j.gap_id === GAP)!;
};

describe("repair_autonomy resolves a landing's authoring execution through attemptAuthoring (B3)", () => {
  it("MUST-FAIL: the real id only in attemptAuthoring, with an operator label on it, is not counted", async () => {
    expect(await setAuthoringExecution("att-real-1", "exec-authoring-real-1")).toBe(true);
    LABELED = { "exec-authoring-real-1": [{ labeler: "human", source: null, created_at: h(60), principal_kind: "session", principal_key_id: null }] }; ASKED = [];
    const j = await judge("att-real-1");
    expect({ verdict: j.verdict, failing_link: j.failing_link ?? null }, j.reason).toEqual({ verdict: "not_counted", failing_link: "operator_act:operator-label" });
  });
  it("MUST-FAIL: no authoring execution anywhere is unjudged, unattributable", async () => {
    LABELED = {}; ASKED = [];
    const j = await judge("att-none-1");
    expect({ verdict: j.verdict, unattributable: /unattributable/i.test(j.reason) }, j.reason).toEqual({ verdict: "unjudged", unattributable: true });
  });
  it("CONTROL: the real id in attemptAuthoring with no label on it counts, and its labels were asked", async () => {
    expect(await setAuthoringExecution("att-real-2", "exec-authoring-real-2")).toBe(true);
    LABELED = {}; ASKED = [];
    const j = await judge("att-real-2");
    expect({ verdict: j.verdict, asked: ASKED.some((ids) => ids.includes("exec-authoring-real-2")) }, j.reason).toEqual({ verdict: "counted", asked: true });
  });
});
