// THE KEY CLASS MAP, READ FROM ITS SERVED SHAPE (identity's apiKeyClass). A gap write made under a key principal is
// attributed by the key's class: an operator key's arm is an operator act, a system key's is the system's. The evaluator
// had no map (keymap: null), so every key-principal write read unattributable and the closure unjudged. It now reads
// apiKeyClass through discovery at use time (readKeyClassMap); the label rule's key context comes from the same shape
// (labelContextFrom), while fixLiveAt is not served, so labels still read REVIEW.
// Through the real resolver, every row input injected except the keymap (and the label reader, whose transport answers
// no labels), whose transport is replaced:
//   MUST-FAIL  the arm writer's key served as operator: not_counted, operator_act:arm;
//   MUST-FAIL  the same key served as system: counted;
//   MUST-FAIL  the map is asked through the apiKeyClass shape;
//   CONTROL    no producer, an unclassified key, two keys sharing the 6-character prefix (an unclassified one included),
//              and a peer key (forwarded,
//              origin unread) all read unjudged, never clean;
//   CONTROL    the label context derives forwarding and node-self admin keys from the served map, and with fixLiveAt
//              not served a label still reads REVIEW.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useUngatedRowsSource } from "../helpers/ungated-rows-source.js";
import { isolateLearnedStateInProcess } from "../resolvers/isolated-gap-store-run.js";
useUngatedRowsSource();

const ROOT = join(tmpdir(), `sf-keyclass-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sfr = await import("../../src/resolvers/self-fact-reconcile.js") as Record<string, unknown>;
const sfrActs = await import("../../src/resolvers/operator-acts.js");
const resolveSelfFactReconcile = sfr["resolveSelfFactReconcile"] as (p: unknown) => Promise<unknown>;
const setDeps = sfr["__setJudgementDepsForTests"] as (d: Record<string, unknown> | null) => void;
const setLabelIo = (sfr["__setOracleLabelIoForTests"] ?? (() => {})) as (io: unknown) => void;
const setKeyIo = (sfr["__setKeyClassIoForTests"] ?? (() => {})) as (io: unknown) => void;

const SUPER = join(ROOT, "super");
const saved: Record<string, string | undefined> = {};
const git = (...a: string[]) => { const p = Bun.spawnSync(["git", "-C", SUPER, ...a], { stdout: "pipe", stderr: "pipe" }); if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr)); };
const NOW = Date.parse("2026-10-22T12:00:00Z");
const h = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();
const sha = (c: string) => c.repeat(40);
const SITE = "repos/v/src/thing.ts";
const CHECK = "test/thing.check.ts";
const SOURCES: Record<string, string> = { [CHECK]: `import { thing } from "../src/thing.js";\nexpect(thing()).toBe("fixed_value");\n`, "src/thing.ts": `export function thing() { return "fixed_value"; }\n` };
const GAP = "g-keyclass";
const ARM_KEY6 = "key_ab";
const ARM_KEY12 = "key_abCDEFGH";
const TRACE = "exec-provenance-1";
const AUTHORING = "exec-authoring-1";
const row = { id: GAP, status: "closed", source: "substrate_detected", first_detected_at: h(100), closed_at: h(48), reopen_count: 0,
  classification_metadata: { edit_site: SITE, check_supply: { state: "armed", test_file: CHECK }, predicate_birth_verdict: "present", closed_reason: "landed_verified", close_basis: "absent", landed_sha: sha("a"), execution_id: TRACE } };
const ev = (over: Record<string, unknown>) => ({ gap_id: GAP, outcome: "written", principal_kind: "in-process", key_id: null, operator_marker: false, store: "local", ...over });
const deps = {
  ledger: (kind: string) => kind === "attemptIntent" ? [{ key: "att-l", at: h(50), record: { attempt_id: "att-l", route: "gap_to_feature", gap_id: GAP, directed: false, authoring_execution_id: AUTHORING } }]
    : kind === "landingEvent" ? [{ key: "spool:att-l", at: h(50), record: { event: "commit", repo: "/workspace/git/vessels/v", sha: sha("a"), at: h(50), attempt_id: "att-l" } }] : [],
  ledgerPresent: () => true, spool: () => [], readGaps: async () => [row],
  // The arm write was made under a KEY principal (6-character id, as gap-write events carry it).
  readEvents: async () => ({ events: [ev({ fields_changed: ["status"], status_from: "absent", ts: h(100) }), ev({ fields_changed: ["classification_metadata.check_supply"], ts: h(90), principal_kind: "key", key_id: ARM_KEY6 })], matched: 2 }),
  locate: (s: string) => ({ repo: "v", dir: "/clones/v", fullSha: s }), cloneOf: (v: string) => (v === "v" ? "/clones/v" : null), revParse: (_d: string, s: string) => s,
  fixCommit: () => ({ author: "Substrate Autonomous", at: h(50), files: ["src/thing.ts"], on_origin_dev: true }),
  siteCommits: () => [], firstCommit: () => ({ sha: sha("e"), author: "Substrate Autonomous", at: h(95), lane: true, files: [CHECK] }),
  revertsOf: () => [], commit: () => null, show: (_d: string, _s: string, p: string) => SOURCES[p] ?? null,
  scopeActs: async (sites: string[]) => new Map(sites.map((x) => [x, []])), persist: () => ({ appended: true }), now: () => NOW, log: () => {},
};
let KEYS: Array<Record<string, unknown>> | null = [];
const KEY_ASKED: Array<Record<string, unknown>> = [];
const keyIo = {
  urls: async () => (KEYS === null ? null : ["http://identity.invalid/v1/auth/resolve"]),
  post: async (_u: string, body: unknown) => { KEY_ASKED.push((body as { impulse: { pointer: Record<string, unknown> } }).impulse.pointer); return { success: true, data: { keys: KEYS, ambiguous_prefix6: [] } }; },
};
const noLabels = { urls: async () => ["http://labels.invalid"], post: async () => ({ success: true, content: "[]" }) };
const key = (id: string, owner_kind: string | null, over: Record<string, unknown> = {}) => ({ key_id_mask12: id, key_id_prefix6: id.slice(0, 6), owner_kind, owner_node: null, is_admin: false, active: true, ...over });

beforeAll(() => {
  for (const k of ["SUPER_REPO_ROOT", "PROFILE", "PROFILE_EFFECTIVE", "GAP_STORE_ENDPOINT"]) saved[k] = process.env[k];
  delete process.env["PROFILE"]; delete process.env["PROFILE_EFFECTIVE"]; delete process.env["GAP_STORE_ENDPOINT"];
  process.env["SUPER_REPO_ROOT"] = SUPER;
  mkdirSync(join(SUPER, "scripts", "substrate"), { recursive: true });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeFileSync(join(SUPER, "scripts", "substrate", "self-facts.json"), JSON.stringify({ rows: [{ id: "repair_autonomy", instrument: "repair_autonomy", profiles: ["*"], edit_site: "repos/development-vessel/src/resolvers/self-fact-reconcile.ts", must_fail: "fixture:operator-armed-verified-landing", window_hours: 168 }] }));
  git("add", "."); git("commit", "-q", "-m", "rows"); git("update-ref", "refs/remotes/origin/dev", "HEAD");
  setDeps(deps); // no keymap given: the default reader runs over the replaced transport
  setKeyIo(keyIo);
  setLabelIo(noLabels);
});
beforeEach(() => { KEYS = []; KEY_ASKED.length = 0; });
afterAll(() => {
  setDeps(null); setKeyIo(null); setLabelIo(null);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});
type J = { gap_id: string; verdict: string; reason: string; failing_link?: string };
const judge = async (): Promise<J> => {
  const r = (await resolveSelfFactReconcile({ type: "self_fact_reconcile", file_gaps: false, plant_canary: false } as never)) as { body: { judgements: Record<string, J[]> } };
  return r.body.judgements["repair_autonomy"]!.find((j) => j.gap_id === GAP)!;
};

describe("repair_autonomy: key-principal writes are attributed by the served key class map", () => {
  it("MUST-FAIL: the arm writer's key served as operator reads not_counted (operator_act:arm)", async () => {
    KEYS = [key(ARM_KEY12, "operator")];
    const j = await judge();
    expect({ verdict: j.verdict, failing_link: j.failing_link }, j.reason).toEqual({ verdict: "not_counted", failing_link: "operator_act:arm" });
  });
  it("MUST-FAIL: the same key served as system reads counted", async () => {
    KEYS = [key(ARM_KEY12, "system", { owner_node: "node-a" })];
    const j = await judge();
    expect(j.verdict, j.reason).toBe("counted");
  });
  it("MUST-FAIL: the map is asked through the apiKeyClass shape", async () => {
    KEYS = [key(ARM_KEY12, "system")];
    await judge();
    expect(KEY_ASKED.map((p) => p["type"])).toContain("apiKeyClass");
  });
  it("CONTROL: no producer, an unclassified key, a shared 6-character prefix, and a peer key read unjudged, never clean", async () => {
    const out: Record<string, string> = {};
    for (const [name, keys] of [
      ["no producer", null],
      ["unclassified", [key(ARM_KEY12, null)]],
      ["shared prefix", [key(ARM_KEY12, "system"), key("key_abZZZZZZ", "operator")]],
      // An unclassified key still makes the prefix ambiguous: dropping it would hand the write to the system key.
      ["shared with an unclassified key", [key(ARM_KEY12, "system"), key("key_abYYYYYY", null)]],
      ["peer", [key(ARM_KEY12, "peer")]],
    ] as Array<[string, Array<Record<string, unknown>> | null]>) { KEYS = keys; out[name] = (await judge()).verdict; }
    expect(out).toEqual({ "no producer": "unjudged", unclassified: "unjudged", "shared prefix": "unjudged", "shared with an unclassified key": "unjudged", peer: "unjudged" });
  });
  it("CONTROL: the label context comes from the served map, and with fixLiveAt unserved a label still reads REVIEW", () => {
    const from = sfr["labelContextFrom"] as (k: unknown, node: string) => { fixLiveAt: string; keymap: unknown[]; forwardingKeys: string[]; nodeSelfAdminKeys: string[] };
    const served = [
      { id: "key_sysHERE1", owner_kind: "system", owner_node: "node-a", is_admin: true },
      { id: "key_sysTHERE", owner_kind: "system", owner_node: "node-b", is_admin: true },
      { id: "key_peer0001", owner_kind: "peer", owner_node: "node-c", is_admin: false },
      { id: "key_oper0001", owner_kind: "operator", owner_node: null, is_admin: true },
    ];
    const ctx = from(served, "node-a");
    expect({ fix: ctx.fixLiveAt, forwarding: ctx.forwardingKeys.sort(), self: ctx.nodeSelfAdminKeys, n: ctx.keymap.length }).toEqual({ fix: "", forwarding: ["key_peer0001", "key_sysTHERE"], self: ["key_sysHERE1"], n: 4 });
    // With fixLiveAt unserved, the label rule (operator-acts.ts classifyOracleLabel, unchanged) reads any label REVIEW.
    const { classifyOracleLabel } = sfrActs;
    expect(classifyOracleLabel({ labeler: "human", source: "human", created_at: h(1), principal_kind: "session" }, ctx as never)).toStartWith("review(");
  });
});
