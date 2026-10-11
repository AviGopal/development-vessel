// SHARED SETUP FOR THE JUDGE-SPLIT BEHAVIOUR PINS (test setup, not a test file).
//
// The gap-to-feature judge split moves judging code out of src/resolvers/gap-to-feature.ts into closed modules, and
// some of it is EXTRACTED (cut out of a residue function into a new named function), which is not byte-pure. Each
// pin in this directory drives a STORED gap set and an ATTEMPT SEQUENCE through the real entry point
// (resolveGapToFeature, which reaches every extraction) and asserts the outcome: the rows the store holds after the
// run, every write in order, bump counts, closes and their closed_reason, escalation calls and cooldown state.
// The pins were written against the tree before any extraction and must stay green after it. They name no
// extracted function and never call one directly, so they hold whichever module the code lives in.
//
// SEAMS (everything is hermetic; nothing reaches a live path):
//   - the gap store is an in-memory fixture behind GAP_STORE_ENDPOINT. substrate-gap forwards every read and every
//     write there (after its own write gates), so the code under test runs its real resolveSubstrateGap /
//     resolveSubstrateGapWrite calls and this store records each one. Reads apply the real store's filters (id,
//     category, status, the operator-hold filter on open reads, exclude_categories, newest first, limit), and
//     include_calibration answers the held expectation calibration a test sets.
//   - every fetch goes through a router: a request no route answers is recorded as a violation and rejected.
//   - the resolvers gap-to-feature hands work to (feature_compose, reachability repair, author_producer,
//     dispatch_goal, uiQuestion_write, doc_drift_fix, patch_with_tools) and the background jobs a tick starts
//     (attempt sweep, scope earn-in, pick baseline stamps) are replaced through bun's mock.module with scripted
//     stand-ins that record their calls. mock.restore() does not undo mock.module, so restoreHarness() re-mocks
//     each with its saved real exports (the cutover-fs-guard discipline).
//   - a filesystem guard records every write target and blocks any outside os.tmpdir() (declared expected blocks
//     only), and the cutover exec guard blocks host lifecycle tools.
//   - every path the tick can write is pointed at a scratch directory.
import { mock } from "bun:test";
import * as realFsp from "node:fs/promises";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Row = Record<string, any>;

// ── scratch environment (set before the test file imports gap-to-feature) ──────────────────────────────────
export const SCRATCH = realFs.mkdtempSync(join(tmpdir(), "judge-pin-"));
export const STORE_URL = "http://gap-store.judge-pin/resolve";
export const DISCOVERY_URL = "http://discovery.judge-pin";
const ENV: Record<string, string | undefined> = {
  ATTEMPT_LEDGER_DIR: join(SCRATCH, "ledger"),
  MITOSIS_RUNTIME_DIR: join(SCRATCH, "runtime"),
  VESSELS_CLONE_ROOT: join(SCRATCH, "clones"),
  VESSEL_CLONE_ROOT: join(SCRATCH, "clones"),
  PROPOSALS_DIR: join(SCRATCH, "proposals"),
  PARKED_LANDINGS_DIR: join(SCRATCH, "parked"),
  EXPECTATION_CALIB_PATH: join(SCRATCH, "expectation-calibration.json"),
  GAP_CLASS_POSTERIOR_PATH: join(SCRATCH, "gap-class-posteriors.json"),
  CLOSE_ORACLE_CALIB_PATH: join(SCRATCH, "close-oracle-calibration.json"),
  DETECTOR_CLOSURE_LEDGER_PATH: join(SCRATCH, "detector-closure-credit.json"),
  COMPOSE_SLOT_DIR: join(SCRATCH, "compose-slots"),
  MAINTENANCE_LEASE_PATH: join(SCRATCH, "maintenance-lease.json"),
  SYSTEMD_UNIT_DIRS: join(SCRATCH, "units"),
  GAP_STORE_ENDPOINT: STORE_URL,
  DISCOVERY_ENDPOINT: DISCOVERY_URL,
  SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER: "1",
  MITOSIS_DIRECT_PUSH: undefined,
  MITOSIS_PUSH_CLONE_DIR: undefined,
  SUBSTRATE_PUSH_VESSELS: undefined,
};
const SAVED_ENV: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(ENV)) {
  SAVED_ENV[k] = process.env[k];
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
}
for (const d of ["ledger", "runtime", "clones", "proposals", "parked", "compose-slots", "units"]) realFs.mkdirSync(join(SCRATCH, d), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
if (!SAVED_WR) process.env["WORKSPACE_ROOT"] = join(SCRATCH, "ws");

// ── the in-memory gap store ─────────────────────────────────────────────────────────────────────────────────
export type StoreWrite = { id: string; status: string; meta: Row; gap: Row; pointer: Row };
export const store = {
  rows: new Map<string, Row>(),
  writes: [] as StoreWrite[],
  reads: [] as Row[],
  calibration: {} as Record<string, { attempts: number; lands: number }>,
  seq: 0,
};
export function resetStore(): void {
  store.rows.clear();
  store.writes.length = 0;
  store.reads.length = 0;
  store.calibration = {};
}
/** Seed a stored row (newer seeds sort first, as the real store orders by updated_at). */
export function seed(row: Row): Row {
  const at = new Date(Date.parse("2026-10-01T00:00:00Z") + (++store.seq) * 1000).toISOString();
  const r = { category: "systematic_failure", source: "operator", status: "open", detected_at: "2026-10-01T00:00:00.000Z", summary: `pin fixture ${row.id}`, updated_at: at, ...row, classification_metadata: { ...(row.classification_metadata ?? {}) } };
  store.rows.set(String(r.id), r);
  return r;
}
export const stored = (id: string): Row | undefined => store.rows.get(id);
export const metaOf = (id: string): Row => (store.rows.get(id)?.classification_metadata ?? {}) as Row;
export const writesFor = (id: string): StoreWrite[] => store.writes.filter((w) => w.id === id);

function storeAnswer(p: Row): Response {
  if (p["type"] === "substrateGap_write") {
    const gap = (p["gap"] ?? {}) as Row;
    const id = String(gap["id"] ?? "");
    const ex = store.rows.get(id);
    const meta = { ...((ex?.["classification_metadata"] ?? {}) as Row), ...((gap["classification_metadata"] ?? {}) as Row) };
    const next = { ...(ex ?? {}), ...gap, classification_metadata: meta, updated_at: new Date(Date.parse("2026-10-01T00:00:00Z") + (++store.seq) * 1000).toISOString() };
    store.rows.set(id, next);
    store.writes.push({ id, status: String(next["status"] ?? "open"), meta: structuredClone(meta), gap: structuredClone(gap), pointer: structuredClone(p) });
    return Response.json({ shape: "substrateGapWriteResult", body: { id, action: ex ? "updated" : "created" } });
  }
  if (p["type"] === "substrateGap") {
    store.reads.push(structuredClone(p));
    let gaps = [...store.rows.values()];
    if (typeof p["id"] === "string" && p["id"]) gaps = gaps.filter((r) => r["id"] === p["id"]);
    if (typeof p["category"] === "string" && p["category"]) gaps = gaps.filter((r) => r["category"] === p["category"]);
    if (typeof p["source"] === "string" && p["source"]) gaps = gaps.filter((r) => r["source"] === p["source"]);
    if (typeof p["status"] === "string" && p["status"]) gaps = gaps.filter((r) => r["status"] === p["status"]);
    if (p["status"] === "open" && !p["id"] && p["include_held"] !== true) gaps = gaps.filter((r) => r["classification_metadata"]?.["operator_hold"] !== true);
    if (Array.isArray(p["exclude_categories"]) && p["exclude_categories"].length) { const ex = new Set(p["exclude_categories"].map(String)); gaps = gaps.filter((r) => !ex.has(String(r["category"]))); }
    gaps = gaps.sort((a, b) => String(b["updated_at"] ?? "").localeCompare(String(a["updated_at"] ?? ""))).slice(0, typeof p["limit"] === "number" ? p["limit"] : 50);
    return Response.json({ shape: "substrateGap", body: { gaps: structuredClone(gaps), total: gaps.length, ...(p["include_calibration"] ? { expectation_calibration: structuredClone(store.calibration) } : {}) } });
  }
  return Response.json({ shape: "structuredError", body: { detail: `pin gap store: unsupported pointer type ${String(p["type"])}` } });
}

// ── the fetch router ────────────────────────────────────────────────────────────────────────────────────────
export type Route = { name: string; match: (url: string, body: Row) => boolean; respond: (url: string, body: Row) => Response | Promise<Response> };
export const net = { routes: [] as Route[], hits: [] as Array<{ name: string; url: string; body: Row }>, violations: [] as string[] };
const ORIGINAL_FETCH = globalThis.fetch;
const discoveryShape = (b: Row): string | null => (b?.pointer?.type === "vesselCapability" ? String(b.pointer.shape ?? "") : null);
const POOL_ROW = { vesselId: "pool-fixture", endpoint: "http://pool.judge-pin", resolve_endpoint: "/v2/impulses/resolve", origin: "local" };
const OPEN_POLICY = [
  { shape: "autonomyScope", updated_at: "2026-01-01T00:00:00Z", body: { unrestricted: true, reason: "pin fixture: explicitly unrestricted" } },
  { shape: "spendEnvelope", updated_at: "2026-01-01T00:00:00Z", body: { uncapped: true, paused: false, reason: "pin fixture: explicitly uncapped" } },
];
/** The routes every pin starts from: the store, the open policy, an advertised llm_completion producer, and
 *  discovery answering "no producer" for any other shape. A test adds routes; later routes win. */
export function defaultRoutes(): Route[] {
  return [
    { name: "discovery (other)", match: (_u, b) => discoveryShape(b) !== null, respond: () => Response.json({ content: { vessels: [], found: false } }) },
    { name: "discovery poolImpulse", match: (_u, b) => discoveryShape(b) === "poolImpulse", respond: () => Response.json({ content: { shape: "poolImpulse", vessels: [POOL_ROW], found: true } }) },
    { name: "discovery llm_completion", match: (_u, b) => discoveryShape(b) === "llm_completion", respond: () => Response.json({ content: { shape: "llm_completion", vessels: [{ vesselId: "llm-fixture", endpoint: "http://llm.judge-pin", resolve_endpoint: "/v2/impulses/resolve" }], found: true } }) },
    { name: "pool", match: (_u, b) => b?.impulse?.type === "poolImpulse", respond: (_u, b) => Response.json({ body: { impulses: OPEN_POLICY.filter((r) => r.shape === b.impulse.shape) } }) },
    { name: "gap store", match: (u) => u.startsWith(STORE_URL), respond: (_u, b) => storeAnswer((b?.impulse?.pointer ?? {}) as Row) },
  ];
}
export function route(r: Route): void { net.routes.push(r); }
export const hitsOf = (name: string) => net.hits.filter((h) => h.name === name);
function installFetch(): void {
  net.routes = defaultRoutes();
  net.hits = [];
  net.violations = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    let body: Row = {};
    try { body = init?.body ? JSON.parse(String(init.body)) : {}; } catch { body = {}; }
    for (let i = net.routes.length - 1; i >= 0; i--) {
      const r = net.routes[i]!;
      if (r.match(url, body)) { net.hits.push({ name: r.name, url, body }); return r.respond(url, body); }
    }
    net.violations.push(`${init?.method ?? "GET"} ${url} ${JSON.stringify(body).slice(0, 160)}`);
    throw new TypeError(`judge-pin fetch router: unrouted request ${init?.method ?? "GET"} ${url}`);
  }) as unknown as typeof fetch;
}

// ── the filesystem guard (records every write target; blocks those outside tmpdir) ──────────────────────────
const ORIG_P: Record<string, any> = { ...realFsp };
const ORIG_S: Record<string, any> = { ...realFs };
const ALLOWED_ROOTS = (() => { const s = new Set<string>([resolve(tmpdir())]); try { s.add(realFs.realpathSync(tmpdir())); } catch { /* lexical */ } return [...s]; })();
const toPath = (p: unknown): string | null => typeof p === "string" ? resolve(p) : p instanceof URL ? resolve(fileURLToPath(p)) : null;
const insideTmp = (abs: string) => ALLOWED_ROOTS.some((r) => abs === r || abs.startsWith(r + "/"));
export const fsLog = { writes: [] as Array<{ op: string; path: string; data: string | null }>, blocked: [] as string[] };
/** Files a test makes readable at a fixed (non-tmp) path, e.g. /workspace/proposals/<id>-compose-report.json, served
 *  by readFile/readFileSync/existsSync without touching the disk. Cleared by beginPin. */
export const readOverlay = new Map<string, string>();
function installFsGuard(): void {
  fsLog.writes = [];
  fsLog.blocked = [];
  const check = (op: string, target: unknown, data: unknown): void => {
    const abs = toPath(target);
    if (abs === null) return;
    fsLog.writes.push({ op, path: abs, data: typeof data === "string" ? data : null });
    if (insideTmp(abs)) return;
    fsLog.blocked.push(`${op} ${abs}`);
    const err = new Error(`judge-pin fs guard: ${op} outside the test tmpdir: ${abs}`) as NodeJS.ErrnoException;
    err.code = "EACCES";
    throw err;
  };
  const targets: Record<string, (a: unknown[]) => unknown[]> = {
    writeFile: (a) => [a[0]], appendFile: (a) => [a[0]], mkdir: (a) => [a[0]], rename: (a) => [a[1]], copyFile: (a) => [a[1]],
    rm: (a) => [a[0]], unlink: (a) => [a[0]], truncate: (a) => [a[0]],
  };
  const P: Record<string, any> = { ...ORIG_P };
  const S: Record<string, any> = { ...ORIG_S };
  for (const [name, pick] of Object.entries(targets)) {
    if (typeof ORIG_P[name] === "function") P[name] = async (...a: unknown[]) => { for (const t of pick(a)) check(`fs/promises.${name}`, t, a[1]); return ORIG_P[name](...a); };
    if (typeof ORIG_S[name] === "function") S[name] = (...a: unknown[]) => { for (const t of pick(a)) check(`fs.${name}`, t, a[1]); return ORIG_S[name](...a); };
    const sync = `${name}Sync`;
    if (typeof ORIG_S[sync] === "function") S[sync] = (...a: unknown[]) => { for (const t of pick(a)) check(`fs.${sync}`, t, a[1]); return ORIG_S[sync](...a); };
  }
  P["readFile"] = async (...a: unknown[]) => { const k = toPath(a[0]); if (k && readOverlay.has(k)) return readOverlay.get(k); return ORIG_P["readFile"](...a); };
  S["readFileSync"] = (...a: unknown[]) => { const k = toPath(a[0]); if (k && readOverlay.has(k)) return readOverlay.get(k); return ORIG_S["readFileSync"](...a); };
  S["existsSync"] = (...a: unknown[]) => { const k = toPath(a[0]); if (k && readOverlay.has(k)) return true; return ORIG_S["existsSync"](...a); };
  P["default"] = P; S["promises"] = P; S["default"] = S;
  mock.module("node:fs/promises", () => P);
  mock.module("node:fs", () => S);
}
function restoreFs(): void {
  mock.module("node:fs/promises", () => ORIG_P);
  mock.module("node:fs", () => ORIG_S);
}

// ── scripted stand-ins for the resolvers a tick hands work to ───────────────────────────────────────────────
type Res = { shape: string; body: unknown };
export const calls = {
  compose: [] as Row[], reachability: [] as Row[], author: [] as Row[], dispatchGoal: [] as Row[], uiWrite: [] as Row[],
  docDrift: [] as Row[], pwt: [] as Row[],
};
const BUSY: Res = { shape: "featureComposeReport", body: { ok: false, verdict: "BUSY", stage: "capacity", error: "pin fixture: lane full" } };
export const script = {
  /** feature_compose answers, consumed in order; the last one repeats. A function is called with the pointer. */
  compose: [BUSY] as Array<Res | ((p: Row) => Res)>,
  reachability: { shape: "reachabilityGapRepairReport", body: { verdict: "UNFAVORABLE" } } as Res,
  author: { shape: "structuredError", body: { error: "pin fixture: mint failed" } } as Res,
  uiWrite: { shape: "structuredError", body: { ok: false, error: "pin fixture: no surface" } } as Res,
  pwt: { shape: "patchWithToolsReport", body: { ok: false, verdict: "UNFAVORABLE" } } as Res,
};
export function resetScripts(): void {
  for (const k of Object.keys(calls) as Array<keyof typeof calls>) calls[k].length = 0;
  script.compose = [BUSY];
  readOverlay.clear();
  script.reachability = { shape: "reachabilityGapRepairReport", body: { verdict: "UNFAVORABLE" } };
  script.author = { shape: "structuredError", body: { error: "pin fixture: mint failed" } };
  script.uiWrite = { shape: "structuredError", body: { ok: false, error: "pin fixture: no surface" } };
  script.pwt = { shape: "patchWithToolsReport", body: { ok: false, verdict: "UNFAVORABLE" } };
}
const R = "../../src/resolvers/";
const SPECS = {
  fc: `${R}feature-compose.js`, rgr: `${R}reachability-gap-repair.js`, ap: `${R}author-producer.js`, dg: `${R}dispatch-goal.js`,
  ui: `${R}ui-write-passthrough.js`, ddf: `${R}doc-drift-fix.js`, ar: `${R}attempt-register.js`, sei: `${R}scope-earn-in.js`,
  ca: `${R}causal-adjudication.js`, pwt: `${R}patch-with-tools.js`,
} as const;
const ORIG: Record<keyof typeof SPECS, Record<string, any>> = {
  fc: { ...(await import("../../src/resolvers/feature-compose.js")) },
  rgr: { ...(await import("../../src/resolvers/reachability-gap-repair.js")) },
  ap: { ...(await import("../../src/resolvers/author-producer.js")) },
  dg: { ...(await import("../../src/resolvers/dispatch-goal.js")) },
  ui: { ...(await import("../../src/resolvers/ui-write-passthrough.js")) },
  ddf: { ...(await import("../../src/resolvers/doc-drift-fix.js")) },
  ar: { ...(await import("../../src/resolvers/attempt-register.js")) },
  sei: { ...(await import("../../src/resolvers/scope-earn-in.js")) },
  ca: { ...(await import("../../src/resolvers/causal-adjudication.js")) },
  pwt: { ...(await import("../../src/resolvers/patch-with-tools.js")) },
};
function installModuleStandIns(): void {
  mock.module(SPECS.fc, () => ({
    ...ORIG.fc,
    resolveFeatureCompose: async (p: Row) => { calls.compose.push(p); const r = script.compose.length > 1 ? script.compose.shift()! : script.compose[0]!; return structuredClone(typeof r === "function" ? r(p) : r); },
    readParkedLanding: async () => null,
  }));
  mock.module(SPECS.rgr, () => ({ ...ORIG.rgr, resolveReachabilityGapRepair: async (p: Row) => { calls.reachability.push(p); return structuredClone(script.reachability); } }));
  mock.module(SPECS.ap, () => ({ ...ORIG.ap, resolveAuthorProducer: async (p: Row) => { calls.author.push(p); return structuredClone(script.author); } }));
  mock.module(SPECS.dg, () => ({ ...ORIG.dg, resolveDispatchGoal: async (p: Row) => { calls.dispatchGoal.push(p); return { shape: "dispatchGoalResult", body: { ok: true, dispatchId: "pin-dispatch" } }; } }));
  mock.module(SPECS.ui, () => ({ ...ORIG.ui, resolveUiWritePassthrough: async (p: Row) => { calls.uiWrite.push(p); return structuredClone(script.uiWrite); } }));
  mock.module(SPECS.ddf, () => ({ ...ORIG.ddf, resolveDocDriftFix: async (p: Row) => { calls.docDrift.push(p); return { shape: "docDriftFixReport", body: { ok: false } }; } }));
  mock.module(SPECS.ar, () => ({ ...ORIG.ar, sweepAttempts: async () => ({ drained: null, outcomes_written: 0, settlements_written: 0, lessons_written: 0, errors: [] }) }));
  mock.module(SPECS.sei, () => ({ ...ORIG.sei, applyScopeProposals: async () => ({ applied: [], refused: [], waiting: null }) }));
  mock.module(SPECS.ca, () => ({ ...ORIG.ca, stampEnvironmentBaseline: async () => "pin_skipped", measureClass1: async () => null, stampBaseline: async () => "pin_skipped" }));
  mock.module(SPECS.pwt, () => ({ ...ORIG.pwt, resolvePatchWithTools: async (p: Row) => { calls.pwt.push(p); return structuredClone(script.pwt); } }));
}
function restoreModuleStandIns(): void {
  for (const k of Object.keys(SPECS) as Array<keyof typeof SPECS>) mock.module(SPECS[k], () => ORIG[k]);
}
installModuleStandIns();

// ── per-test install / restore ──────────────────────────────────────────────────────────────────────────────
const { installCutoverExecGuard, restoreCutoverExecModules } = await import("../resolvers/cutover-exec-guard.js");
let execGuard: { restore: () => string[]; route: (r: { name: string; match: (c: string) => boolean; respond: (c: string) => { exitCode: number; stdout?: string; stderr?: string } }) => void; hits: string[] } | null = null;
/** Answer a blocked host tool (systemctl, docker, ...) for this test; see cutover-exec-guard.ts. */
export function execRoute(name: string, match: (c: string) => boolean, respond: (c: string) => { exitCode: number; stdout?: string; stderr?: string }): void { execGuard!.route({ name, match, respond }); }
export const execHits = (): string[] => [...(execGuard?.hits ?? [])];
/** git in a fixture repo (Bun.spawnSync, as the code under test runs it). Throws on a non-zero exit. */
export function git(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=pin", "-c", "user.email=pin@fixture", "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}
/** beforeEach: fresh store, scripts, router and guards. */
export function beginPin(): void {
  resetStore();
  resetScripts();
  installFetch();
  installFsGuard();
  execGuard = installCutoverExecGuard();
}
/** afterEach: restore fetch/fs/exec and return what the guards saw (unrouted requests, blocked writes, blocked
 *  execs), minus the fs blocks the test declared expected. */
export function endPin(expectedFsBlocks: RegExp[] = []): { fetch: string[]; fs: string[]; exec: string[] } {
  globalThis.fetch = ORIGINAL_FETCH;
  restoreFs();
  const exec = execGuard?.restore() ?? [];
  execGuard = null;
  return { fetch: [...net.violations], fs: fsLog.blocked.filter((b) => !expectedFsBlocks.some((re) => re.test(b))), exec };
}
/** afterAll: undo every module stand-in, the guards and the env. */
export function restoreHarness(): void {
  globalThis.fetch = ORIGINAL_FETCH;
  restoreFs();
  restoreCutoverExecModules();
  restoreModuleStandIns();
  for (const [k, v] of Object.entries(SAVED_ENV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (!SAVED_WR) delete process.env["WORKSPACE_ROOT"];
  try { realFs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* temp */ }
}

/** Run one tick of resolveGapToFeature, capturing its console lines, then let fire-and-forget work settle. */
export async function tick<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const cap = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.log = cap; console.warn = cap; console.error = cap;
  try {
    const result = await fn();
    await new Promise((r) => setTimeout(r, 40));
    return { result, lines };
  } finally { console.log = orig.log; console.warn = orig.warn; console.error = orig.error; }
}
export const RUN = Math.random().toString(36).slice(2, 8);

/** The failed_attempts values the store recorded for a gap, one per write that changed it (starting value first). */
export function faTrail(id: string, initial = 0): number[] {
  const out = [initial];
  for (const w of writesFor(id)) {
    const fa = Number(w.meta.failed_attempts ?? 0);
    if (fa !== out[out.length - 1]) out.push(fa);
  }
  return out;
}
/** Class-posterior writes for `cls` this test made (identified by content, wherever the load-time path points). */
export function posteriorWrites(cls: string): Array<{ alpha: number; beta: number }> {
  const out: Array<{ alpha: number; beta: number }> = [];
  for (const w of fsLog.writes) {
    if (w.op !== "fs.writeFileSync" || !w.data) continue;
    try { const o = JSON.parse(w.data) as Row; const r = o?.[cls]; if (r && typeof r.alpha === "number" && typeof r.beta === "number") out.push({ alpha: r.alpha, beta: r.beta }); } catch { /* not JSON */ }
  }
  return out;
}
/** The compose answers the pins script. */
export const COMPOSE = {
  busy: BUSY,
  unfavorable: { shape: "featureComposeReport", body: { ok: false, verdict: "UNFAVORABLE", stage: "verify", failure_kind: "verify_failed" } } as Res,
  applyFailed: { shape: "featureComposeReport", body: { ok: false, verdict: "UNFAVORABLE", stage: "apply", apply_failed: true, op_count: 3, rolled_back: true } } as Res,
  terminal: (why: string): Res => ({ shape: "featureComposeReport", body: { ok: false, verdict: "REFUSED", stage: "own_check", failure_kind: "terminal_refusal", terminal_refusal: why } }),
  landed: (sha: string): Res => ({ shape: "featureComposeReport", body: { ok: true, verdict: "FAVORABLE", cutovers: [{ vessel: "pin", result: { shape: "cutoverApplied", applied: true, push_status: "pushed", new_git_sha: sha } }] } }),
  stagedOnly: { shape: "featureComposeReport", body: { ok: true, verdict: "FAVORABLE", cutovers: [{ vessel: "pin", result: { shape: "cutoverApplied", applied: true, push_status: "local_only" } }] } } as Res,
};
