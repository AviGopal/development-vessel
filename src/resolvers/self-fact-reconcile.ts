/**
 * self_fact_reconcile — the organ the substrate did not have: a use-time diff of a
 * fact the system holds about ITSELF against the copies it actually reads.
 *
 * WHY THIS EXISTS. Measured 2026-09-22: the deploy step read a fleet inventory
 * copy fifteen days stale with no entry for the live human surface; three fleet
 * vessels had no authoring root and no detector said so for the vessel's whole
 * life; the running human surface served a checkout eleven commits behind; and
 * every code lane's view of the fleet ended at `src/**` while the surface lives
 * under `ui/`. Each is a COPY that stopped tracking its SOURCE, and nothing was
 * positioned to feel the drift. This resolver is that position.
 *
 * ─── THE RULES ──────────────────────────────────────────────────────────────
 *
 * READ AT USE TIME (law 1). Nothing here is cached across ticks. Every source and
 * every copy is read when the tick runs; a bootstrap constant is exactly the
 * failure this detects.
 *
 * A NEGATIVE IS UNATTRIBUTED UNTIL A POSITIVE CONTROL SHARES ITS ADDRESS. Each
 * run plants a CANARY — an in-memory divergence injected on the copy side of one
 * fact — and must report it before any "clean" result counts. A run that cannot
 * find its own canary reports `observed: false`, files a gap about ITSELF, and
 * files nothing else: its clean results are not evidence.
 *
 * DIVERGENCE IS A GAP, NOT A LOG LINE. Each divergence is written through
 * `substrateGap_write` with a STABLE id per (fact, key), so repeated ticks upsert
 * one row instead of accumulating, and with a Class-2 `evidence_resolve` that
 * points back at THIS resolver for THAT fact, so the pending-land sweep verifies
 * a filed divergence by re-running the reconcile — closure by predicate, by the
 * instrument that found it, never by a landing.
 *
 * ─── LAW-1 DEBT, STATED ─────────────────────────────────────────────────────
 *
 * v2 (2026-09-29): the rows are data. `selfFactSpec` rows are read at use time from
 * the git object origin/dev:scripts/substrate/self-facts.json in the super-repo
 * clone, so every node reads the same rows and the authority is a git object, not a
 * working tree. A row registers an instrument (a function below), the profiles whose
 * node holds its copies, its edit site and its must-fail control; an instrument with
 * no row does not run. Instruments are still code; a new instrument is a commit.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";
import { resolveSubstrateGap, resolveSubstrateGapWrite, takeBirthVerdict, class2PredicateKey, birthTreeMoved, BIRTH_PENDING_STALE_MS } from "./substrate-gap.js";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { gateCallSites, measureRetryEvidence, noEffectOverlapRefusal, spanRecord, REFUSAL_JOURNAL_GREP, refusalJournalCounts, refusalJournalLine, refusalsNotRecorded, storedRefusalCounts } from "./retry-evidence.js";
import { HttpDiscoveryAdapter, FetchAdapter } from "@avigopal/ias-executor-ts/adapters";
import type { DiscoveryLookup } from "@avigopal/ias-executor-ts/adapters";

export interface SelfFactReconcilePointer {
  type: "self_fact_reconcile";
  /** Restrict to these fact names; default = every fact in the table. */
  facts?: string[];
  /** With a single fact: count only this divergence key (the per-gap Class-2 predicate). */
  key?: string;
  /** Plant the positive-control canary (default true). The sweep's Class-2 re-check passes false. */
  plant_canary?: boolean;
  /** A per-node finding's node. A node that is not this one cannot judge it, so the run reports unobserved. */
  node?: string;
  /** File divergences as gaps (default true). The sweep's re-check passes false. */
  file_gaps?: boolean;
}

export interface SelfFactDivergence {
  readonly fact: string;
  readonly key: string;
  readonly source: string;
  readonly copy: string;
  readonly detail: string;
  readonly canary: boolean;
  /** Set when the finding is about one node's own state (its journal, its process): only that node judges it. */
  readonly node?: string;
  /** false = counted in divergence_count (a keyed predicate can read it) but never filed as its own gap. */
  readonly file?: boolean;
}

export interface SelfFactResult {
  readonly fact: string;
  readonly source_read: boolean;
  readonly copies_read: number;
  readonly divergences: SelfFactDivergence[];
  readonly note: string;
}

export const SELF_FACT_RECONCILE_ID = "activity:self_fact_reconcile@development-vessel";
export const CANARY_REPO = "canary-vessel-planted-by-self-fact-reconcile";

// ─── read-error ledger: a read that failed is SAID to have failed, never silently null ──
const readErrors: string[] = [];
function noteReadError(what: string, err: unknown): null {
  readErrors.push(`${what}: ${err instanceof Error ? err.message.slice(0, 100) : String(err).slice(0, 100)}`);
  return null;
}

// ─── environment, read at use time ──────────────────────────────────────────
const superRepoRoot = (): string => process.env["SUPER_REPO_ROOT"] ?? "/workspace/git/super-repo";
const runtimeRoot = (): string => process.env["MITOSIS_RUNTIME_DIR"] ?? "/vessels";
const cloneRoot = (): string => process.env["MITOSIS_PUSH_CLONE_DIR"] ?? "/workspace/git/vessels";
const sourceInventoryPath = (): string => join(superRepoRoot(), "scripts", "substrate", "vessels.inventory.json");
const deployInventoryPath = (): string => process.env["VESSELS_INVENTORY"] ?? "/workspace/substrate/fleet/vessels.inventory.json";

type InventoryRow = { unit?: string; repo?: string; manifest?: boolean };
function readInventory(path: string): InventoryRow[] | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { vessels?: InventoryRow[] };
    return Array.isArray(raw.vessels) ? raw.vessels : null;
  } catch (err) {
    return noteReadError(`inventory ${path}`, err);
  }
}
function serviceRepos(rows: InventoryRow[]): string[] {
  return [...new Set(rows.filter((r) => typeof r.repo === "string" && r.repo.length > 0 && String(r.unit ?? "").endsWith(".service")).map((r) => r.repo as string))].sort();
}
function git(args: string[], cwd: string): string | null {
  try {
    const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) return noteReadError(`git ${args[0]} in ${cwd}`, new TextDecoder().decode(p.stderr).trim() || `exit ${p.exitCode}`);
    return new TextDecoder().decode(p.stdout).trim();
  } catch (err) {
    return noteReadError(`git ${args[0]} in ${cwd}`, err);
  }
}
function unitWorkingDirectory(unit: string): string | null {
  try {
    const p = Bun.spawnSync(["systemctl", "show", "-p", "WorkingDirectory", "--value", unit], { stdout: "pipe", stderr: "pipe" });
    const v = new TextDecoder().decode(p.stdout).trim();
    if (p.exitCode !== 0 || v.length === 0) return noteReadError(`systemctl show ${unit}`, `exit ${p.exitCode}`);
    return v.replace(/^!/, "");
  } catch (err) {
    return noteReadError(`systemctl show ${unit}`, err);
  }
}
function hasTsSources(dir: string, depth = 2): boolean {
  if (depth < 0 || !existsSync(dir)) return false;
  try {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
      const p = join(dir, e);
      const st = statSync(p);
      if (st.isFile() && /\.tsx?$/.test(e)) return true;
      if (st.isDirectory() && hasTsSources(p, depth - 1)) return true;
    }
  } catch (err) {
    noteReadError(`readdir ${dir}`, err);
  }
  return false;
}

// ─── the rows (selfFactSpec) ────────────────────────────────────────────────
const ROWS_PATH = "scripts/substrate/self-facts.json";
export interface SelfFactRow {
  id: string; instrument: string; profiles: string[]; edit_site: string; must_fail: string; window_hours?: number; n_floor?: number; unit?: string; pattern?: string; max?: number; must_fail_line?: string; gate?: "active" | "timer";
  must_fail_check?: Record<string, unknown>; repo?: string; site_file?: string; min_sites?: number; journal_unit?: string; journal_grace_minutes?: number; notes?: string;
  /** A standing gap this row's findings belong to; written into each filed gap's metadata and summary. */
  linked_gap?: string;
  /** lookup_classification: the shapes its planted failed lookups ask for, and the planted failure modes. */
  probe_shapes?: string[]; probe_modes?: Array<"timeout" | "network">;
  /** typed_seam_sites: the site regex (git grep -E), pathspecs per clone and in the super-repo, and what is the seam itself. */
  site_pattern?: string; pathspecs?: string[];
  /** typed_seam_sites: a repo whose origin/dev was last fetched or moved longer ago than this reads unobserved (default 6). */
  max_ref_age_hours?: number; super_repo_pathspecs?: string[]; exclude_repos?: string[]; seam_files?: string[];
  /** pool_record_pin: the pool shape whose newest open record is pinned, and the operator-seeded value per node
   *  (thisNode()). A node's value is either a string array (compared as a set of endpoints with `body_field`), or an
   *  object of body fields, each compared on its own: an array as a set of exact strings, anything else by equality.
   *  Fields the object does not name (a reason text) are not compared. A node with no entry that HOLDS the shape is an
   *  `<node>-unpinned` divergence (an unguarded trust root); one holding no such record is not judged (unobserved). */
  pool_shape?: string; body_field?: string; expected_by_node?: Record<string, string[] | PinnedFields>;
  /** The nodes (thisNode()) this row runs on; absent = every node of its profiles. A node not listed SKIPS the row
   *  (reported like a profile skip) rather than reading it unobserved, so a row about one substrate's nodes in this
   *  fleet-shared file never turns another substrate's whole run unobserved. Exception: a pool_record_pin row runs on
   *  an unlisted node that holds its shape with no pinned value, and reports it unpinned. */
  nodes?: string[];
}
function readRows(): SelfFactRow[] | null {
  const raw = git(["show", `origin/dev:${ROWS_PATH}`], superRepoRoot());
  if (raw === null) return null;
  try {
    const j = JSON.parse(raw) as { rows?: unknown };
    if (!Array.isArray(j.rows)) return noteReadError(`rows ${ROWS_PATH}`, "no rows[] array");
    return (j.rows as SelfFactRow[]).filter((r) => r && typeof r.id === "string" && typeof r.instrument === "string" && Array.isArray(r.profiles));
  } catch (err) {
    return noteReadError(`rows ${ROWS_PATH}`, err);
  }
}
// The node's profile is bootstrap identity (where this node sits), not behaviour.
const nodeProfile = (): string => process.env["PROFILE_EFFECTIVE"] ?? process.env["PROFILE"] ?? "standalone";
// Which node this is (bootstrap identity), for findings about one node's own journal or process, and the key its
// trust-root pins are seeded under (expected_by_node). An operator-set SUBSTRATE_NAME names it (the name the rest of
// the vessel already reports). Without one, the vessel's own Ed25519 identity key names it: discovery registration
// creates that key once under the volume, so a container recreate keeps it, while the hostname changes on every
// recreate (node1's did on 2026-10-04 and its pins stopped matching). The id is a digest of the PUBLIC key only.
// The hostname is the last resort, when no key is readable yet; absence is not cached, so a key created later is used.
const IDENTITY_KEY_PATH_DEFAULT = "/workspace/keys/development-vessel.ed25519.pem"; // as discovery-registration.ts
let volumeNodeIdCache: { path: string; id: string } | null = null;
export function volumeNodeId(): string | null {
  const path = process.env["VESSEL_IDENTITY_KEY_PATH"] ?? IDENTITY_KEY_PATH_DEFAULT;
  if (volumeNodeIdCache?.path === path) return volumeNodeIdCache.id;
  try {
    const spki = createPublicKey(createPrivateKey(readFileSync(path, "utf8"))).export({ format: "der", type: "spki" }) as Buffer;
    const id = `key-${createHash("sha256").update(spki.subarray(-32)).digest("hex").slice(0, 12)}`;
    volumeNodeIdCache = { path, id };
    return id;
  } catch {
    return null;
  }
}
export const thisNode = (): string => (process.env["SUBSTRATE_NAME"] ?? "").trim() || volumeNodeId() || hostname();

const unitActive = (unit: string): string => new TextDecoder().decode(Bun.spawnSync(["systemctl", "is-active", unit], { stdout: "pipe", stderr: "pipe", timeout: 5_000 }).stdout).trim();
let isUnitActive = unitActive;
/** Tests only: stand in for systemctl is-active. */
export function __setUnitActiveForTests(f: ((unit: string) => string) | null): void { isUnitActive = f ?? unitActive; }

// ─── lookup_classification: a planted failed discovery lookup must read as "lookup failed" ──
/** The lines the policy readers log for an unreadable policy, built from a lookup's own description
 *  (gap-to-feature readSpendEnvelope / autonomyScopeExcludes wording). */
export function policyReaderTexts(lookupText: string): string[] {
  return [`envelope unreadable: ${lookupText}`, `scope unreadable (${lookupText})`];
}
/** A planted failure is read correctly when discovery reported it as failed (ok:false), its description
 *  says "lookup failed", and no reader line built from it matches the row's defect pattern. An EMPTY ok:true
 *  answer from an address that cannot answer is the defect itself (a failure read as "no producer"); only an
 *  answer that names producers means something really answered there, so the plant did not take. */
export function classifyPlantedLookup(r: { ok: boolean; producers?: unknown[] }, lookupText: string, defect: RegExp): { planted: boolean; misread: string | null } {
  if (r.ok && Array.isArray(r.producers) && r.producers.length > 0) return { planted: false, misread: null };
  if (r.ok) return { planted: true, misread: `the failed lookup came back as an empty answer ("${lookupText.slice(0, 120)}")` };
  if (!/lookup failed/.test(lookupText)) return { planted: true, misread: `described as "${lookupText.slice(0, 120)}", not "lookup failed"` };
  const hit = policyReaderTexts(lookupText).find((t) => defect.test(t));
  // Never quote the hit itself: a detail that matches the pattern would be counted when it is logged.
  return { planted: true, misread: hit ? `a reader line built from it matches the defect pattern (${hit.startsWith("scope") ? "scope" : "envelope"} reader)` : null };
}
/** One planted failed lookup through the typed ias seam, on a fresh client (never the process-wide one). */
async function plantedLookupDefault(shape: string, mode: "timeout" | "network"): Promise<DiscoveryLookup> {
  if (mode === "network") {
    // Nothing listens on the discard port; the connection is refused.
    return new HttpDiscoveryAdapter(new FetchAdapter(), "http://127.0.0.1:9", { lookupBudgetMs: 2_000, failureBackoffMs: 0 }).lookup(shape);
  }
  // A discovery that accepts and never answers: the shape of a slow peer union.
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) });
  try {
    return await new HttpDiscoveryAdapter(new FetchAdapter(), `http://127.0.0.1:${server.port}`, { lookupBudgetMs: 300, failureBackoffMs: 0 }).lookup(shape);
  } finally {
    server.stop(true);
  }
}
let plantedLookup = plantedLookupDefault;
/** Tests only: stand in for the planted lookup (e.g. an adapter that reads a failure as an empty answer). */
export function __setPlantedLookupForTests(f: typeof plantedLookupDefault | null): void { plantedLookup = f ?? plantedLookupDefault; }
// describe() through an instance: describeDiscoveryLookup is not value-imported, so an older ias dist still loads (as in config.ts).
const describer = new HttpDiscoveryAdapter(new FetchAdapter(), "http://127.0.0.1:9");
const describeLookupText = (r: DiscoveryLookup): string => {
  const d = (describer as { describe?: (x: DiscoveryLookup) => string }).describe;
  return typeof d === "function" ? d.call(describer, r) : `${r.shape} lookup failed (adapter_outdated): the loaded ias-executor-ts dist predates the typed discovery lookup()`;
};

// ─── typed_seam_sites: discovery lookups written outside the typed ias seam ──
/** Count site lines from `git grep -n <re> <ref> -- …` output ("<ref>:<path>:<line>:<text>"), leaving out the seam files. */
export function countSiteLines(lines: readonly string[], ref: string, seamFiles: readonly string[]): { count: number; sites: string[] } {
  const sites: string[] = [];
  for (const l of lines) {
    if (!l) continue;
    const rest = l.startsWith(ref + ":") ? l.slice(ref.length + 1) : l;
    const m = rest.match(/^([^:]+):(\d+):/);
    if (!m) continue;
    if (seamFiles.includes(m[1]!)) continue;
    sites.push(`${m[1]}:${m[2]}`);
  }
  return { count: sites.length, sites };
}
/** The sites in one repo at `ref`, or null (said in the read-error ledger) when git could not answer. */
export function countSites(repoDir: string, ref: string, sitePattern: string, pathspecs: readonly string[], seamFiles: readonly string[] = []): { count: number; sites: string[] } | null {
  try {
    const p = Bun.spawnSync(["git", "grep", "-n", "-E", sitePattern, ref, "--", ...pathspecs], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    // git grep exits 1 when nothing matched: a read, zero sites.
    if (p.exitCode === 1 && new TextDecoder().decode(p.stderr).trim() === "") return { count: 0, sites: [] };
    if (p.exitCode !== 0) return noteReadError(`git grep in ${repoDir}`, new TextDecoder().decode(p.stderr).trim() || `exit ${p.exitCode}`);
    return countSiteLines(new TextDecoder().decode(p.stdout).split("\n"), ref, seamFiles);
  } catch (err) {
    return noteReadError(`git grep in ${repoDir}`, err);
  }
}
/** Hours since this clone last learned origin/dev: the newest of its FETCH_HEAD mtime (every fetch rewrites it, even one
 *  that moves nothing) and the reflog time of the ref's last update (a fetch or push that moved it). Null when neither
 *  exists: a ref never fetched has no age, so it cannot be fresh. */
export function refAgeHours(repoDir: string, ref = "refs/remotes/origin/dev", nowMs = Date.now()): number | null {
  let newest = 0;
  try {
    const p = Bun.spawnSync(["git", "rev-parse", "--git-path", "FETCH_HEAD"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode === 0) {
      const rel = new TextDecoder().decode(p.stdout).trim();
      const fh = rel.startsWith("/") ? rel : join(repoDir, rel);
      if (existsSync(fh)) newest = Math.max(newest, statSync(fh).mtimeMs);
    }
    const l = Bun.spawnSync(["git", "log", "-g", "-n", "1", "--format=%gd", "--date=unix", ref], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    const m = new TextDecoder().decode(l.stdout).match(/@\{(\d+)\}/);
    if (l.exitCode === 0 && m) newest = Math.max(newest, Number(m[1]) * 1000);
  } catch (err) {
    noteReadError(`ref age in ${repoDir}`, err);
  }
  return newest > 0 ? (nowMs - newest) / 3_600_000 : null;
}
/** The must-fail control: a scratch repo holding exactly one planted site, plus a test file and a .js twin that
 *  both carry one too and must NOT count. Counted by the same countSites with the row's own pattern and pathspecs. */
export function scratchSiteCount(sitePattern: string, pathspecs: readonly string[]): number | null {
  const dir = mkdtempSync(join(tmpdir(), "self-fact-seam-canary-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    // Built at runtime so this file's own source never matches the site pattern: the canary is a planted
    // copy for the counter to find, not a lookup this vessel makes (it once read as the 66th site).
    const site = `await fetch(url, { body: JSON.stringify({ pointer: { type: "${"vessel" + "Capability"}", shape } }) });\n`;
    writeFileSync(join(dir, "src", "planted.ts"), site);
    writeFileSync(join(dir, "src", "planted.test.ts"), site);
    writeFileSync(join(dir, "src", "planted.js"), site);
    const g = (args: string[]) => Bun.spawnSync(["git", "-c", "user.name=self-fact-reconcile canary", "-c", "user.email=canary@localhost", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" }).exitCode;
    if (g(["init", "-q"]) !== 0 || g(["add", "-A"]) !== 0 || g(["commit", "-q", "-m", "planted site"]) !== 0) return noteReadError("scratch canary repo", "git init/commit failed");
    return countSites(dir, "HEAD", sitePattern, pathspecs)?.count ?? null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── gap_birth_verdicts: the standing measurement of gap_falsify v2 ─────────
/**
 * An unknown birth verdict not re-taken for this long means re-evaluation is not running (qa R1): the
 * pending-land sweep re-takes unknowns oldest first every tick (substrate-gap reevaluateBirthVerdicts) and
 * re-stamps predicate_birth_at when it does, so a 6 h old unknown is one no tick has reached.
 */
const BIRTH_UNKNOWN_NOT_RUNNING_MS = 6 * 3600_000;
/**
 * The PARKED queue (qa C3′ refinement 2): tree-moved unknowns are never re-taken (HEAD only moves further from
 * their base) and resolve only by re-detection with a fresh detection sha. Over this many open, or any older
 * than the age bound, is a divergence: re-detection is not draining them.
 */
const BIRTH_TREE_MOVED_PARKED_MAX = 5;
const BIRTH_TREE_MOVED_PARKED_MAX_AGE_MS = 24 * 3600_000;
// What the instrument reads, injectable for tests (a stubbed store, a fixed scope).
export interface GapBirthDeps {
  readGaps: () => Promise<Array<Record<string, unknown>>>;
  inAutonomyScope: () => Promise<(site: string) => boolean>;
  siteReadable: (site: string) => boolean;
}
const defaultGapBirthDeps: GapBirthDeps = {
  readGaps: async () => {
    const r = await resolveSubstrateGap({ type: "substrateGap", limit: 1_000_000 } as never);
    const gaps = (r.body as { gaps?: unknown } | undefined)?.gaps;
    if (r.shape === "structuredError" || !Array.isArray(gaps)) throw new Error("gap store unreadable");
    return gaps as Array<Record<string, unknown>>;
  },
  inAutonomyScope: async () => {
    const { autonomyScope, autonomyScopeExcludes } = await import("./gap-to-feature.js");
    const scope = await autonomyScope();
    return (site: string) => autonomyScopeExcludes(scope, site) !== null;
  },
  siteReadable: (site: string) => {
    // Same path rule as the gap_falsify pass (gap-lifecycle-scan editSiteSourcePath), read at use time.
    const m = /^repos\/([^/]+)\/(.+?)(?::\d+.*)?$/.exec(site.trim());
    return !!m && /\.(ts|tsx|js|mjs|cjs|py|sh|surql)$/.test(m[2] ?? "") && existsSync(join(process.env["VESSELS_CLONE_ROOT"] ?? "/workspace/git/vessels", m[1] ?? "", m[2] ?? ""));
  },
};
let gapBirthDeps: GapBirthDeps = defaultGapBirthDeps;
/** Tests only: replace what gap_birth_verdicts reads. null restores the defaults. */
export function __setGapBirthDepsForTests(d: Partial<GapBirthDeps> | null): void {
  gapBirthDeps = d ? { ...defaultGapBirthDeps, ...d } : defaultGapBirthDeps;
}

// ─── the one journal reader ─────────────────────────────────────────────────
/**
 * Lines of `unit`'s journal from `sinceHours` ago up to `untilMinutesAgo` ago, filtered server-side by `grep`
 * (journalctl --grep), read asynchronously with a 30 s kill. Exit 1 is "nothing matched", a read. Shared by every
 * instrument that reads a journal; `journal.read` is the seam a test replaces.
 */
async function readJournalLines(unit: string, sinceHours: number, grep: string, untilMinutesAgo = 0): Promise<{ lines: string[] } | { error: string }> {
  const args = ["journalctl", "-u", unit, "--since", `-${sinceHours}h`, ...(untilMinutesAgo > 0 ? ["--until", `-${untilMinutesAgo}min`] : []), "--no-pager", "-o", "cat", "--grep", grep];
  try {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const killer = setTimeout(() => proc.kill(), 30_000);
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(killer);
    if (code !== 0 && code !== 1) return { error: `journal of ${unit} unreadable (exit ${code})` };
    return { lines: text.split("\n").filter((l) => l.length > 0) };
  } catch (err) {
    return { error: `journal of ${unit} unreadable: ${String(err)}` };
  }
}
export const journal = { read: readJournalLines };

// ─── the facts ──────────────────────────────────────────────────────────────
// Each returns what it read and where it diverged. `canary` tells the fact to
// inject one planted divergence on its COPY side (never its source side, so the
// canary cannot masquerade as a real finding).
type FactFn = (canary: boolean, row: SelfFactRow) => SelfFactResult | Promise<SelfFactResult>;

// What pool_record_pin reads: the newest open record of a shape in THIS node's own pool store (the copy the
// policy readers trust), injectable for tests.
export type PoolPinRecord = { id?: string; updated_at?: string; body?: unknown; attested?: { by?: string; evaluator?: string } };
export interface PoolPinDeps {
  readNewest: (shape: string) => Promise<PoolPinRecord | null>;
  /** The criterion's change records (autonomyScopeChange), any status. */
  readChanges: () => Promise<Array<{ body?: unknown }>>;
}
const defaultPoolPinDeps: PoolPinDeps = {
  readNewest: async (shape) => {
    const { resolvePoolImpulse } = await import("./pool-impulse.js");
    return resolvePoolImpulse({ type: "poolImpulse", shape, status: "open", limit: 1 }).body.impulses[0] ?? null;
  },
  readChanges: async () => {
    const { resolvePoolImpulse } = await import("./pool-impulse.js");
    return resolvePoolImpulse({ type: "poolImpulse", shape: "autonomyScopeChange", status: "open" }).body.impulses;
  },
};
/**
 * A SCOPE CHANGE THE CRITERION MADE IS NOT DRIFT (REALIGNMENT §7 step 9). The pinned autonomyScope is the operator-
 * seeded value; the accepted evaluator (scope-earn-in.ts) may change the live record by the adopted criterion,
 * writing it with the evaluator attestation and an append-only autonomyScopeChange record. The pin accepts that, and
 * only that: the live record must carry the pool's evaluator attestation, and its change records (written by that
 * same evaluator) must form
 * an unbroken chain from the pinned excluded_paths to the record's current excluded_paths (each record's prior set is
 * the previous record's after set). Then the expected excluded_paths is the chain's end. Anything else (an unattested
 * or operator-attested edit, a broken chain, a record changed after the last change) is compared to the pin and filed.
 */
export function evaluatorAcceptedExcluded(pinned: readonly string[], rec: PoolPinRecord | null, changes: Array<{ body?: unknown }>): { excluded: string[]; accepted: number } | null {
  // The pool's writer stamps by:"evaluator" only under its one grant (pool-impulse EVALUATOR_TRUST_ROOT_WRITERS), and
  // the change records must name that same evaluator; the grant's name is not repeated here (grant-scan test).
  const evaluator = rec?.attested?.by === "evaluator" ? String(rec.attested.evaluator ?? "") : "";
  if (!rec || !evaluator) return null;
  const current = (rec.body as { excluded_paths?: unknown } | undefined)?.excluded_paths;
  if (!Array.isArray(current)) return null;
  const set = (a: readonly unknown[]) => [...new Set(a.map(String))].sort().join("\n");
  const chain = changes.map((c) => (c.body ?? {}) as { applied_by?: unknown; seq?: unknown; prior_excluded_paths?: unknown; excluded_paths_after?: unknown })
    .filter((b) => b.applied_by === evaluator && Array.isArray(b.prior_excluded_paths) && Array.isArray(b.excluded_paths_after))
    .sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
  // The latest record whose prior set is the pinned set starts the chain; it must run unbroken to the live record.
  let start = -1;
  for (let i = chain.length - 1; i >= 0; i--) if (set(chain[i]!.prior_excluded_paths as unknown[]) === set(pinned)) { start = i; break; }
  if (start < 0) return null;
  for (let i = start + 1; i < chain.length; i++) if (set(chain[i]!.prior_excluded_paths as unknown[]) !== set(chain[i - 1]!.excluded_paths_after as unknown[])) return null;
  const end = chain[chain.length - 1]!.excluded_paths_after as unknown[];
  if (set(end) !== set(current)) return null;
  return { excluded: end.map(String), accepted: chain.length - start };
}
let poolPinDeps: PoolPinDeps = defaultPoolPinDeps;
/** Tests only: replace what pool_record_pin reads. null restores the default. */
export function __setPoolPinDepsForTests(d: Partial<PoolPinDeps> | null): void {
  poolPinDeps = d ? { ...defaultPoolPinDeps, ...d } : defaultPoolPinDeps;
}
const pinKey = (e: string): string => {
  const t = String(e).trim();
  try { const u = new URL(t); if (u.protocol === "http:" || u.protocol === "https:") return u.origin; } catch { /* not a URL */ }
  return t.replace(/\/+$/, "");
};
/** The set difference between a pinned value and the copy read: empty when they are the same set. */
export function pinDiff(expected: readonly string[], actual: readonly string[]): { added: string[]; removed: string[] } {
  const e = new Set(expected.map(pinKey)), a = new Set(actual.map(pinKey));
  return { added: [...a].filter((x) => !e.has(x)).sort(), removed: [...e].filter((x) => !a.has(x)).sort() };
}
export const POOL_PIN_CANARY = "http://canary.planted-by-self-fact-reconcile.invalid:1";
/** A pinned record body, field by field (pool_record_pin's object form). */
export type PinnedFields = Record<string, string[] | string | number | boolean | null>;
/** Per-field differences between a pinned object and a record body: a set field names the entries added and
 *  removed (exact strings: a path set is never URL-normalised, `dir/` and `dir` are different scopes); a scalar
 *  names both values. Pinned null matches an absent field. Empty when every pinned field agrees. */
export function pinFieldDiff(pinned: PinnedFields, body: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [f, want] of Object.entries(pinned)) {
    const got = body[f];
    if (Array.isArray(want)) {
      const actual = Array.isArray(got) ? got.filter((e): e is string => typeof e === "string").map((e) => e.trim()) : [];
      const e = new Set(want.map((x) => String(x).trim())), a = new Set(actual);
      const added = [...a].filter((x) => !e.has(x)).sort(), removed = [...e].filter((x) => !a.has(x)).sort();
      if (!Array.isArray(got)) out.push(`${f}: expected a set of ${e.size}, found ${JSON.stringify(got ?? null)}`);
      else if (added.length > 0 || removed.length > 0) out.push(`${f}: added [${added.join(", ")}], removed [${removed.join(", ")}]`);
    } else if ((want === null && got !== undefined && got !== null) || (want !== null && got !== want)) {
      out.push(`${f}: expected ${JSON.stringify(want)}, found ${JSON.stringify(got ?? null)}`);
    }
  }
  return out;
}
/** pool_record_pin's must-fail control for the object form: the body read with a planted entry in each set field
 *  and each scalar field perturbed. Returns the planted body and the fields that were planted. */
function plantPinnedFields(pinned: PinnedFields, body: Record<string, unknown>): { planted: Record<string, unknown>; fields: string[] } {
  const planted: Record<string, unknown> = { ...body };
  const fields: string[] = [];
  for (const [f, want] of Object.entries(pinned)) {
    const got = body[f];
    if (Array.isArray(want)) planted[f] = [...(Array.isArray(got) ? got : []), "canary-path-planted-by-self-fact-reconcile/"];
    else if (typeof want === "number") planted[f] = (typeof got === "number" ? got : want) + 1;
    else if (typeof want === "boolean") planted[f] = !(typeof got === "boolean" ? got : want);
    else planted[f] = `${String(got ?? want)}-canary`;
    fields.push(f);
  }
  return { planted, fields };
}

const FACTS: Record<string, FactFn> = {
  /**
   * A TRUST-ROOT pool record must equal its operator-seeded value. The policy readers (gap-to-feature) trust a peer
   * node's producers only when the local `substrateNodes` record lists it, so an unexpected endpoint there is a grant
   * of policy authority to whoever wrote it. The pinned value lives in this row (a git object the operator authors),
   * never in the pool it checks. Divergences, per node: the record is missing, or its `body_field` differs from the
   * pinned set (named entries added and removed). Must-fail control: the record read, plus one planted endpoint, is
   * compared by the same function and must be reported.
   */
  pool_record_pin: async (canary, row) => {
    const fact = row.id;
    const node = thisNode();
    const unread = (note: string): SelfFactResult => ({ fact, source_read: false, copies_read: 0, divergences: [], note });
    const shape = String(row.pool_shape ?? "");
    const field = String(row.body_field ?? "");
    let pinned = row.expected_by_node?.[node];
    let acceptedNote = "";
    // Two forms: a string array is one endpoint set at `body_field` (substrateNodes); an object pins named body
    // fields (autonomyScope's excluded_paths and require_falsifier_classes, spendEnvelope's cap and pause).
    const listForm = Array.isArray(pinned);
    if (!shape || (listForm && !field)) return unread(`row ${row.id}: pool_shape or body_field missing`);
    // No pinned value for this node: a trust root it HOLDS is then unguarded here, which is a finding, never a quiet
    // skip (the node's identity changed, or it was never seeded). A node holding no such record is not judged.
    if (pinned === undefined) {
      let held: PoolPinRecord | null;
      try { held = await poolPinDeps.readNewest(shape); } catch (err) { return unread(`pool store unreadable on node ${node}: ${String(err)}`); }
      if (!held) return unread(`row ${row.id}: no pinned ${shape} value for node ${node} and no ${shape} record held, so this node is not judged`);
      const seededFor = Object.keys(row.expected_by_node ?? {});
      const unpinned = (n: string, rec: PoolPinRecord): SelfFactDivergence => ({ fact, key: `${n}-unpinned`, node: n, source: `${row.id} pinned value`, copy: `pool ${shape}/${String(rec.id ?? "?")}@${n} (updated ${String(rec.updated_at ?? "?")})`, detail: `node ${n} holds a ${shape} record but ${row.id} pins no value for it (pinned for: ${seededFor.join(", ") || "none"}), so this trust root is unguarded on ${n}; seed its value under expected_by_node["${n}"] (and \`nodes\`, if the row lists nodes)`, canary: false });
      const out = [unpinned(node, held)];
      // Must-fail control through the same builder: a planted node id holding a planted record is reported unpinned.
      if (canary) { const planted = unpinned(`${node}-planted`, { id: "planted" }); if (planted.key.endsWith("-unpinned")) out.push({ ...planted, key: `${row.id}-canary`, copy: "planted copy", detail: `must-fail control on node ${node}: a planted node holding ${shape} with no pinned value was reported unpinned`, canary: true }); }
      return { fact, source_read: true, copies_read: 1, divergences: out, note: `node ${node}: ${shape} held, no pinned value for this node (unpinned)` };
    }
    if (listForm ? !(pinned as unknown[]).every((e) => typeof e === "string") : (pinned === null || typeof pinned !== "object" || Object.keys(pinned).length === 0)) return unread(`row ${row.id}: no pinned ${shape} value for node ${node}, so this node is not judged`);
    let rec: PoolPinRecord | null;
    try { rec = await poolPinDeps.readNewest(shape); } catch (err) { return unread(`pool store unreadable on node ${node}: ${String(err)}`); }
    const body = (rec?.body && typeof rec.body === "object" ? rec.body : {}) as Record<string, unknown>;
    const out: SelfFactDivergence[] = [];
    const describe = (d: { added: string[]; removed: string[] }) => `added [${d.added.join(", ")}], removed [${d.removed.join(", ")}]`;
    const seeded = listForm ? `[${(pinned as string[]).join(", ")}]` : JSON.stringify(pinned);
    const copy = () => `pool ${shape}/${String(rec?.id ?? "?")}@${node} (updated ${String(rec?.updated_at ?? "?")})`;
    let entries = 0;
    if (!rec) {
      out.push({ fact, key: `${node}-missing`, node, source: `${row.id} pinned value`, copy: `pool ${shape}@${node}`, detail: `node ${node} holds no open ${shape} record; the operator-seeded value is ${seeded}. A trust-root record a node does not hold is read as absent there (closed for autonomyScope and spendEnvelope, local producers only for substrateNodes).`, canary: false });
    } else if (listForm) {
      const raw = body[field];
      const actual = Array.isArray(raw) ? raw.filter((e): e is string => typeof e === "string") : [];
      entries = actual.length;
      const d = pinDiff(pinned as string[], actual);
      if (d.added.length > 0 || d.removed.length > 0) out.push({ fact, key: `${node}-mismatch`, node, source: `${row.id} pinned value`, copy: copy(), detail: `${shape}.${field} on node ${node} differs from the operator-seeded value: ${describe(d)}`, canary: false });
    } else {
      entries = Object.keys(pinned as PinnedFields).length;
      // autonomyScope: a change made by the accepted evaluator through the criterion moves the expected excluded_paths.
      const pinnedPaths = (pinned as PinnedFields)["excluded_paths"];
      if (shape === "autonomyScope" && Array.isArray(pinnedPaths)) {
        let changes: Array<{ body?: unknown }> = [];
        try { changes = await poolPinDeps.readChanges(); } catch { changes = []; }
        const ok = evaluatorAcceptedExcluded(pinnedPaths, rec, changes);
        if (ok) { pinned = { ...(pinned as PinnedFields), excluded_paths: ok.excluded }; acceptedNote = `; ${ok.accepted} evaluator change(s) accepted`; }
      }
      const d = pinFieldDiff(pinned as PinnedFields, body);
      if (d.length > 0) out.push({ fact, key: `${node}-mismatch`, node, source: `${row.id} pinned value`, copy: copy(), detail: `${shape} on node ${node} differs from the operator-seeded value: ${d.join("; ")}`, canary: false });
    }
    // The must-fail control runs on every node that judges this row (each node's own run plants its own copy).
    if (canary) {
      if (listForm) {
        const raw = body[field];
        const actual = Array.isArray(raw) ? raw.filter((e): e is string => typeof e === "string") : [];
        const planted = pinDiff(pinned as string[], [...actual, POOL_PIN_CANARY]);
        if (planted.added.includes(pinKey(POOL_PIN_CANARY))) out.push({ fact, key: `${row.id}-canary`, node, source: `${row.id} pinned value`, copy: "planted copy", detail: `must-fail control on node ${node}: a planted endpoint was reported as ${describe(planted)}`, canary: true });
      } else {
        const { planted, fields } = plantPinnedFields(pinned as PinnedFields, body);
        const reported = pinFieldDiff(pinned as PinnedFields, planted);
        if (fields.every((f) => reported.some((r) => r.startsWith(`${f}: `)))) out.push({ fact, key: `${row.id}-canary`, node, source: `${row.id} pinned value`, copy: "planted copy", detail: `must-fail control on node ${node}: every pinned field planted (${fields.join(", ")}) was reported`, canary: true });
      }
    }
    return { fact, source_read: true, copies_read: rec ? 1 : 0, divergences: out, note: `node ${node}: ${shape} ${rec ? (listForm ? `${entries} entr(ies)` : `${entries} pinned field(s) compared`) : "absent"}; pinned ${listForm ? (pinned as string[]).length : entries}${acceptedNote}` };
  },
  /**
   * A unit's journal must not show a known defect's signature: ONE generic instrument parameterised by its row
   * (unit, pattern, max, window_hours, must_fail_line, gate), so a recurring class is a row of DATA, not new code
   * (REALIGNMENT 2026-09-29 section 7 step 2). Reported under the ROW id. Not observed (source_read false) when
   * the unit is not running here: gate "active" needs the unit active; gate "timer" needs <unit>.timer active
   * AND the service started within the window. The must-fail control goes THROUGH the instrument: the canary is
   * reported only if the row's pattern matches its own must_fail_line, so a pattern that can never match is blind.
   * The journal is filtered server-side (--grep) and read asynchronously, so a chatty unit never blocks the loop.
   */
  journal_pattern: async (canary, row) => {
    const fact = row.id;
    const unit = String(row.unit ?? "");
    const pattern = String(row.pattern ?? "");
    const max = typeof row.max === "number" && row.max >= 0 ? row.max : 0;
    const hours = typeof row.window_hours === "number" && row.window_hours > 0 ? row.window_hours : 1;
    const out: SelfFactDivergence[] = [];
    const unread = (note: string): SelfFactResult => ({ fact, source_read: false, copies_read: 0, divergences: out, note });
    if (!/^[A-Za-z0-9@._-]+$/.test(unit) || !pattern) return unread(`row ${row.id}: unit or pattern missing or invalid`);
    if (unit === "development-vessel") return unread(`row ${row.id}: refuses this vessel's own journal (its detail lines quote the pattern)`);
    if (row.id in FACTS) return unread(`row ${row.id}: a journal_pattern row id must not equal an instrument name`);
    let re: RegExp;
    try { re = new RegExp(pattern); } catch (err) { return unread(`row ${row.id}: invalid pattern: ${String(err)}`); }
    const sys = (args: string[]): string => new TextDecoder().decode(Bun.spawnSync(["systemctl", ...args], { stdout: "pipe", stderr: "pipe", timeout: 5_000 }).stdout).trim();
    try {
      if (row.gate === "timer") {
        const timer = sys(["is-active", `${unit}.timer`]);
        if (timer !== "active") return unread(`${unit}.timer is ${timer || "unknown"} on this node`);
        const m = sys(["show", unit, "-p", "ExecMainStartTimestamp", "--value", "--timestamp=unix"]).match(/^@(\d+)$/);
        const ranAt = m ? Number(m[1]) : 0;
        if (!ranAt || Date.now() / 1000 - ranAt > hours * 3600) return unread(`${unit} has not run in the last ${hours}h on this node`);
      } else {
        const active = sys(["is-active", unit]);
        if (active !== "active") return unread(`${unit} is ${active || "unknown"} on this node, so its journal says nothing about the defect`);
      }
      const read = await journal.read(unit, hours, pattern);
      if ("error" in read) return unread(read.error);
      let n = 0;
      for (const line of read.lines) if (re.test(line)) n++;
      if (n > max) out.push({ fact, key: row.id, source: `journal:${unit}`, copy: `last ${hours}h`, detail: `${n} line(s) in ${unit}'s journal over the last ${hours}h match the ${row.id} pattern (allowed ${max})`, canary: false });
      if (canary && typeof row.must_fail_line === "string" && re.test(row.must_fail_line)) {
        out.push({ fact, key: `${row.id}-canary`, source: `journal:${unit}`, copy: `last ${hours}h`, detail: "must-fail control: the row's pattern matches its own must_fail_line", canary: true });
      }
      return { fact, source_read: true, copies_read: 1, divergences: out, note: `${n} matching line(s) over ${hours}h` };
    } catch (err) {
      return unread(`journal of ${unit} unreadable: ${String(err)}`);
    }
  },
  /**
   * gap_falsify v2's STANDING MEASUREMENT (the intervention is measured every tick, not validated once).
   * (a) the birth verdicts the write seam took over the row's window: present / absent / unknown / pending;
   *     'absent' is split by tree (absent_same_tree: a detection sha was given and the check's dependent files
   *     did not change between it and the evaluated tree;
   *     absent_detection_unknown: no detection sha was given, so the queued tree was the base;
   *     absent_eval_tree_unread: exactly the absents with no tree readable at all, so nothing was compared) and tree-moved unknowns are counted apart, as a parked queue: over BIRTH_TREE_MOVED_PARKED_MAX open or
   *     any older than BIRTH_TREE_MOVED_PARKED_MAX_AGE_MS is the divergence unknown-tree-moved-parked.
   *     Class-2 rows born in the window with no verdict, a verdict pending past an hour, or an unknown not
   *     re-taken for BIRTH_UNKNOWN_NOT_RUNNING_MS (the sweep re-takes unknowns every tick) are a divergence:
   *     the birth evaluation is not running. A tree-moved unknown is not counted: no re-take can resolve it.
   * (b) the falsifier supply backlog (gap-lifecycle-scan isFalsifierSupplyCandidate): it must fall or hold, so
   *     a count above the row's `max` (its recorded baseline) is a divergence.
   * (c) must-fail control: the row's `must_fail_check` is a class-2 check KNOWN TO PASS on the current tree
   *     (an inverted predicate). It is run through the seam's own birth evaluator (takeBirthVerdict), which
   *     must answer 'absent'. 'present' means the evaluator cannot tell an inverted check from a real one:
   *     the canary is not reported, the row reads blind, and the run files a gap about itself. 'unknown'
   *     means the control did not RUN (no result, a timeout, a spawn or transport error): that says nothing
   *     about the evaluator either way, so the row is UNOBSERVED (source_read false; qa R2), never blind and
   *     never healthy.
   */
  gap_birth_verdicts: async (canary, row) => {
    const fact = row.id;
    const out: SelfFactDivergence[] = [];
    const hours = typeof row.window_hours === "number" && row.window_hours > 0 ? row.window_hours : 1;
    const nowMs = Date.now();
    let gaps: Array<Record<string, unknown>>;
    try { gaps = await gapBirthDeps.readGaps(); } catch (err) {
      noteReadError("gap store for gap_birth_verdicts", err);
      return { fact, source_read: false, copies_read: 0, divergences: out, note: "gap store unreadable" };
    }
    const within = (iso: unknown): boolean => { const t = Date.parse(String(iso ?? "")); return Number.isFinite(t) && nowMs - t <= hours * 3600_000; };
    const dist: Record<string, number> = { present: 0, absent: 0, unknown: 0, pending: 0 };
    let absentSameTree = 0;
    let absentDetectionUnknown = 0;
    let absentEvalTreeUnread = 0;
    let unknownTreeMoved = 0;
    let oldestTreeMovedAt = Infinity;
    let unstamped = 0;
    let stuck = 0;
    let unknownStale = 0;
    for (const g of gaps) {
      const m = (g["classification_metadata"] ?? {}) as Record<string, unknown>;
      const v = m["predicate_birth_verdict"];
      const bornAt = Date.parse(String(m["predicate_birth_at"] ?? ""));
      if (typeof v === "string" && within(m["predicate_birth_at"])) {
        dist[v] = (dist[v] ?? 0) + 1;
        if (v === "absent") {
          const has = (f: string): boolean => typeof m[f] === "string" && String(m[f]).length > 0;
          // EXACTLY the absents taken with no tree readable at all (no evaluated, detected or queued sha):
          // the one case a tree comparison could not be attempted, so the absent stood unchecked.
          if (!has("predicate_birth_sha") && !has("predicate_birth_detected_sha") && !has("predicate_birth_queued_sha")) absentEvalTreeUnread++;
          // A detection sha was given and the check's files did not change since it (a moved tree is stamped unknown).
          else if (has("predicate_birth_detected_sha")) absentSameTree++;
          else absentDetectionUnknown++;
        }
      }
      if (v === "unknown" && birthTreeMoved(m) && String(g["status"] ?? "open") === "open") {
        unknownTreeMoved++;
        if (Number.isFinite(bornAt)) oldestTreeMovedAt = Math.min(oldestTreeMovedAt, bornAt);
      }
      if (v === "pending" && bornAt < nowMs - BIRTH_PENDING_STALE_MS) stuck++;
      if (v === "unknown" && !birthTreeMoved(m) && String(g["status"] ?? "open") === "open" && bornAt < nowMs - BIRTH_UNKNOWN_NOT_RUNNING_MS) unknownStale++;
      const cls = String(m["falsifier"] ?? "").toLowerCase();
      if (cls === "class2" && String(g["status"] ?? "open") === "open" && within(g["created_at"] ?? g["first_detected_at"]) && (v === undefined || v === null || v === "")) unstamped++;
    }
    if (unstamped + stuck + unknownStale > 0) out.push({ fact, key: "birth-evaluation-not-running", source: "substrateGap_write birth evaluation", copy: "gap store", detail: `${unstamped} class-2 gap(s) born in the last ${hours}h carry no predicate_birth_verdict, ${stuck} are pending past an hour and ${unknownStale} unknown(s) were not re-taken for ${BIRTH_UNKNOWN_NOT_RUNNING_MS / 3600_000}h: birth evaluation (the write seam's, or the sweep's re-take) is not running`, canary: false });
    const parkedAgeH = Number.isFinite(oldestTreeMovedAt) ? Math.floor((nowMs - oldestTreeMovedAt) / 3600_000) : 0;
    if (unknownTreeMoved > BIRTH_TREE_MOVED_PARKED_MAX || (Number.isFinite(oldestTreeMovedAt) && nowMs - oldestTreeMovedAt > BIRTH_TREE_MOVED_PARKED_MAX_AGE_MS)) {
      out.push({ fact, key: "unknown-tree-moved-parked", source: "tree-moved birth verdicts (open)", copy: "gap store", detail: `${unknownTreeMoved} open class-2 gap(s) are parked as tree-moved unknowns (bound ${BIRTH_TREE_MOVED_PARKED_MAX}), the oldest ${parkedAgeH}h (bound ${BIRTH_TREE_MOVED_PARKED_MAX_AGE_MS / 3600_000}h): they resolve only when the defect is re-detected with a fresh detection sha, and that is not happening`, canary: false });
    }
    let backlog = 0;
    try {
      const inScope = await gapBirthDeps.inAutonomyScope();
      const { isFalsifierSupplyCandidate } = await import("./gap-lifecycle-scan.js");
      backlog = gaps.filter((g) => isFalsifierSupplyCandidate(g as never, inScope, gapBirthDeps.siteReadable)).length;
    } catch (err) {
      noteReadError("supply backlog for gap_birth_verdicts", err);
      return { fact, source_read: false, copies_read: 1, divergences: out, note: "autonomy scope or supply predicate unreadable" };
    }
    const baseline = typeof row.max === "number" && row.max >= 0 ? row.max : null;
    if (baseline !== null && backlog > baseline) out.push({ fact, key: "supply-backlog-rose", source: `row ${row.id} max ${baseline}`, copy: "gap store", detail: `the falsifier supply backlog is ${backlog}, above its recorded baseline ${baseline}: gap_falsify is not keeping up with the gaps filed without a check`, canary: false });
    let control = "not planted";
    if (canary) {
      const chk = row.must_fail_check;
      if (chk && typeof chk === "object") {
        const meta: Record<string, unknown> = { ...chk, falsifier: "class2" };
        const verdict = await takeBirthVerdict(`${fact}-must-fail-control`, meta);
        control = verdict;
        // The control did not run: the evaluator is unobserved, not blind and not healthy (qa R2).
        if (verdict === "unknown") {
          return { fact, source_read: false, copies_read: 1, divergences: out, note: `canary unobserved: the must-fail control did not run (no result, a timeout or a spawn/transport error), so this run says nothing about the birth evaluator` };
        }
        if (verdict === "absent") out.push({ fact, key: `${row.id}-canary`, source: `must_fail_check ${class2PredicateKey(meta).slice(0, 120)}`, copy: "takeBirthVerdict", detail: "must-fail control: a check known to pass on the current tree was stamped absent", canary: true });
      } else control = "no must_fail_check in the row";
    }
    return {
      fact, source_read: true, copies_read: 1, divergences: out,
      note: `birth verdicts over ${hours}h: present=${dist.present} absent=${dist.absent} unknown=${dist.unknown} pending=${dist.pending}; absent_same_tree=${absentSameTree} absent_detection_unknown=${absentDetectionUnknown} absent_eval_tree_unread=${absentEvalTreeUnread} unknown_tree_moved=${unknownTreeMoved} (oldest ${parkedAgeH}h); unstamped=${unstamped} stuck=${stuck} unknown_stale=${unknownStale}; supply backlog=${backlog}${baseline !== null ? ` (baseline ${baseline})` : ""}; must-fail control=${control}`,
    };
  },
  /**
   * RETRY EVIDENCE IS ENFORCED AND CLASSED BY STAGE (intervention 2, 09-30). Over the gap store's failure_lessons
   * written in the window: (1) retries whose edited spans overlap a region an earlier attempt on the same gap
   * edited with no effect on its own check (the applier refuses those, so the expected count is 0); (2) lessons
   * whose class contradicts the stage their attempt failed at (a typecheck class on a non-typecheck failure, or a
   * scope withhold labelled anything but scope). Two must-fail controls run through the same code the lane runs:
   * a planted gap with both defects must be measured (the canary), and a planted retry that re-edits a no-effect
   * span must be REFUSED by the applier's own refusal function; if it is not, that is a real divergence.
   */
  retry_evidence: async (canary, row) => {
    const fact = row.id;
    const hours = typeof row.window_hours === "number" && row.window_hours > 0 ? row.window_hours : 24;
    const out: SelfFactDivergence[] = [];
    let rows: Array<Record<string, unknown>> = [];
    try {
      const read = await resolveSubstrateGap({ type: "substrateGap", limit: 20000 } as never);
      const g = (read as { body?: { gaps?: unknown } }).body?.gaps;
      if (!Array.isArray(g)) return { fact, source_read: false, copies_read: 0, divergences: out, note: "gap store unreadable" };
      rows = g as Array<Record<string, unknown>>;
    } catch (err) {
      noteReadError("gap store read for retry_evidence", err);
      return { fact, source_read: false, copies_read: 0, divergences: out, note: "gap store unreadable" };
    }
    // ENFORCEMENT IS IN THE SOURCE: the per-op gate's call sites, counted at origin/dev in the push clone (the
    // authority is a git object, not a working tree). A site counts only when its result is branched on.
    const repo = String(row.repo ?? "development-vessel");
    const siteFile = String(row.site_file ?? "src/resolvers/feature-compose.ts");
    const minSites = typeof row.min_sites === "number" && row.min_sites > 0 ? row.min_sites : 4;
    const srcText = git(["show", `origin/dev:${siteFile}`], join(cloneRoot(), repo));
    if (srcText === null) return { fact, source_read: false, copies_read: 0, divergences: out, note: `${repo} origin/dev:${siteFile} unreadable; the gate's call sites cannot be counted` };
    const sites = gateCallSites(srcText);
    if (sites.consumed < minSites) out.push({ fact, key: "gate-call-sites", source: `${repo} origin/dev:${siteFile}`, copy: `at least ${minSites} branched call sites`, detail: `checkOpNoEffect has ${sites.consumed} branched call site(s) (${sites.calls} calls; unbranched at line(s) ${sites.unconsumed_lines.join(",") || "none"}), fewer than the ${minSites} write sites that must call it: a write path can skip the no-effect constraint`, canary: false });
    const m = measureRetryEvidence(rows, Date.now() - hours * 3600_000);
    // Retries that got past apply owe edited spans; none recorded means span recording is broken, and a zero
    // overlap count over no spans is not evidence of enforcement.
    if (m.retries_expecting_spans > 0 && m.retries_with_spans === 0) return { fact, source_read: false, copies_read: 1, divergences: out, note: `UNOBSERVED: ${m.retries_expecting_spans} retries in ${hours}h got past apply but none recorded edited spans, so the overlap count is not a measurement (gate sites ${sites.consumed}/${sites.calls})` };
    // EVERY JOURNALED REFUSAL MUST BE STORED. compose journals each refusal with its gap id; the lessons must hold at
    // least as many for that gap in the window. The journal is read up to a grace before now, since a compose stores
    // its refusals only when it ends. A gap whose lesson list is full (8) may have evicted some: not judged.
    const jUnit = String(row.journal_unit ?? "development-vessel");
    const grace = typeof row.journal_grace_minutes === "number" && row.journal_grace_minutes >= 0 ? row.journal_grace_minutes : 30;
    const jr = await journal.read(jUnit, hours, REFUSAL_JOURNAL_GREP, grace);
    if ("error" in jr) return { fact, source_read: false, copies_read: 1, divergences: out, note: `UNOBSERVED: refusal journal cross-check could not read ${jUnit}: ${jr.error}` };
    const notRecorded = refusalsNotRecorded(refusalJournalCounts(jr.lines), storedRefusalCounts(rows, Date.now() - hours * 3600_000));
    if (notRecorded.gaps.length > 0) out.push({ fact, key: "refusals-not-recorded", source: `journal:${jUnit}`, copy: "gap store failure_lessons refusals", detail: `${notRecorded.gaps.length} gap(s) have more journaled no-effect refusals than stored refusal records over ${hours}h (to ${grace} min ago): a refusal was enforced but not recorded, so its repeat cannot escalate. First: ${notRecorded.gaps[0]}`, canary: false });
    if (m.gaps_stuck_unescalated > 0) out.push({ fact, key: "stuck-on-refusals", source: "gap store failure_lessons", copy: `last ${hours}h`, detail: `${m.gaps_stuck_unescalated} of ${m.gaps_stuck_on_refusals} gaps had one region refused repeatedly with no escalation recorded: a silent refusal loop. First: ${m.offenders.find((o) => o.kind === "stuck_refusal")?.gap ?? "?"}`, canary: false });
    if (m.retries_overlapping_no_effect > 0) out.push({ fact, key: "overlap", source: "gap store failure_lessons", copy: `last ${hours}h`, detail: `${m.retries_overlapping_no_effect} of ${m.retries_with_spans} retries edited a region a prior attempt on the same gap edited with no effect on its own check (expected 0: the applier refuses these). First: ${m.offenders.find((o) => o.kind === "overlap")?.gap ?? "?"}`, canary: false });
    const mismatched = m.lessons_with_stage - m.lessons_class_matching_stage;
    if (mismatched > 0) out.push({ fact, key: "class-stage", source: "gap store failure_lessons", copy: `last ${hours}h`, detail: `${mismatched} of ${m.lessons_with_stage} failure lessons carry a class that contradicts their failing stage. First: ${JSON.stringify(m.offenders.find((o) => o.kind === "class_stage") ?? {})}`, canary: false });
    // Enforcement controls, every run: a planted overlapping retry must be refused and a planted disjoint one allowed.
    const base = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const lock = spanRecord("repos/canary/src/x.ts", base, 3, 5);
    const refused = { path: "repos/canary/src/x.ts", start: 4, end: 4, region_sha: lock.text_sha, region_start: 3, region_end: 5 };
    const planted = [
      { at: new Date().toISOString(), class: "verify_failed", stage: "own_check", no_effect_vs_parent: true, edited_spans: [lock] },
      { at: new Date().toISOString(), class: "typecheck_dangling_reference", stage: "own_check", edited_spans: [spanRecord("repos/canary/src/x.ts", base, 4, 4)] },
      { at: new Date().toISOString(), class: "no_effect_region", stage: "apply", edited_spans: [], refusals: [refused] },
      { at: new Date().toISOString(), class: "no_effect_region", stage: "apply", edited_spans: [], refusals: [refused] },
    ];
    if (noEffectOverlapRefusal("repos/canary/src/x.ts", base, { start: 4, end: 4 }, planted) === null) out.push({ fact, key: "enforcement-not-refusing", source: "noEffectOverlapRefusal", copy: "planted retry", detail: "a planted retry re-editing a no-effect span was NOT refused: the no-effect constraint is not enforced", canary: false });
    if (noEffectOverlapRefusal("repos/canary/src/x.ts", base, { start: 10, end: 11 }, planted) !== null) out.push({ fact, key: "enforcement-over-refusing", source: "noEffectOverlapRefusal", copy: "planted retry", detail: "a planted retry editing a disjoint region was refused: the constraint refuses more than the no-effect span", canary: false });
    if (canary) {
      const c = measureRetryEvidence([{ id: CANARY_REPO, classification_metadata: { failure_lessons: planted } }]);
      const plantedJournal = refusalsNotRecorded(refusalJournalCounts([refusalJournalLine("op", "canary-gap", noEffectOverlapRefusal("repos/canary/src/x.ts", base, { start: 4, end: 4 }, planted) ?? "")]), new Map());
      const plantedSites = gateCallSites(["const a = checkOpNoEffect(op, base, l);", "if (a) return;", "const b = checkOpNoEffect(op, base, l);", "write(b);"].join("\n"));
      if (c.retries_overlapping_no_effect === 1 && c.lessons_with_stage - c.lessons_class_matching_stage === 1 && c.gaps_stuck_unescalated === 1 && plantedSites.calls === 2 && plantedSites.consumed === 1 && plantedJournal.gaps.length === 1) {
        out.push({ fact, key: `${fact}-canary`, source: "planted gap", copy: "this run", detail: "must-fail control: a planted overlapping retry, a stage-contradicting class, an unescalated repeat refusal, an unbranched gate call and an unrecorded journaled refusal were all measured", canary: true });
      }
    }
    return { fact, source_read: true, copies_read: 2, divergences: out, note: `${m.retries_with_spans} retries with spans, ${m.retries_overlapping_no_effect} overlapping; ${m.lessons_class_matching_stage}/${m.lessons_with_stage} lessons class-matches-stage; ${m.gaps_stuck_on_refusals} gap(s) stuck on refusals (${m.gaps_stuck_unescalated} unescalated); gate call sites ${sites.consumed}/${sites.calls} (min ${minSites}) over ${hours}h` };
  },
  /**
   * A failed discovery lookup must never be read as "no producer" (intervention 1, ias 4719cb4 + dev 8b48805f).
   * Per node. Two readings, both under the ROW id:
   *  1. COUNT: lines in `unit`'s journal over window_hours matching `pattern` (the misread signature); more than
   *     `max` is a finding keyed by this node. Positive control for the counter: the pattern must match its own
   *     must_fail_line, as in journal_pattern.
   *  2. PLANTED FAILURE (the must-fail control on the behaviour): for each probe shape and mode, a failed lookup is
   *     planted through the typed ias seam on a fresh client (a refused connection; a discovery that never
   *     answers). Its description must say "lookup failed" and no policy-reader line built from it may match
   *     `pattern`. A misread is a REAL finding (the regression itself), filed against the row's edit site, not a
   *     blind canary; an EMPTY answer is the misread itself. A plant answered WITH producers is unobserved.
   * Unlike journal_pattern this reads development-vessel's own journal, so it refuses a pattern that matches any
   * text this row would itself cause to be logged (its gap ids, details, falsifier), instead of refusing the unit.
   * Coverage: (2) exercises the seam and its description; a reader that stops calling the seam is typed_seam_sites'.
   */
  lookup_classification: async (canary, row) => {
    const fact = row.id;
    const node = thisNode();
    const unit = String(row.unit ?? "");
    const pattern = String(row.pattern ?? "");
    const max = typeof row.max === "number" && row.max >= 0 ? row.max : 0;
    const hours = typeof row.window_hours === "number" && row.window_hours > 0 ? row.window_hours : 1;
    const shapes = Array.isArray(row.probe_shapes) && row.probe_shapes.length > 0 ? row.probe_shapes : ["poolImpulse"];
    const modes = Array.isArray(row.probe_modes) && row.probe_modes.length > 0 ? row.probe_modes : (["timeout", "network"] as const);
    const out: SelfFactDivergence[] = [];
    const unread = (note: string): SelfFactResult => ({ fact, source_read: false, copies_read: 0, divergences: [], note });
    if (!/^[A-Za-z0-9@._-]+$/.test(unit) || !pattern) return unread(`row ${row.id}: unit or pattern missing or invalid`);
    if (row.id in FACTS) return unread(`row ${row.id}: a row id must not equal an instrument name`);
    let re: RegExp;
    try { re = new RegExp(pattern); } catch (err) { return unread(`row ${row.id}: invalid pattern: ${String(err)}`); }
    const countKey = `${node}`;
    const misreadKey = `${node}-planted-lookup-misread`;
    const countDetail = (n: number) => `${n} line(s) in ${unit}'s journal on node ${node} over the last ${hours}h read a failed or absent discovery lookup as the ${row.id} signature (allowed ${max})`;
    // Self-quote guard: everything this row can cause to be logged must be invisible to its own pattern.
    const selfTexts = [countDetail(999), gapId({ fact, key: countKey, source: "", copy: "", detail: "", canary: false }), gapId({ fact, key: misreadKey, source: "", copy: "", detail: "", canary: false }), `class 2: self_fact_reconcile with facts=[${fact}] key=${misreadKey}`, "planted failed lookup misread", `planted failed lookup misread on node ${node}: poolImpulse/timeout: the failed lookup came back as an empty answer ("no poolImpulse producer"); a reader line built from it matches the defect pattern (envelope reader)`];
    if (selfTexts.some((t) => re.test(t))) return unread(`row ${row.id}: its pattern matches text this row itself logs, so its count would feed itself`);
    if (isUnitActive(unit) !== "active") return unread(`${unit} is not active on node ${node}, so its journal says nothing about the defect`);
    let n = 0;
    try {
      // The shared journal reader (journal.read), the same one journal_pattern and retry_evidence use.
      const j = await journal.read(unit, hours, pattern);
      if ("error" in j) return unread(j.error);
      for (const line of j.lines) if (re.test(line)) n++;
    } catch (err) {
      return unread(`journal of ${unit} unreadable: ${String(err)}`);
    }
    if (n > max) out.push({ fact, key: countKey, node, source: `journal:${unit}@${node}`, copy: `last ${hours}h`, detail: countDetail(n), canary: false });
    // The planted failures.
    const misreads: string[] = [];
    let planted = 0;
    for (const shape of shapes) for (const mode of modes) {
      let r: DiscoveryLookup;
      try { r = await plantedLookup(shape, mode); } catch (err) { misreads.push(`${shape}/${mode}: the seam threw instead of answering: ${String(err).slice(0, 120)}`); planted++; continue; }
      const c = classifyPlantedLookup(r, describeLookupText(r), re);
      if (!c.planted) return unread(`the planted ${mode} failure for ${shape} was answered with producers, so the control could not be planted and this run is not evidence`);
      planted++;
      if (c.misread) misreads.push(`${shape}/${mode}: ${c.misread}`);
    }
    if (misreads.length > 0) out.push({ fact, key: misreadKey, node, source: "planted failed lookup through the ias typed seam", copy: `node ${node}`, detail: `planted failed lookup misread on node ${node}: ${misreads.join("; ").slice(0, 600)}`.replace(new RegExp(re.source, "g"), "[matches the row pattern]"), canary: false });
    if (canary && typeof row.must_fail_line === "string" && re.test(row.must_fail_line) && planted > 0) {
      out.push({ fact, key: `${row.id}-canary`, node, source: `journal:${unit}@${node}`, copy: `last ${hours}h`, detail: "must-fail control: the pattern matches its own must_fail_line and the planted lookups ran", canary: true });
    }
    return { fact, source_read: true, copies_read: 1, divergences: out, note: `node ${node}: ${n} matching line(s) over ${hours}h; ${planted} planted failed lookup(s), ${misreads.length} misread` };
  },
  /**
   * Discovery lookups must converge on the typed ias seam: the count of lookup sites (`site_pattern`, git grep -E)
   * at origin/dev in every push clone (minus exclude_repos) and in the super-repo (super_repo_pathspecs), minus the
   * seam's own files, must not exceed the row's `max`. `max` is the ratchet: lowered by a data commit as sites
   * migrate, never raised. A count above it is a filed finding (a new or restored copy). A count above zero is also
   * reported under key `sites-remaining` but never filed: it is the done-condition a standing gap's predicate reads.
   * Must-fail control: a scratch repo with one planted site (and a test file and a .js twin that must not count) is
   * counted by the same function with the same pattern and pathspecs; the canary is reported only if that count is 1.
   * A repo whose ref git cannot read makes the row unobserved (an undercount must not read as progress).
   */
  typed_seam_sites: (canary, row) => {
    const fact = row.id;
    const sitePattern = String(row.site_pattern ?? "");
    const pathspecs = Array.isArray(row.pathspecs) && row.pathspecs.length > 0 ? row.pathspecs : ["src"];
    const superSpecs = Array.isArray(row.super_repo_pathspecs) ? row.super_repo_pathspecs : [];
    const excludeRepos = Array.isArray(row.exclude_repos) ? row.exclude_repos : [];
    const seam = Array.isArray(row.seam_files) ? row.seam_files : [];
    const max = typeof row.max === "number" && row.max >= 0 ? row.max : NaN;
    const maxAge = typeof row.max_ref_age_hours === "number" && row.max_ref_age_hours > 0 ? row.max_ref_age_hours : 6;
    const out: SelfFactDivergence[] = [];
    const unread = (note: string): SelfFactResult => ({ fact, source_read: false, copies_read: 0, divergences: [], note });
    if (!sitePattern || !Number.isFinite(max)) return unread(`row ${row.id}: site_pattern or max missing`);
    let repos: string[];
    try { repos = readdirSync(cloneRoot()).filter((r) => !r.includes("-mitosis-") && !excludeRepos.includes(r) && existsSync(join(cloneRoot(), r, ".git"))).sort(); } catch (err) { return unread(`clone root unreadable: ${String(err).slice(0, 100)}`); }
    const sites: string[] = [];
    const refs: string[] = [];
    const failed: string[] = [];
    const stale: string[] = [];
    const tally = (label: string, dir: string, specs: string[]) => {
      // A stale ref undercounts (sites landed since the last fetch are invisible), so it is unobserved, never progress.
      const age = refAgeHours(dir);
      if (age === null || age > maxAge) { stale.push(`${label} (${age === null ? "never fetched" : `${age.toFixed(1)}h`})`); return; }
      const seamHere = seam.filter((s) => s.startsWith(label + ":")).map((s) => s.slice(label.length + 1));
      const r = countSites(dir, "origin/dev", sitePattern, specs, seamHere);
      if (!r) { failed.push(label); return; }
      refs.push(`${label}@${(git(["rev-parse", "--short", "origin/dev"], dir) ?? "?")}`);
      for (const s of r.sites) sites.push(`${label}:${s}`);
    };
    for (const r of repos) tally(r, join(cloneRoot(), r), pathspecs);
    if (superSpecs.length > 0) tally("super-repo", superRepoRoot(), superSpecs);
    if (stale.length > 0) return unread(`origin/dev older than ${maxAge}h in ${stale.join(", ")}; a stale ref undercounts, so this run is not evidence`);
    if (failed.length > 0) return unread(`git could not count sites in ${failed.join(", ")}; an undercount is not progress`);
    const count = sites.length;
    if (count > max) out.push({ fact, key: "over-ceiling", source: `git grep origin/dev (${refs.length} repos)`, copy: `ceiling ${max}`, detail: `${count} discovery lookup site(s) outside the typed ias seam, above the ceiling ${max}: a copy was added or restored. Sites: ${sites.join(" ").slice(0, 900)}`, canary: false });
    if (count > 0) out.push({ fact, key: "sites-remaining", source: `git grep origin/dev (${refs.length} repos)`, copy: "done at 0", detail: `${count} discovery lookup site(s) remain outside the typed ias seam`, canary: false, file: false });
    if (canary) {
      const planted = scratchSiteCount(sitePattern, pathspecs);
      if (planted === 1) out.push({ fact, key: `${row.id}-canary`, source: "scratch repo with one planted site", copy: "count 1", detail: "must-fail control: the planted site raised the count by exactly one", canary: true });
    }
    return { fact, source_read: true, copies_read: refs.length, divergences: out, note: `${count} site(s), ceiling ${max}${count < max ? ` (the ceiling can be lowered to ${count})` : ""}; refs ${refs.join(" ")}` };
  },
  /** The inventory the deploy step reads must equal the inventory the fleet is built from. */
  fleet_inventory_copy: (canary) => {
    const src = readInventory(sourceInventoryPath());
    const cpPath = deployInventoryPath();
    const cp = readInventory(cpPath);
    const out: SelfFactDivergence[] = [];
    if (!src) return { fact: "fleet_inventory_copy", source_read: false, copies_read: cp ? 1 : 0, divergences: out, note: `source unreadable: ${sourceInventoryPath()}` };
    const s = serviceRepos(src);
    const c = cp ? serviceRepos(cp) : [];
    if (canary) c.push(CANARY_REPO);
    if (!cp) out.push({ fact: "fleet_inventory_copy", key: "copy-missing", source: sourceInventoryPath(), copy: cpPath, detail: "deploy-side inventory copy is absent", canary: false });
    for (const r of s) if (!c.includes(r)) out.push({ fact: "fleet_inventory_copy", key: r, source: sourceInventoryPath(), copy: cpPath, detail: `repo ${r} is in the source inventory but not in the deploy-side copy`, canary: false });
    for (const r of c) if (!s.includes(r)) out.push({ fact: "fleet_inventory_copy", key: r, source: sourceInventoryPath(), copy: cpPath, detail: `repo ${r} is in the deploy-side copy but not in the source inventory`, canary: r === CANARY_REPO });
    return { fact: "fleet_inventory_copy", source_read: true, copies_read: cp ? 1 : 0, divergences: out, note: `${s.length} source repos vs ${c.length} copy repos` };
  },
  /** Every service vessel in the inventory must have both authoring roots. */
  authoring_root: (canary) => {
    const src = readInventory(sourceInventoryPath());
    const out: SelfFactDivergence[] = [];
    if (!src) return { fact: "authoring_root", source_read: false, copies_read: 0, divergences: out, note: "source inventory unreadable" };
    const repos = serviceRepos(src);
    if (canary) repos.push(CANARY_REPO);
    let copies = 0;
    for (const r of repos) {
      const live = join(runtimeRoot(), r, "src");
      const clone = join(cloneRoot(), r, ".git");
      copies += 2;
      const isCanary = r === CANARY_REPO;
      if (!existsSync(live)) out.push({ fact: "authoring_root", key: `${r}:live`, source: sourceInventoryPath(), copy: live, detail: `no live authoring tree for ${r}`, canary: isCanary });
      if (!existsSync(clone)) out.push({ fact: "authoring_root", key: `${r}:clone`, source: sourceInventoryPath(), copy: clone, detail: `no push clone for ${r}`, canary: isCanary });
    }
    return { fact: "authoring_root", source_read: true, copies_read: copies, divergences: out, note: `${repos.length} service repos checked` };
  },
  /** A manifest vessel's running checkout must not lag the super-repo it was cut from. */
  manifest_checkout_lag: (canary) => {
    const src = readInventory(sourceInventoryPath());
    const out: SelfFactDivergence[] = [];
    if (!src) return { fact: "manifest_checkout_lag", source_read: false, copies_read: 0, divergences: out, note: "source inventory unreadable" };
    const head = git(["rev-parse", "HEAD"], superRepoRoot());
    let copies = 0;
    for (const row of src.filter((r) => r.manifest === true && typeof r.unit === "string")) {
      const wd = unitWorkingDirectory(row.unit as string);
      if (!wd) continue;
      const top = git(["rev-parse", "--show-toplevel"], wd);
      if (!top) continue;
      copies += 1;
      const behind = head ? git(["rev-list", "--count", `HEAD..${head}`], top) : null;
      const n = behind ? Number(behind) : NaN;
      if (Number.isFinite(n) && n > 0) out.push({ fact: "manifest_checkout_lag", key: String(row.unit), source: `${superRepoRoot()}@${(head ?? "").slice(0, 8)}`, copy: `${top}@${(git(["rev-parse", "HEAD"], top) ?? "").slice(0, 8)}`, detail: `running checkout is ${n} commit(s) behind the super-repo`, canary: false });
    }
    if (canary) out.push({ fact: "manifest_checkout_lag", key: CANARY_REPO, source: superRepoRoot(), copy: "/nonexistent/canary-checkout", detail: "planted", canary: true });
    return { fact: "manifest_checkout_lag", source_read: head !== null, copies_read: copies, divergences: out, note: head ? `super-repo HEAD ${head.slice(0, 8)}` : "super-repo HEAD unreadable" };
  },
  /** Every directory of TypeScript sources in a vessel must be inside its typecheck's include set. */
  lane_coverage: (canary) => {
    const out: SelfFactDivergence[] = [];
    let copies = 0;
    let vessels = 0;
    try {
      for (const v of readdirSync(runtimeRoot())) {
        if (v.includes("-mitosis-") || v === "packages") continue;
        const root = join(runtimeRoot(), v);
        // The SOURCE of a vessel's typecheck scope is its committed tsconfig in the push
        // clone; /vessels is a runtime copy that an unlanded edit can drift (measured
        // 2026-09-23 04:00: the live human-surface tsconfig gained "ui/src" with no
        // commit, and this fact closed its gap on the copy). Read the clone when it
        // exists; fall back to the runtime copy and say so in the divergence.
        const cloneTsconfig = join(cloneRoot(), v, "tsconfig.json");
        const tsconfig = existsSync(cloneTsconfig) ? cloneTsconfig : join(root, "tsconfig.json");
        if (!existsSync(tsconfig)) continue;
        vessels += 1;
        let include: string[] = [];
        try { include = ((JSON.parse(readFileSync(tsconfig, "utf8")) as { include?: string[] }).include ?? []); } catch { continue; }
        const covered = (dir: string) => include.some((g) => g === dir || g.startsWith(dir + "/") || g.startsWith(dir + "/**"));
        const candidates = ["src", "ui/src", "app/src", "web/src"];
        if (canary) candidates.push(CANARY_REPO);
        for (const dir of candidates) {
          const isCanary = dir === CANARY_REPO;
          const has = isCanary ? true : hasTsSources(join(root, dir));
          if (!has) continue;
          copies += 1;
          if (!covered(dir)) out.push({ fact: "lane_coverage", key: `${v}:${dir}`, source: join(root, dir), copy: tsconfig, detail: `${dir} holds TypeScript sources that the vessel-root typecheck does not include`, canary: isCanary });
        }
      }
    } catch (err) {
      return { fact: "lane_coverage", source_read: false, copies_read: copies, divergences: out, note: `runtime root unreadable: ${(err as Error).message.slice(0, 80)}` };
    }
    return { fact: "lane_coverage", source_read: true, copies_read: copies, divergences: out, note: `${vessels} vessel(s) with a tsconfig` };
  },
};

// ─── gap filing ─────────────────────────────────────────────────────────────
// Edit sites come from the rows read on this run (set by the resolver before filing).
let rowEditSite: Record<string, string> = {};
let rowLinkedGap: Record<string, string> = {};
function gapId(d: SelfFactDivergence): string {
  return `self-fact-divergence-${d.fact}-${d.key}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 140);
}
async function fileDivergence(d: SelfFactDivergence): Promise<boolean> {
  const res = await resolveSubstrateGapWrite({
    type: "substrateGap_write",
    gap: {
      id: gapId(d),
      category: "self_knowledge",
      source: "substrate_detected",
      status: "open",
      summary: `self_fact_reconcile found the fact "${d.fact}" diverged at "${d.key}": ${d.detail}. Source: ${d.source}. Copy: ${d.copy}. A copy the system reads about itself no longer matches the thing it copies; the system acted on the copy. Reconcile the copy to its source (or the source to the world), through the lane; this gap closes only when self_fact_reconcile re-reads both and finds no divergence for this fact.${rowLinkedGap[d.fact] ? ` Part of the standing gap ${rowLinkedGap[d.fact]}.` : ""}${d.node ? ` Judged only on node ${d.node}.` : ""}`,
      classification_metadata: {
        edit_site: rowEditSite[d.fact] ?? "repos/development-vessel/src/resolvers/self-fact-reconcile.ts",
        detector: SELF_FACT_RECONCILE_ID,
        fact: d.fact,
        divergence_key: d.key,
        ...(d.node ? { node: d.node } : {}),
        ...(rowLinkedGap[d.fact] ? { linked_gap_id: rowLinkedGap[d.fact] } : {}),
        // Class-2, self-verifying: the sweep re-runs THIS resolver for THIS fact and
        // reads divergence_count; >0 = still present, 0 = resolved. That is a DEFECT count, so it is
        // zero_field — nonzero_field is the sweep's HEALTH form and read divergence_count=1 as resolved.
        evidence_resolve: { shape: "self_fact_reconcile", input: { facts: [d.fact], key: d.key, plant_canary: false, file_gaps: false, ...(d.node ? { node: d.node } : {}) }, zero_field: "divergence_count" },
        falsifier: `class 2: self_fact_reconcile with facts=[${d.fact}] key=${d.key} reports divergence_count 0`,
      },
    },
  });
  return res.shape !== "structuredError";
}

/**
 * Close every open gap this detector filed for one of the checked facts whose
 * divergence is absent from this run. Read the store by `detector`, compare by
 * stable id, write status closed with an exercised falsifier (passed, by whom,
 * when, divergence_count 0). Idempotent: a closed row is not re-closed.
 */
async function closeResolved(facts: readonly string[], present: readonly SelfFactDivergence[]): Promise<number> {
  const presentIds = new Set(present.map(gapId));
  let closed = 0;
  let rows: Array<Record<string, unknown>> = [];
  try {
    const read = await resolveSubstrateGap({ type: "substrateGap", status: "open", limit: 5000, include_held: true } as never);
    rows = (((read as { body?: { gaps?: unknown } }).body?.gaps ?? []) as Array<Record<string, unknown>>);
  } catch (err) {
    noteReadError("gap store read for closure", err);
    return 0;
  }
  for (const row of rows) {
    const meta = (row["classification_metadata"] ?? {}) as Record<string, unknown>;
    if (meta["detector"] !== SELF_FACT_RECONCILE_ID) continue;
    const fact = typeof meta["fact"] === "string" ? meta["fact"] : "";
    if (!facts.includes(fact)) continue;
    // A per-node finding is judged only on its node: another node's clean read says nothing about it.
    if (typeof meta["node"] === "string" && meta["node"] !== thisNode()) continue;
    const id = typeof row["id"] === "string" ? row["id"] : "";
    if (!id || presentIds.has(id)) continue;
    // Only rows THIS detector filed: the id must be exactly what gapId() builds for
    // the row's own (fact, key). The compose picker mints "-narrowed" clones that
    // copy classification_metadata (detector, fact, key) verbatim; measured
    // 2026-09-23 03:35 and 04:00, two such clones were closed here as "resolved"
    // while their parent divergence was still present. Not ours; not closed here.
    const key = typeof meta["divergence_key"] === "string" ? meta["divergence_key"] : "";
    if (id !== gapId({ fact, key, source: "", copy: "", detail: "", canary: false })) continue;
    const ranAt = new Date().toISOString();
    const res = await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        ...row,
        status: "closed",
        summary: `${String(row["summary"] ?? "")} RESOLVED: self_fact_reconcile re-read source and copy at ${ranAt} and found no divergence for this key.`,
        classification_metadata: {
          ...meta,
          falsifier_exercise: { passed: true, detector: SELF_FACT_RECONCILE_ID, ran_at: ranAt, divergence_count: 0 },
          closed_reason: "predicate_verified_by_detector",
          close_basis: "self_fact_reconcile",
        },
      },
    });
    if (res.shape !== "structuredError") closed += 1;
  }
  return closed;
}

// ─── per-tick journal lines ─────────────────────────────────────────────────
/** One line per row per run, so "no divergences on this node" is told apart from "never ran here". A row is
 *  diverged when it holds a finding that would be filed, unobserved when it could not be read or missed its canary,
 *  observed otherwise; rows outside this node's profile say so. Any text a row's own pattern would match is masked,
 *  so a journal-reading row never counts these lines. */
export function selfFactRowLines(
  results: readonly SelfFactResult[],
  blindRows: readonly string[],
  skipped: ReadonlyArray<{ id: string }>,
  unregistered: readonly string[],
  profile: string,
  patterns: readonly string[] = [],
): string[] {
  const masks = patterns.flatMap((p) => { try { return [new RegExp(p, "g")]; } catch { return []; } });
  const mask = (t: string) => masks.reduce((acc, re) => acc.replace(re, "[row pattern]"), t.replace(/\s+/g, " ").slice(0, 160));
  const lines: string[] = [];
  for (const r of results) {
    const filable = r.divergences.filter((d) => !d.canary && d.file !== false);
    if (!r.source_read) lines.push(`[self-fact] row ${r.fact}: unobserved (${mask(r.note)})`);
    else if (blindRows.includes(r.fact)) lines.push(`[self-fact] row ${r.fact}: unobserved (must-fail control not reported)`);
    else if (filable.length > 0) lines.push(`[self-fact] row ${r.fact}: diverged (${filable.length} finding(s): ${mask(filable.slice(0, 3).map((d) => d.key).join(", "))})`);
    else lines.push(`[self-fact] row ${r.fact}: observed (${mask(r.note)})`);
  }
  for (const id of unregistered) lines.push(`[self-fact] row ${id}: unobserved (no such instrument on this vessel)`);
  for (const r of skipped) lines.push(`[self-fact] row ${r.id}: skipped (profile ${profile})`);
  return lines;
}

// ─── the resolver ───────────────────────────────────────────────────────────
export async function resolveSelfFactReconcile(pointer: SelfFactReconcilePointer): Promise<ResolverResult> {
  const plant = pointer.plant_canary !== false;
  const file = pointer.file_gaps !== false;
  const ranAt = new Date().toISOString();
  readErrors.length = 0;
  const rows = readRows();
  const profile = nodeProfile();
  // Only rows scoped to this node's profile run here: a node judges only copies it
  // holds, so a node that does not hold them cannot read clean and close another
  // node's finding. An unknown instrument is reported, never run.
  const profileOk = (r: SelfFactRow) => r.profiles.includes(profile) || r.profiles.includes("*");
  const nodeListed = (r: SelfFactRow) => !Array.isArray(r.nodes) || r.nodes.includes(thisNode());
  // A trust-root pin row that does not list this node still runs here when this node HOLDS the pinned shape with
  // no value pinned for it: that trust root is unguarded, and the instrument reports it (`<node>-unpinned`). A node
  // holding no such record skips the row as before, so another substrate's rows never turn this run unobserved.
  const unpinnedHolders = new Set<SelfFactRow>();
  for (const r of rows ?? []) {
    if (!profileOk(r) || nodeListed(r) || r.instrument !== "pool_record_pin" || typeof r.pool_shape !== "string" || r.pool_shape.length === 0) continue;
    if (r.expected_by_node && Object.prototype.hasOwnProperty.call(r.expected_by_node, thisNode())) continue;
    try { if (await poolPinDeps.readNewest(r.pool_shape)) unpinnedHolders.add(r); } catch { unpinnedHolders.add(r); /* the instrument reports the store unreadable */ }
  }
  const inScope = (rows ?? []).filter((r) => profileOk(r) && (nodeListed(r) || unpinnedHolders.has(r)));
  const unregistered = inScope.filter((r) => !(r.instrument in FACTS)).map((r) => r.id);
  const runnable = inScope.filter((r) => r.instrument in FACTS);
  // A per-node predicate asked of another node checks nothing here: no rows run, the run is unobserved (null).
  const foreignNode = typeof pointer.node === "string" && pointer.node.length > 0 && pointer.node !== thisNode();
  const wanted = foreignNode ? [] : (Array.isArray(pointer.facts) && pointer.facts.length > 0 ? runnable.filter((r) => pointer.facts!.includes(r.id)) : runnable).map((r) => r.id);
  // Keyed by instrument and by row id (journal_pattern reports under its row id), so rows sharing an instrument
  // keep their own edit sites.
  rowEditSite = Object.fromEntries(runnable.flatMap((r) => [[r.instrument, r.edit_site], [r.id, r.edit_site]]));
  rowLinkedGap = Object.fromEntries(runnable.filter((r) => typeof r.linked_gap === "string" && r.linked_gap.length > 0).map((r) => [r.id, r.linked_gap as string]));
  // EVERY row runs its must-fail control (the canary) on every planted run, so one
  // blind instrument cannot hide behind another row's canary.
  const results: SelfFactResult[] = [];
  for (const id of wanted) { const row = runnable.find((r) => r.id === id)!; results.push(await FACTS[row.instrument]!(plant, row)); }
  const all = results.flatMap((r) => r.divergences);
  // A row that could not be READ is unobserved, not blind and not healthy (qa 09-29): it must neither disable the
  // other rows (it used to trip the canary-not-found self-gap for the whole run) nor let its own findings close.
  const unobservedRows = results.filter((r) => !r.source_read).map((r) => r.fact);
  const readFacts = new Set(results.filter((r) => r.source_read).map((r) => r.fact));
  const blindRows = plant ? results.filter((r) => r.source_read && !r.divergences.some((d) => d.canary)).map((r) => r.fact) : [];
  const canaryFound = rows !== null && blindRows.length === 0;
  {
    // One journal line per row per run (qa 09-30). A predicate asked of another node runs no rows and says so.
    const askedFor = (id: string) => !Array.isArray(pointer.facts) || pointer.facts.length === 0 || pointer.facts.includes(id);
    const skippedByProfile = (rows ?? []).filter((r) => !inScope.includes(r) && askedFor(r.id));
    const patterns = (rows ?? []).map((r) => (typeof r.pattern === "string" ? r.pattern : "")).filter((p) => p.length > 0);
    if (rows === null) console.log(`[self-fact] rows unreadable on node ${thisNode()}: no row ran`);
    else if (foreignNode) console.log(`[self-fact] predicate for node ${pointer.node}: not judged on node ${thisNode()}`);
    for (const line of selfFactRowLines(results, blindRows, skippedByProfile, unregistered.filter(askedFor), profile, patterns)) console.log(line);
  }
  const canaryFact = blindRows.join(", ");
  // Key scoping: a per-gap predicate asks about ONE (fact, key); everything else is
  // not this gap's business, so it must not keep the gap open.
  const keyed = typeof pointer.key === "string" && pointer.key.length > 0 && wanted.length === 1;
  const real = all.filter((d) => !d.canary && (!keyed || d.key === pointer.key));
  // Zero rows checked is not an observation: a node with nothing in scope says so.
  const observed = results.length > 0 && results.every((r) => r.source_read) && canaryFound;
  let filed = 0;
  let closed = 0;
  let selfGap = false;
  if (plant && rows === null) {
    // No rows, no instruments ran: say so about ITSELF; there is no built-in fallback.
    await fileDivergence({ fact: "self_fact_reconcile", key: "rows-unreadable", source: `origin/dev:${ROWS_PATH}`, copy: superRepoRoot(), detail: `the self-fact rows could not be read from git (${readErrors[readErrors.length - 1] ?? "unknown"}) — no row ran, so this run is not evidence`, canary: false });
    selfGap = true;
  } else if (plant && !canaryFound) {
    // The instrument cannot see: say so about ITSELF and file nothing else.
    await fileDivergence({ fact: "self_fact_reconcile", key: "canary-not-found", source: "planted canary", copy: "this run", detail: `the planted canary on fact ${canaryFact} was not reported — clean results from this instrument are not evidence until this is fixed`, canary: false });
    selfGap = true;
  } else if (file) {
    for (const d of real) if (d.file !== false && (await fileDivergence(d))) filed += 1;
    // CLOSURE BY THE INSTRUMENT THAT FOUND IT. Every open gap this detector filed
    // for a fact checked on this run, whose divergence is no longer present, is
    // closed here with an EXERCISED falsifier — the only thing the store's gate
    // accepts for a held or class-2 gap. A landing never closes these; this does.
    closed = await closeResolved(wanted.filter((id) => readFacts.has(id)), real);
  }
  // Findings in the form light-dispatch grades (it counts `findings`/`gaps_emitted`,
  // not `divergences`): one per real divergence, with a stable hash so a repeat run
  // that finds the same divergences is "productive-but-redundant", not "idle".
  const findings = real.map((d) => ({ hash: createHash("sha1").update(`${d.fact}:${d.key}`).digest("hex").slice(0, 16), fact: d.fact, key: d.key, detail: d.detail }));
  return {
    shape: "selfFactReconcileReport",
    body: {
      detector: SELF_FACT_RECONCILE_ID,
      ran_at: ranAt,
      facts_checked: results.map((r) => ({ fact: r.fact, source_read: r.source_read, copies_read: r.copies_read, divergences: r.divergences.filter((d) => !d.canary).length, note: r.note })),
      // A run that checked no rows, could not read its sources, or missed a canary is NOT a
      // measurement: report null so the sweep's zero_field reader reads unknown and never
      // closes a gap on it (qa review 2026-09-29: an empty run returned 0 and would close).
      divergence_count: observed ? real.length : null,
      divergences: real,
      findings,
      findings_count: findings.length,
      finding_hashes: findings.map((f) => f.hash),
      gaps_emitted: filed,
      gaps_closed: closed,
      canary_planted: plant,
      canary_found: canaryFound,
      profile,
      node: thisNode(),
      rows_checked: wanted,
      blind_rows: blindRows,
      unobserved_rows: unobservedRows,
      unregistered_rows: unregistered,
      observed,
      gaps_filed: filed,
      self_gap_filed: selfGap,
      read_errors: [...readErrors],
      claim: observed ? "every source and copy was read at use time and the planted canary was reported; divergences above are measured, not inferred" : "this run could not attribute its own negatives — a source was unreadable or the canary was missed — and its clean results are not evidence",
    },
  };
}

/** One row through its instrument, without filing or closing anything (tests, and a dry read of a proposed row). */
export async function evaluateSelfFactRow(row: SelfFactRow, canary = true): Promise<SelfFactResult | null> {
  const fn = FACTS[row.instrument];
  return fn ? fn(canary, row) : null;
}
