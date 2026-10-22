// LINK 5 AND THE S-2 ANSWERS, WIRED: repair_autonomy reads goal-host's dispatch records (activeDispatches), each named
// dispatch's resolverAnswers (goalWalkState) and the resolverRequest records those answers name, READ-ONLY, and hands
// them to operator-acts (link5DispatchFindings, classifyS2Answer). Through the real resolver, every read injected.
//   MUST-FAIL  an operator-run dispatch naming the gap makes the closure ASSISTED (operator_act:operator-dispatch);
//   MUST-FAIL  an unreadable dispatch store makes link 5 UNATTRIBUTABLE;
//   MUST-FAIL  a named dispatch whose S-2 answer is an operator's (origin operator) makes it ASSISTED (s2-answer);
//   CONTROL    a system dispatch carrying the BOUND answer of a system-initiated request (its record names the landing's
//              trace) counts, with the SYSTEM answer named; reads not injected are not asked (the closure counts).
// DRAFT: not committed.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useUngatedRowsSource } from "../helpers/ungated-rows-source.js";
import { isolateLearnedStateInProcess } from "../resolvers/isolated-gap-store-run.js";
useUngatedRowsSource();

const ROOT = join(tmpdir(), `sf-link5wire-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sfr = await import("../../src/resolvers/self-fact-reconcile.js") as Record<string, unknown>;
const resolveSelfFactReconcile = sfr["resolveSelfFactReconcile"] as (p: unknown) => Promise<unknown>;
const setDeps = sfr["__setJudgementDepsForTests"] as (d: Record<string, unknown> | null) => void;
const setLabelIo = (sfr["__setOracleLabelIoForTests"] ?? (() => {})) as (io: unknown) => void;

const SUPER = join(ROOT, "super");
const saved: Record<string, string | undefined> = {};
const git = (...a: string[]) => { const p = Bun.spawnSync(["git", "-C", SUPER, ...a], { stdout: "pipe", stderr: "pipe" }); if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr)); };
const NOW = Date.parse("2026-10-22T12:00:00Z");
const h = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();
const sha = (c: string) => c.repeat(40);
const SITE = "repos/v/src/thing.ts";
const CHECK = "test/thing.check.ts";
const SOURCES: Record<string, string> = { [CHECK]: `import { thing } from "../src/thing.js";\nexpect(thing()).toBe("fixed_value");\n`, "src/thing.ts": `export function thing() { return "fixed_value"; }\n` };
const GAP = "g-link5wire";
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
const noLabels = { urls: async () => ["http://labels.invalid"], post: async () => ({ success: true, content: "[]" }) };
const t = (hrs: number) => h(hrs);
const sysAnswer = (origin = "system") => ({ request_id: "rq-1", outcome: "resolved", at: t(60), answered_by_tag: "tag-x", lease_provenance: { request_id: "rq-1", lease_id: "ls-1", attempt: 1, dispatch_id: "d-sys", origin }, answer_id: "ans-1" });
const sysRequest = (origin = "system") => ({ request_id: "rq-1", origin, dispatch_id: "d-sys", attempts: [{ attempt: 1, lease_id: "ls-1", granted_at: t(61), expires_at: t(59), ended_at: t(59.5), answer_binding: { answer_id: "ans-1", accepted_at: t(60) } }] });
let STORE: unknown[] | null = [];
let WALK: Record<string, unknown> = {};
let REQ: Record<string, unknown> = {};
beforeAll(() => {
  for (const k of ["SUPER_REPO_ROOT", "PROFILE", "PROFILE_EFFECTIVE", "GAP_STORE_ENDPOINT"]) saved[k] = process.env[k];
  delete process.env["PROFILE"]; delete process.env["PROFILE_EFFECTIVE"]; delete process.env["GAP_STORE_ENDPOINT"];
  process.env["SUPER_REPO_ROOT"] = SUPER;
  mkdirSync(join(SUPER, "scripts", "substrate"), { recursive: true });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeFileSync(join(SUPER, "scripts", "substrate", "self-facts.json"), JSON.stringify({ rows: [{ id: "repair_autonomy", instrument: "repair_autonomy", profiles: ["*"], edit_site: "repos/development-vessel/src/resolvers/self-fact-reconcile.ts", must_fail: "fixture:operator-armed-verified-landing", window_hours: 168 }] }));
  git("add", "."); git("commit", "-q", "-m", "rows"); git("update-ref", "refs/remotes/origin/dev", "HEAD");
  setLabelIo(noLabels);
});
afterAll(() => {
  setDeps(null); setLabelIo(null);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});
type J = { gap_id: string; verdict: string; reason: string; failing_link?: string; operator_acts?: { s2_system_answers?: string[] } };
const judge = async (inject = true): Promise<J> => {
  setDeps({ ...deps, ...(inject ? { dispatches: async () => STORE, resolverDispatch: async (id: string) => (WALK[id] ?? null) as never, resolverRequest: async (id: string) => (REQ[id] ?? null) as never } : {}) });
  const r = (await resolveSelfFactReconcile({ type: "self_fact_reconcile", file_gaps: false, plant_canary: false } as never)) as { body: { judgements: Record<string, J[]> } };
  return r.body.judgements["repair_autonomy"]!.find((j) => j.gap_id === GAP)!;
};
const v = (j: J) => ({ verdict: j.verdict, failing_link: j.failing_link ?? null });

describe("repair_autonomy reads goal-host's dispatches and S-2 answers (link 5)", () => {
  it("MUST-FAIL: an operator-run dispatch naming the gap makes the closure assisted", async () => {
    STORE = [{ dispatchId: "d-op", startedAt: Date.parse(t(60)), operator: "operator:ac8b0aad", goal: `close ${GAP}` }]; WALK = {}; REQ = {};
    expect(v(await judge())).toEqual({ verdict: "not_counted", failing_link: "operator_act:operator-dispatch" });
  });
  it("MUST-FAIL: an unreadable dispatch store makes link 5 unattributable", async () => {
    STORE = null;
    const j = await judge();
    expect({ verdict: j.verdict, why: j.reason.includes("link 5 UNATTRIBUTABLE") }, j.reason).toEqual({ verdict: "unjudged", why: true });
  });
  it("MUST-FAIL: a named dispatch whose S-2 answer is an operator's makes the closure assisted", async () => {
    STORE = [{ dispatchId: "d-sys", startedAt: Date.parse(t(60)), operator: "rhythm-conductor-drain", goal: `close ${GAP}` }];
    WALK = { "d-sys": { dispatch_id: "d-sys", execution_id: AUTHORING, resolverAnswers: [sysAnswer("operator")] } }; REQ = { "rq-1": sysRequest("operator") };
    expect(v(await judge())).toEqual({ verdict: "not_counted", failing_link: "operator_act:s2-answer" });
  });
  it("CONTROL: a system dispatch with the bound answer of a system-initiated request counts; reads not injected are not asked", async () => {
    STORE = [{ dispatchId: "d-sys", startedAt: Date.parse(t(60)), operator: "rhythm-conductor-drain", goal: `close ${GAP}` }];
    WALK = { "d-sys": { dispatch_id: "d-sys", execution_id: AUTHORING, resolverAnswers: [sysAnswer()] } }; REQ = { "rq-1": sysRequest() };
    const j = await judge();
    expect({ ...v(j), system: j.operator_acts?.s2_system_answers?.length ?? 0 }, j.reason).toEqual({ verdict: "counted", failing_link: null, system: 1 });
    expect(v(await judge(false))).toEqual({ verdict: "counted", failing_link: null });
  });
});
