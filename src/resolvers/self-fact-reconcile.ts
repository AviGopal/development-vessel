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
import { resolveSubstrateGap, resolveSubstrateGapWrite, resolveGapWriteEvent, takeBirthVerdict, class2PredicateKey, birthTreeMoved, BIRTH_PENDING_STALE_MS } from "./substrate-gap.js";
import { appendRecord, ledgerDir, readRecords } from "./attempt-ledger.js";
import { intentIsAutonomous, isoMs, lineageAncestors, operatorActsOf, provenanceTraceIds, type GapRow, type GapWriteEventLike, type KeyMapEntry, type LabelClassContext, type OperatorActsContext, type OperatorActsResult, type OracleLabelLike, type ScopeAct, type SiteCommit, type DispatchStoreEntry, type ResolverDispatchLike, type ResolverRequestLike, type ResolverAnswerLike } from "./operator-acts.js";
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
  /** Per-item judgements (repair_autonomy, lane_revert_within_1h): body.judgements.<fact>[]. */
  readonly judgements?: readonly unknown[];
  /** checked / expected, expected counted from the landing ledger (R1-18). */
  readonly aggregate?: Record<string, unknown>;
  /** The must-fail controls' own judgements (fixture items, judged by the same function). */
  readonly controls?: readonly unknown[];
  /** The row's trend over its persisted aggregates (aggregateTrend): body.trends.<fact>. */
  readonly trend?: AggregateTrend;
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
/** The file's one git read. Default: trimmed stdout, or null with a read error on a non-zero exit. `raw`: the exit code
 *  and untrimmed stdout, never a read error (a caller such as merge-base --is-ancestor reads exit 1 as an answer). */
function git(args: string[], cwd: string): string | null;
function git(args: string[], cwd: string, opts: { raw: true; timeoutMs: number }): { code: number; out: string } | null;
function git(args: string[], cwd: string, opts?: { raw: true; timeoutMs: number }): string | { code: number; out: string } | null {
  try {
    const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", ...(opts ? { timeout: opts.timeoutMs } : {}) });
    if (opts) return { code: p.exitCode ?? -1, out: new TextDecoder().decode(p.stdout) };
    if (p.exitCode !== 0) return noteReadError(`git ${args[0]} in ${cwd}`, new TextDecoder().decode(p.stderr).trim() || `exit ${p.exitCode}`);
    return new TextDecoder().decode(p.stdout).trim();
  } catch (err) {
    if (opts) return null;
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
// THE ROWS COME FROM WHAT THE GATE ACCEPTED, OR NOTHING (2026-10-06). The rows carry the judge's EXPECTED values
// (incl. the trust-root pins), so reading them from an unjudged candidate let any commit on origin/dev change what
// the judge accepts before Gate P decided (compose2 judged a new spend pin "observed" at 02:20:28Z, before its
// promote request at 02:23:45). This vessel cannot read /workspace/.gate (its unit masks it), so pull-sync (root)
// publishes the accepted copy to a dir this vessel can only read, with a marker written last:
//   <dir>/source.json = { schema: 1, gated, source: accepted|image|clone, accepted_sha, self_facts_sha256, … }
// gated + source "accepted" + a 40-hex accepted_sha + the file's sha256 equal to self_facts_sha256 ⇒ that copy;
// gated:false ⇒ origin/dev (an ungated node has no accepted copy; behaviour as before); ANYTHING ELSE ⇒ no rows
// (fail closed: the run reports unjudged and files rows-unreadable naming the reason). A missing marker is never
// read as "ungated": the writer publishes one on every node, so its absence is unknown, not permission.
// A CONSTANT, never an env var: the env is writable by the root shell and the substrate (write-containment.ts),
// so an override would let a restart point the judge at a forged marker. Tests inject the dir through the setter.
export const GATE_PUBLIC_DIR = "/workspace/.gate-public";
let gatePublicDirOverride: string | null = null;
export function __setGatePublicDirForTests(dir: string | null): void { gatePublicDirOverride = dir; }
const gatePublicDir = (): string => gatePublicDirOverride ?? GATE_PUBLIC_DIR;
let rowsSource = `origin/dev:${ROWS_PATH}`;
function readRowsRaw(): string | null {
  const dir = gatePublicDir();
  const markerPath = join(dir, "source.json");
  const closed = (reason: string, err?: unknown): null => {
    rowsSource = markerPath;
    console.warn(`[self-fact-rows] FAIL CLOSED: ${reason}`);
    return noteReadError(`rows source ${markerPath}`, err === undefined ? reason : `${reason}: ${err instanceof Error ? err.message : String(err)}`);
  };
  let text: string;
  try {
    text = readFileSync(markerPath, "utf8");
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    return code === "ENOENT" ? closed("marker absent (no gate-fed source.json)") : closed(`marker unreadable (${code ?? "error"})`, err);
  }
  let m: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return closed("marker unparseable (not an object)");
    m = parsed as Record<string, unknown>;
  } catch (err) {
    return closed("marker unparseable", err);
  }
  if (m["schema"] !== 1) return closed(`marker schema ${String(m["schema"])} is not 1`);
  if (m["gated"] === false) {
    rowsSource = `origin/dev:${ROWS_PATH} (marker: ungated)`;
    console.log(`[self-fact-rows] source: ${rowsSource}`);
    return git(["show", `origin/dev:${ROWS_PATH}`], superRepoRoot());
  }
  if (m["gated"] !== true) return closed("marker gated is neither true nor false");
  if (m["source"] !== "accepted") return closed(`gated copy not accepted (source=${String(m["source"])})`);
  const acceptedSha = m["accepted_sha"];
  if (typeof acceptedSha !== "string" || !/^[0-9a-f]{40}$/.test(acceptedSha)) return closed(`bad accepted_sha (${String(acceptedSha).slice(0, 48)})`);
  const want = m["self_facts_sha256"];
  if (typeof want !== "string" || !/^[0-9a-f]{64}$/.test(want)) return closed("hash absent (no self_facts_sha256)");
  const rowsPath = join(dir, "self-facts.json");
  let bytes: Buffer;
  try {
    bytes = readFileSync(rowsPath);
  } catch (err) {
    return closed("gate-fed self-facts.json unreadable", err);
  }
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== want) return closed(`hash mismatch (self-facts.json ${got.slice(0, 12)} ≠ marker ${want.slice(0, 12)})`);
  rowsSource = `${rowsPath}@accepted ${acceptedSha.slice(0, 12)}`;
  console.log(`[self-fact-rows] source: ${rowsSource}`);
  return bytes.toString("utf8");
}
function readRows(): SelfFactRow[] | null {
  const raw = readRowsRaw();
  if (raw === null) return null;
  try {
    const j = JSON.parse(raw) as { rows?: unknown };
    if (!Array.isArray(j.rows)) return noteReadError(`rows ${rowsSource}`, "no rows[] array");
    const rows = (j.rows as SelfFactRow[]).filter(
      (r) => r && typeof r.id === "string" && typeof r.instrument === "string" && Array.isArray(r.profiles),
    );

    const countsByCause: Record<string, number> = {};
    for (const row of rows) {
      const cause = (row as unknown as Record<string, unknown>).cause;
      if (cause && typeof cause === "string") {
        countsByCause[cause] = (countsByCause[cause] ?? 0) + 1;
      }
    }

    if (Object.keys(countsByCause).length > 0) {
      const generatedAt = new Date().toISOString();
      for (const cause of Object.keys(countsByCause)) {
        rows.push({
          id: `cause-count:${cause}:${generatedAt}`,
          instrument: "self-fact-reconcile:cause-count",
          profiles: ["all"],
          cause,
          count: countsByCause[cause]!,
          edit_site: "",
          must_fail: "",
        } as SelfFactRow);
      }
    }
    return rows;
  } catch (err) {
    return noteReadError(`rows ${rowsSource}`, err);
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
    const { autonomyScope, autonomyScopeExcludes } = await import("../judge/gap-policy.js");
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

// ─── repair_autonomy and lane_revert_within_1h: per-closure judgements ─────
/**
 * TWO §14 ROWS, JUDGED PER ITEM (REALIGNMENT §14 #3 Repair and #6 Safety; USER 2026-10-21T18:15:11Z, qa-accepted link
 * requirements, and qa's 10-22 review: as first built they were lenient in the direction that games §14). Autonomy is
 * measured only by the system's own evaluator rows; these read from the system's own records, one judgement per item,
 * and NOTHING UNKNOWN IS CLEAN: a missing ledger file or spool, a gap-write read that is capped or does not reach back
 * to the filing, an unparsable time, unread oracle labels, an unreadable fix commit, all read unjudged, never counted.
 *
 *   repair_autonomy        one judgement per gap with a lane landing in the LANDING LEDGER (or its undrained spool) in
 *                          the window (expected, R1-18: never from the gap store this instrument reads). counted only when
 *                          link 1 the row's source is substrate_detected (unset or anything else is not autonomous;
 *                                 an operator filing reads "origin: operator-filed"), and no lineage ancestor is
 *                                 operator-filed or human_reported (followed to the root, the same reading);
 *                          link 2 the own check is honest;
 *                          link 3 the attempt is registered autonomous (directed === false EXACTLY, the auto-revert's
 *                                 rule) and its fix commit is the lane's, touches the edit_site, is in the edit site's
 *                                 repo and is reachable from origin/dev there;
 *                          link 4 the landing verdict is landed_verified on the measured check with the fix's sha, no
 *                                 dissent and no post-restart falsification;
 *                          link 5 no operator act from FILING to close + 24 h (operatorActsOf, the one reader), with the
 *                                 events, labels and history it needs all readable;
 *                          link 6 24 h with no reopen and no revert (before that PENDING).
 *                          Every not_counted names its failing link: link1 | link2 | link3 | link4 | link6 |
 *                          operator_act:<addendum>.
 *   lane_revert_within_1h  one judgement per REGRESSED settlement in the ledger in the window, PLUS every settlement whose
 *                          red divergence is still open (carried past the window): green only for a lane revert
 *                          (`Auto-Revert: true`) that names the regressed sha, landed within 1 h and is OBSERVED on
 *                          origin/dev. Anything else stays red; a settlement that ages out of the window unreverted reads
 *                          "expired unreverted" and stays red, so its gap closes only on an observed revert.
 *
 * checked == expected is the row's exit: checked counts the items that met the row (counted / green), expected counts the
 * items in the ledger. Each run's aggregate is APPENDED to the ledger as a selfFactAggregate record (per row, per run,
 * keyed `<row>@<node>@<ran_at>@<planted|recheck>`), so a count rising over days is computable from the system's own
 * store (attemptLedger kind selfFactAggregate), and each run reads that series back (aggregateTrend: rising, flat,
 * falling or insufficient_data over 7 days; a falling share files a divergence). Each judgement is one `[self-fact-judgement] {json}` journal line, and the must-fail controls are judged by the SAME functions every
 * planted run; only then is the row's canary reported.
 *
 * NAMED LIMITS (said in the judgements): the key class map is identity's apiKeyClass (readKeyClassMap), and an
 * unclassified, ambiguous or unlisted key reads unattributable; the label rule's fixLiveAt is not served, so a closure
 * with a label on any provenance trace reads REVIEW (unjudged); a write forwarded by a
 * peer is decided only by the forwarding node's own events, which this node does not read; the expected-value-not-
 * derivable subclass of link 2 has no reader here; a scope act is dated by its super-repo commit, earlier than any apply.
 */
export type RepairVerdict = "counted" | "not_counted" | "pending" | "unjudged";
export interface RepairLanding { attempt_id: string; gap_id: string; sha: string; repo: string; at: string | null; directed: unknown; authoring_execution_id: string | null; from: "ledger" | "spool" }
export interface CheckHonest { value: true | false | "unjudged"; reason: string }
/** The fix commit as its clone reads it. on_origin_dev null: the reachability could not be read. */
export interface FixCommit { author: string; at: string; files: string[]; on_origin_dev: boolean | null }
export interface RepairJudgement {
  fact: "repair_autonomy"; gap_id: string; verdict: RepairVerdict; reason: string; failing_link?: string; failing_links: string[];
  arm_writer: string; operator_acts: OperatorActsResult | null; fix_sha: string; fix_repo: string; attempt_id: string;
  check: string | null; check_honest: CheckHonest; landing_verdict: Record<string, unknown>; durable_until: string | null; route_unverifiable: number;
  window: { from: string | null; until: string | null };
}
export interface RepairInputs {
  landing: RepairLanding;
  row: GapRow | null;
  byId: ReadonlyMap<string, GapRow>;
  /** The newest regressed settlement of this landing's attempt (the post-restart falsifier's #2, or #1), if any. */
  regressed: { key: string; source: string; at: string } | null;
  /** Commits on origin/dev that say they revert the fix sha. null: unreadable. */
  reverts: Array<{ sha: string; at: string }> | null;
  /** The fix commit in the edit site's clone. null: unreadable (or the clone is not there). */
  fix: FixCommit | null;
  /** The check file's and the edit site's sources AT THE FIX (never HEAD). null: unreadable. */
  checkSource: string | null; siteSource: string | null;
  acts: Omit<OperatorActsContext, "byId" | "filedAt" | "untilAt" | "editSitePath" | "checkPath" | "directed" | "traceIds">;
  /** Set by the live reader when the lane landing's authoring execution is known nowhere (its attemptIntent nor
   *  attemptAuthoring): the labels on it cannot be read, so the closure is unattributable. Absent: not asked. */
  authoringUnknown?: boolean;
  nowMs: number;
}
const EXCLUDED_CLOSE_RE = /expired|not_redetected|producer_now_exists|duplicate|superseded|stale_low_value|persistent_compose_failure/;
const DURABLE_MS = 24 * 3600_000;
const LANE_AUTHOR = "Substrate Autonomous";
const splitSite = (site: string): { vessel: string; path: string } | null => { const m = /^repos\/([^/]+)\/(.+?)(?::\d+.*)?$/.exec(site.trim()); return m ? { vessel: m[1]!, path: m[2]! } : null; };
const metaRec = (r: GapRow | null): Record<string, unknown> => { const m = r?.["classification_metadata"]; return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {}; };
/** The row's own check file: check_supply.test_file, or (recommit rows) evidence_resolve.input.test_file. */
export function ownCheckFile(row: GapRow | null): string | null {
  const m = metaRec(row);
  const cs = m["check_supply"] as { test_file?: unknown } | undefined;
  if (cs && typeof cs.test_file === "string" && cs.test_file) return cs.test_file;
  const er = m["evidence_resolve"] as { input?: { test_file?: unknown } } | undefined;
  return er && er.input && typeof er.input.test_file === "string" && er.input.test_file ? er.input.test_file : null;
}
/** Link 2: is the own check honest? false on a recorded defect, unjudged when a proxy says review or a source is unread. */
export function judgeCheckHonest(row: GapRow, checkSource: string | null, siteSource: string | null): CheckHonest {
  const m = metaRec(row);
  const cs = (m["check_supply"] ?? {}) as { state?: unknown; reason?: unknown };
  const check = ownCheckFile(row);
  const site = splitSite(String(m["edit_site"] ?? ""));
  if (!check) return { value: false, reason: "no own check on the row (check_supply.test_file / evidence_resolve.input.test_file)" };
  if (site && site.path.split("/").pop() === check.split("/").pop()) return { value: false, reason: "the edit_site is the check file itself" };
  if (cs.state === "arm_refused") return { value: false, reason: `check_supply.state arm_refused (${String(cs.reason ?? "").slice(0, 120)})` };
  if (/check_asserts_contract_mismatch/.test(String(cs.reason ?? "")) || /check_asserts_contract_mismatch/.test(String(m["check_refusal"] ?? ""))) return { value: false, reason: "the check asserts a contract its target never returns (contractMismatchRefusal)" };
  const birth = m["predicate_birth_verdict"];
  if (birth !== "present") return { value: false, reason: `the check's birth verdict is ${birth === undefined ? "absent" : JSON.stringify(birth)}, not present` };
  if (checkSource === null || siteSource === null || !site) return { value: "unjudged", reason: "the check or edit-site source AT THE FIX is unreadable, so the hollow-check proxies were not read" };
  const mod = site.path.split("/").pop()!.replace(/\.tsx?$/, "");
  const proxies: string[] = [];
  if (!checkSource.includes(mod)) proxies.push("the check does not import the edit_site module");
  if (new RegExp(`mock\\.module\\([^)]*${mod.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(checkSource)) proxies.push("the check mocks the module it asserts on");
  const lits = [...checkSource.matchAll(/to(?:Be|Equal|Contain)\(\s*['"]([A-Za-z_][\w:-]{3,})['"]/g)].map((x) => x[1]!);
  const missing = [...new Set(lits)].filter((x) => !siteSource.includes(x));
  if (missing.length > 0) proxies.push(`asserted literals absent from the edit_site: ${missing.slice(0, 4).join(", ")}`);
  if (proxies.length > 0) return { value: "unjudged", reason: `review: ${proxies.join("; ")}` };
  return { value: true, reason: "check present at birth, not refused, imports its edit_site, asserts literals the edit_site holds; the expected-value-not-derivable subclass has no reader here (named limit)" };
}
type LinkState = { state: "pass" | "fail" | "pending" | "review"; why: string };
/** One closure, judged. Pure: every input is passed in. */
export function judgeRepairClosure(inp: RepairInputs): RepairJudgement {
  const { landing, row } = inp;
  const base = { fact: "repair_autonomy" as const, gap_id: landing.gap_id, fix_sha: landing.sha, fix_repo: landing.repo, attempt_id: landing.attempt_id };
  if (!row) {
    return { ...base, verdict: "unjudged", reason: "the ledger landing's gap row is not in the store", failing_links: [], arm_writer: "unread", operator_acts: null, check: null, check_honest: { value: "unjudged", reason: "no row" }, landing_verdict: {}, durable_until: null, route_unverifiable: 0, window: { from: null, until: null } };
  }
  const m = metaRec(row);
  const site = splitSite(String(m["edit_site"] ?? ""));
  const check = ownCheckFile(row);
  const closed = String(row["status"] ?? "") === "closed";
  // Never updated_at: a later write would move the durability clock.
  const closedAt = String(row["closed_at"] ?? m["closed_at"] ?? "") || null;
  const closedMs = closed ? isoMs(closedAt) : null;
  const landedMs = isoMs(landing.at);
  const filedAt = String(row["first_detected_at"] ?? row["created_at"] ?? row["detected_at"] ?? "") || null;
  // LINK 5's window: FILING to close + 24 h; an open closure is read up to now.
  const untilAt = closed ? (closedMs === null ? null : new Date(closedMs + DURABLE_MS).toISOString()) : new Date(inp.nowMs).toISOString();
  const traceIds = landing.authoring_execution_id ? [landing.authoring_execution_id] : [];
  const acts = operatorActsOf(row, { ...inp.acts, byId: inp.byId, filedAt, untilAt, editSitePath: site?.path ?? null, checkPath: check, directed: landing.directed, traceIds });
  const unknown = [...acts.unread];
  if (landedMs === null) unknown.push("the landing's time (unparsable)");
  if (closed && closedMs === null) unknown.push("the close time (closed with no closed_at)");
  const armWriter = acts.arm_writes.length > 0 ? acts.arm_writes.map((a) => `${a.writer} @ ${a.at ?? "?"}`).join("; ") : (inp.acts.events === null ? "unread (gap-write events unreadable)" : "no arm write in the events read");
  // link 1: origin. FOLLOWED TO THE ROOT (USER RULING 2026-10-22, "Follow lineage to the root"): a recommit or narrowed
  // child is written by the lane as substrate_detected, so an operator-filed or human_reported lineage ancestor (the
  // explicit links, transitively, and the id rule) is the closure's origin, and link 1 fails on it.
  const src = String(row["source"] ?? "");
  const filerOf = (r: GapRow | undefined): string | null => {
    const s0 = String(r?.["source"] ?? "");
    const fb = String(metaRec(r ?? null)["filed_by"] ?? "");
    return s0.startsWith("operator:") || s0 === "human_reported" ? `source ${s0}` : fb.startsWith("operator:") ? `filed_by ${fb}` : null;
  };
  // The row's OWN filer is read by the same rule as an ancestor's (qa eval5 B2): `source` alone missed a row the lane
  // wrote as substrate_detected whose filed_by names an operator.
  const ownFiler = filerOf(row);
  const rootFiler = [...lineageAncestors(landing.gap_id, inp.byId)].sort().map((k) => ({ k, by: filerOf(inp.byId.get(k)) })).find((a) => a.by !== null);
  // The row's own operator filing fails link 1 in the same form (qa ruling 2026-10-22); its filing is still also the
  // operator act link 5 names.
  const l1: LinkState = ownFiler ? { state: "fail", why: `origin: operator-filed (${ownFiler})` }
    : rootFiler ? { state: "fail", why: `origin: operator-filed (lineage ancestor ${rootFiler.k.slice(-60)} is ${rootFiler.by})` }
    : src === "substrate_detected" ? { state: "pass", why: "source substrate_detected, and no operator-filed lineage ancestor" }
    : { state: "fail", why: `source ${src ? JSON.stringify(src) : "unset"}: autonomous only when substrate_detected (addendum 1: unset fails)` };
  // link 2
  const honest = judgeCheckHonest(row, inp.checkSource, inp.siteSource);
  // link 3: the attempt is autonomous, and the fix is the lane's commit on the edit site, on origin/dev
  let l3: LinkState;
  if (landing.directed !== true && !intentIsAutonomous(landing.directed)) l3 = { state: "fail", why: `the attempt's directed is ${landing.directed === undefined ? "absent" : JSON.stringify(landing.directed)}: autonomous only when directed === false exactly (absent or unknown is not)` };
  else if (!site) l3 = { state: "fail", why: "the row names no repos/<vessel>/<path> edit_site" };
  else if (landing.repo !== site.vessel) l3 = { state: "fail", why: `the fix landed in ${landing.repo || "?"}, not the edit site's repo ${site.vessel}` };
  else if (!inp.fix) l3 = { state: "review", why: "the fix commit is unreadable in the edit site's clone" };
  else if (inp.fix.author !== LANE_AUTHOR) l3 = { state: "fail", why: `the fix commit's author is ${JSON.stringify(inp.fix.author)}, not the lane` };
  else if (!inp.fix.files.includes(site.path)) l3 = { state: "fail", why: `the fix commit does not touch the edit_site ${site.path}` };
  else if (inp.fix.on_origin_dev === null) l3 = { state: "review", why: "whether the fix is on origin/dev could not be read" };
  else if (!inp.fix.on_origin_dev) l3 = { state: "fail", why: "the fix commit is not reachable from origin/dev in the edit site's repo" };
  else l3 = { state: "pass", why: "the lane's commit, on the edit site, reachable from origin/dev" };
  // link 4: the landing verdict
  const why = String(m["closed_reason"] ?? row["closed_reason"] ?? "");
  const basis = String(m["close_basis"] ?? row["close_basis"] ?? "");
  const lsha = String(m["landed_sha"] ?? row["landed_sha"] ?? "");
  const dissent = (Array.isArray(m["semantic_dissent"]) ? (m["semantic_dissent"] as unknown[]).length > 0 : !!m["semantic_dissent"])
    || (!!m["landed_unverified"] && (!m["landed_unverified_sha"] || String(m["landed_unverified_sha"]).startsWith(landing.sha.slice(0, 8)) || landing.sha.startsWith(String(m["landed_unverified_sha"]))));
  const sameSha = lsha.length >= 7 && (lsha.startsWith(landing.sha.slice(0, 12)) || landing.sha.startsWith(lsha));
  const landingVerdict: Record<string, unknown> = { status: String(row["status"] ?? ""), closed_reason: why || null, close_basis: basis || null, landed_sha: lsha || null, closed_at: closed ? closedAt : null, dissent, settlement2: inp.regressed ? { key: inp.regressed.key, source: inp.regressed.source, at: inp.regressed.at } : null };
  let l4: LinkState;
  if (inp.regressed) l4 = { state: "fail", why: `regressed settlement ${inp.regressed.key} (${inp.regressed.source}) @ ${inp.regressed.at}: ${inp.regressed.source === "falsified_after_restart" ? "the post-restart falsifier read the defect present" : inp.regressed.source === "operator_revert" ? "the operator reverted the landing" : "the attempt settled regressed"}` };
  else if (!closed) l4 = { state: "pending", why: `status ${String(row["status"] ?? "?")}: the landing verdict is not in yet` };
  else if (String(m["closed_by"] ?? "").startsWith("operator:") || EXCLUDED_CLOSE_RE.test(why)) l4 = { state: "fail", why: `closed ${why || "?"} by ${String(m["closed_by"] ?? "?")}: not the landing verdict` };
  else if (dissent) l4 = { state: "fail", why: "the fix landed under semantic dissent (landed_partial)" };
  else if (why === "landed_verified" && basis !== "absent") l4 = { state: "fail", why: `landed_verified with close_basis ${basis || "unset"}, not the measured check` };
  else if (why === "landed_verified" && !sameSha) l4 = { state: "review", why: `landed_verified basis absent, but landed_sha ${lsha.slice(0, 12) || "unset"} is not the fix ${landing.sha.slice(0, 12)}` };
  else if (why === "landed_verified") l4 = { state: "pass", why: `landed_verified basis absent landed_sha ${lsha.slice(0, 12)} = the fix` };
  else l4 = { state: "fail", why: `closed '${why || "?"}': not the landing verdict` };
  // link 6: durable 24 h (a revert or a reopen fails it at once)
  const durableFrom = closedMs !== null && landedMs !== null ? Math.max(closedMs, landedMs) : null;
  const durableUntil = durableFrom !== null ? new Date(durableFrom + DURABLE_MS).toISOString() : null;
  let l6: LinkState;
  const reverted = (inp.reverts ?? [])[0];
  if (reverted) l6 = { state: "fail", why: `the fix ${landing.sha.slice(0, 12)} was reverted by ${reverted.sha.slice(0, 12)} @ ${reverted.at}` };
  else if (inp.reverts === null) l6 = { state: "review", why: "the fix's reverts on origin/dev are unreadable" };
  else if (!closed) l6 = { state: "pending", why: "not closed" };
  else if (durableFrom === null) l6 = { state: "review", why: "the close or landing time cannot be dated" };
  else if (inp.nowMs < durableFrom + DURABLE_MS) l6 = { state: "pending", why: `durable from ${durableUntil} (24 h with no reopen and no revert)` };
  else l6 = { state: "pass", why: `closed, reopen_count ${String(row["reopen_count"] ?? 0)}, no revert of ${landing.sha.slice(0, 12)} on origin/dev after 24 h` };
  const fails: string[] = [];
  const firstWhy: string[] = [];
  const failIf = (name: string, s: LinkState | CheckHonest, text: string) => { if ((s as LinkState).state === "fail" || (s as CheckHonest).value === false) { fails.push(name); firstWhy.push(`${name}: ${text}`); } };
  failIf("link1", l1, l1.why); failIf("link2", honest, honest.reason); failIf("link3", l3, l3.why); failIf("link4", l4, l4.why); failIf("link6", l6, l6.why);
  const opLinks = [...new Set(acts.acts.map((a) => `operator_act:${a.addendum}`))];
  const failing = [...fails, ...opLinks];
  const route = acts.route_unverifiable > 0 ? `; ROUTE UNVERIFIABLE (addendum 4a): ${acts.route_unverifiable} system-principal write(s) with no recorded route, counted as system` : "";
  const out = (verdict: RepairVerdict, reason: string): RepairJudgement => ({
    ...base, verdict, reason: reason + route, ...(verdict === "not_counted" ? { failing_link: failing[0]! } : {}), failing_links: failing,
    arm_writer: armWriter, operator_acts: acts, check, check_honest: honest, landing_verdict: landingVerdict, durable_until: durableUntil, route_unverifiable: acts.route_unverifiable,
    window: { from: filedAt, until: untilAt },
  });
  if (fails.length > 0) return out("not_counted", `${firstWhy[0]}${opLinks.length > 0 ? `; also operator acts: ${acts.acts.slice(0, 2).map((a) => a.detail).join("; ")}` : ""}`);
  if (acts.acts.length > 0) return out("not_counted", `operator act from filing to close + 24 h: ${acts.acts.slice(0, 2).map((a) => a.detail).join("; ")}`);
  // UNKNOWN IS NEVER CLEAN: anything unread, unattributable or in review decides before time does.
  if (unknown.length > 0) return out("unjudged", `unread, so an operator act cannot be ruled out: ${unknown.join("; ")}`);
  // A lane landing whose authoring execution is known nowhere (qa eval5 B3): its labels were never asked, so it is
  // unattributable, never clean. Named first, so the reason always shows it.
  const unattributable = [...(inp.authoringUnknown === true ? ["the lane landing's authoring execution: unattributable, none on its attemptIntent and none in attemptAuthoring, so the oracle labels on it cannot be read"] : []), ...acts.unattributable];
  if (unattributable.length > 0) return out("unjudged", `link 5 UNATTRIBUTABLE (a writer, an S-2 answer or a provenance trace's labels cannot be classed): ${unattributable.slice(0, 3).join("; ")}`);
  if (acts.review.length > 0) return out("unjudged", `REVIEW: ${acts.review.slice(0, 2).join("; ")}`);
  if (honest.value === "unjudged") return out("unjudged", `link 2: ${honest.reason}`);
  for (const [n, s] of [["link 3", l3], ["link 4", l4], ["link 6", l6]] as const) if (s.state === "review") return out("unjudged", `${n}: ${s.why}`);
  if (l4.state === "pending" || l6.state === "pending") return out("pending", l4.state === "pending" ? `link 4 pending: ${l4.why}` : `link 6 pending: ${l6.why}`);
  return out("counted", `system-detected, system-armed, check honest, ${l3.why}, ${l4.why}, durable: ${l6.why}`);
}

export type LaneRevertVerdict = "green" | "red" | "pending" | "unjudged";
export interface RegressedSettlement { key: string; attempt_id: string; gap_id: string; sha: string; at: string | null; source: string }
export interface RevertCommit { sha: string; at: string; message: string }
export interface LaneRevertJudgement {
  fact: "lane_revert_within_1h"; settlement_id: string; gap_id: string; regressed_sha: string; regressed_repo: string | null; regressed_at: string | null;
  source: string; revert_sha: string | null; revert_at: string | null; revert_names_sha: boolean; lag_s: number | null; verdict: LaneRevertVerdict; reason: string;
  /** Judged because its red divergence is still open (not, or no longer, in the window). */
  carried: boolean;
}
const LANE_REVERT_MS = 3600_000;
/** One regressed settlement, judged. `reverts` are the commits ON ORIGIN/DEV after the regressed one that say they
 *  revert it, plus the auto-revert marker's own commit when it is on origin/dev; null when the clone was not found.
 *  `windowStartMs`: a settlement older than it with no revert is "expired unreverted" (red). Pure. */
export function judgeLaneRevert(s: RegressedSettlement, repo: string | null, fullSha: string | null, reverts: RevertCommit[] | null, nowMs: number, windowStartMs: number = Number.NEGATIVE_INFINITY, carried = false): LaneRevertJudgement {
  const base = { fact: "lane_revert_within_1h" as const, settlement_id: s.key, gap_id: s.gap_id, regressed_sha: fullSha ?? s.sha, regressed_repo: repo, regressed_at: s.at, source: s.source, carried };
  const at = isoMs(s.at);
  const none = { revert_sha: null, revert_at: null, revert_names_sha: false, lag_s: null };
  if (!repo || !fullSha || reverts === null) return { ...base, ...none, verdict: "unjudged", reason: `the regressed sha ${s.sha.slice(0, 12) || "?"} is in no vessel clone here (or its origin/dev is unreadable), so its reverts cannot be read` };
  if (at === null) return { ...base, ...none, verdict: "unjudged", reason: "the settlement has no readable time" };
  const names = (msg: string): boolean => msg.includes(fullSha) || msg.includes(fullSha.slice(0, 12));
  const lane = reverts.filter((r) => /^Auto-Revert:\s*true\s*$/m.test(r.message)).sort((a, b) => (isoMs(a.at) ?? 0) - (isoMs(b.at) ?? 0));
  const pick = lane.find((r) => names(r.message)) ?? lane[0];
  if (pick) {
    const rAt = isoMs(pick.at);
    const lag = rAt === null ? null : Math.round((rAt - at) / 1000);
    const named = names(pick.message);
    const j = { ...base, revert_sha: pick.sha, revert_at: pick.at, revert_names_sha: named, lag_s: lag };
    if (!named) return { ...j, verdict: "red", reason: `the lane revert ${pick.sha.slice(0, 12)} does not name the regressed sha` };
    if (lag === null || lag * 1000 > LANE_REVERT_MS) return { ...j, verdict: "red", reason: `the lane revert ${pick.sha.slice(0, 12)} landed ${lag === null ? "at an unreadable time" : `${lag} s`} after the settlement, past 1 h` };
    return { ...j, verdict: "green", reason: `lane revert ${pick.sha.slice(0, 12)} names the sha, on origin/dev, ${lag} s after the settlement` };
  }
  const other = reverts.find((r) => names(r.message));
  if (other) return { ...base, revert_sha: other.sha, revert_at: other.at, revert_names_sha: true, lag_s: isoMs(other.at) === null ? null : Math.round(((isoMs(other.at) as number) - at) / 1000), verdict: "red", reason: `reverted by ${other.sha.slice(0, 12)}, which is not a lane revert (no Auto-Revert trailer)${s.source === "operator_revert" ? "; the settlement records an operator revert" : ""}` };
  if (at < windowStartMs) return { ...base, ...none, verdict: "red", reason: "expired unreverted: the settlement aged out of the window with no lane revert observed on origin/dev" };
  if (nowMs - at < LANE_REVERT_MS) return { ...base, ...none, verdict: "pending", reason: `no revert yet, ${Math.round((nowMs - at) / 1000)} s into the 1 h` };
  return { ...base, ...none, verdict: "red", reason: "no revert within 1 h" };
}

// The fixtures the must-fail controls judge (the same functions as the live items). Fixed values, so a control's
// verdict depends on the judge alone; times are relative to the run.
export const REPAIR_MUST_FAIL_ID = "fixture:operator-armed-verified-landing";
export const REPAIR_POSITIVE_ID = "fixture:system-armed-verified-landing";
export const LANE_REVERT_MUST_FAIL_ID = "fixture:regressed-settlement-no-revert";
export function repairControlInputs(nowMs: number, operatorArmed: boolean): RepairInputs {
  const id = operatorArmed ? REPAIR_MUST_FAIL_ID : REPAIR_POSITIVE_ID;
  const t = (h: number) => new Date(nowMs - h * 3600_000).toISOString();
  const sha = "f".repeat(40);
  const row: GapRow = { id, status: "closed", source: "substrate_detected", first_detected_at: t(80), closed_at: t(48), reopen_count: 0,
    classification_metadata: { edit_site: "repos/fixture-vessel/src/fixture.ts", check_supply: { state: "armed", test_file: "test/fixture.check.ts" }, predicate_birth_verdict: "present", closed_reason: "landed_verified", close_basis: "absent", landed_sha: sha } };
  const ev = (over: Record<string, unknown>) => ({ gap_id: id, outcome: "written", store: "local", source: "holder" as const, principal_kind: "in-process", key_id: null, operator_marker: false, ...over });
  return {
    landing: { attempt_id: "att-fixture-0", gap_id: id, sha, repo: "fixture-vessel", at: t(50), directed: false, authoring_execution_id: null, from: "ledger" }, row, byId: new Map([[id, row]]), regressed: null, reverts: [],
    fix: { author: LANE_AUTHOR, at: t(50), files: ["src/fixture.ts"], on_origin_dev: true },
    checkSource: `import { fixture } from "../src/fixture.js";\nexpect(fixture()).toBe("fixed");\n`, siteSource: `export function fixture() { return "fixed"; }\n`,
    acts: { scopeActs: [], siteCommits: [], checkFirstCommit: { sha: "e".repeat(40), author: LANE_AUTHOR, at: t(70), lane: true, files: ["test/fixture.check.ts"] }, keymap: [], peerKeys6: [], originPresent: false,
      eventsCapped: false, eventsFromFiling: true, labels: [], labelContext: { fixLiveAt: t(200), keymap: [], forwardingKeys: [], nodeSelfAdminKeys: [] },
      events: [ev({ fields_changed: ["status"], status_from: "absent", ts: t(80) }),
        ev({ fields_changed: ["classification_metadata.check_supply"], ts: t(70), principal_kind: operatorArmed ? "key" : "in-process", key_id: operatorArmed ? "key_fx" : null, operator_marker: operatorArmed })] },
    nowMs,
  };
}
export function laneRevertControls(nowMs: number): Array<{ name: string; want: LaneRevertVerdict; j: LaneRevertJudgement }> {
  const sha = "d".repeat(40);
  const at = new Date(nowMs - 3 * 3600_000).toISOString();
  const s = (key: string, when = at): RegressedSettlement => ({ key, attempt_id: "att-fixture-1", gap_id: LANE_REVERT_MUST_FAIL_ID, sha, at: when, source: "falsified_after_restart" });
  const rev = (minutes: number, named: boolean): RevertCommit => ({ sha: "c".repeat(40), at: new Date(nowMs - 3 * 3600_000 + minutes * 60_000).toISOString(), message: `Revert "x"\n\n${named ? `This reverts commit ${sha}.` : "This reverts the regressed landing."}\n\nAuto-Revert: true` });
  const old = new Date(nowMs - 200 * 3600_000).toISOString();
  return [
    { name: LANE_REVERT_MUST_FAIL_ID, want: "red", j: judgeLaneRevert(s(LANE_REVERT_MUST_FAIL_ID), "fixture-vessel", sha, [], nowMs) },
    { name: "fixture:regressed-settlement-timely-lane-revert", want: "green", j: judgeLaneRevert(s("fixture:regressed-settlement-timely-lane-revert"), "fixture-vessel", sha, [rev(30, true)], nowMs) },
    { name: "fixture:regressed-settlement-late-lane-revert", want: "red", j: judgeLaneRevert(s("fixture:regressed-settlement-late-lane-revert"), "fixture-vessel", sha, [rev(90, true)], nowMs) },
    { name: "fixture:regressed-settlement-shaless-lane-revert", want: "red", j: judgeLaneRevert(s("fixture:regressed-settlement-shaless-lane-revert"), "fixture-vessel", sha, [rev(20, false)], nowMs) },
    { name: "fixture:regressed-settlement-expired-unreverted", want: "red", j: judgeLaneRevert(s("fixture:regressed-settlement-expired-unreverted", old), "fixture-vessel", sha, [], nowMs, nowMs - 168 * 3600_000, true) },
  ];
}
export const judgementLine = (j: { fact: string }): string => `[self-fact-judgement] ${JSON.stringify(j)}`;
/** The S-2 inputs of one closure: the dispatch records naming its gap (by id or qualified edit_site, as link 5 names
 *  them), each read with its resolverAnswers, and the resolverRequest record of every request those answers name. An
 *  unread store is unread answers. Whether a record is trusted (it must name a provenance trace) is the reader's. */
async function s2Inputs(deps: JudgementDeps, store: DispatchStoreEntry[] | null, gapId: string, site: string): Promise<{ resolverDispatches: ResolverDispatchLike[] | null; resolverRequests: Map<string, ResolverRequestLike> }> {
  const requests = new Map<string, ResolverRequestLike>();
  if (store === null) return { resolverDispatches: null, resolverRequests: requests };
  const names = [...new Set([gapId, site, site.startsWith("repos/") ? site.slice("repos/".length) : ""])].filter((n) => n && n.length > 8);
  const ids = [...new Set(store.filter((e): e is Record<string, unknown> => !!e && typeof e === "object").filter((e) => { const t = JSON.stringify(e) ?? ""; return names.some((n) => t.includes(n)); }).map((e) => String(e["dispatchId"] ?? "")).filter(Boolean))];
  const out: ResolverDispatchLike[] = [];
  for (const id of ids) {
    let d: ResolverDispatchLike | null = null;
    try { d = deps.resolverDispatch ? await deps.resolverDispatch(id) : null; } catch { d = null; }
    out.push(d ?? { dispatch_id: id, execution_id: null, resolverAnswers: null });
    for (const a of d?.resolverAnswers ?? []) {
      const rid = a && typeof a === "object" ? a.lease_provenance?.request_id : null;
      if (typeof rid !== "string" || !rid || requests.has(rid)) continue;
      let r: ResolverRequestLike | null = null;
      try { r = deps.resolverRequest ? await deps.resolverRequest(rid) : null; } catch { r = null; }
      if (r) requests.set(rid, r);
    }
  }
  return { resolverDispatches: out, resolverRequests: requests };
}

type LedgerRow = { key: string; at: string; record: Record<string, unknown> };
// What the two rows read, injectable for tests (a fixture ledger, store, clones and scope history).
export interface JudgementDeps {
  ledger: (kind: "attemptIntent" | "attemptSettlement" | "landingEvent" | "attemptRevert" | "selfFactAggregate") => LedgerRow[];
  /** Whether the ledger file of `kind` exists: an absent file is unknown, never an empty ledger. */
  ledgerPresent: (kind: "attemptIntent" | "attemptSettlement" | "landingEvent") => boolean;
  /** The spool's landing events not yet ingested into the ledger (read only), or null when the spool is unreadable. */
  spool: () => Array<{ key: string; record: Record<string, unknown> | null }> | null;
  readGaps: () => Promise<GapRow[]>;
  /** One gap's write events from this node's file (the holder's), with how many matched; null when unreadable. */
  readEvents: (gapId: string) => Promise<{ events: GapWriteEventLike[]; matched: number } | null>;
  /** The key class map; null when none is served (the named limit). */
  keymap: () => Promise<KeyMapEntry[] | null>;
  /** Oracle labels on these traces and the label rule's context; null when unreadable (the named limit). */
  labels: (traceIds: string[]) => Promise<{ labels: Array<OracleLabelLike & { execution_id?: string | null }>; context: LabelClassContext } | null>;
  /** The vessel clone holding `sha`: its name, dir and the full sha. */
  locate: (sha: string) => { repo: string; dir: string; fullSha: string } | null;
  /** The clone dir of a vessel by name, or null. */
  cloneOf: (vessel: string) => string | null;
  /** The full sha of `sha` in `dir`, or null when it is not a commit there. */
  revParse: (dir: string, sha: string) => string | null;
  /** The fix commit in `dir`, with whether origin/dev reaches it; null when unreadable. */
  fixCommit: (dir: string, fullSha: string) => FixCommit | null;
  /** Commits on origin/dev in `dir` after `sinceIso` touching any of `paths`, or null when unreadable. */
  siteCommits: (dir: string, paths: string[], sinceIso: string) => SiteCommit[] | null;
  /** The commit that added `path` on origin/dev in `dir`; undefined when never added; null when unreadable. */
  firstCommit: (dir: string, path: string) => SiteCommit | null | undefined;
  /** Commits on origin/dev after `fullSha` in `dir` whose message says it reverts it, or null when unreadable. */
  revertsOf: (dir: string, fullSha: string) => RevertCommit[] | null;
  /** A commit's time and message when origin/dev reaches it, or null. */
  commit: (dir: string, sha: string) => RevertCommit | null;
  /** A file at a commit, or null. */
  show: (dir: string, sha: string, path: string) => string | null;
  /** Operator scope acts in ALL of the super-repo's scope history that opened each of `sites` to the lane (read once per
   *  run), or null when unreadable. Never from the row window's start: an act before the window still opened the site. */
  scopeActs: (sites: string[]) => Promise<Map<string, ScopeAct[]> | null>;
  /** goal-host's dispatch records (activeDispatches, every page), read once per run; null when unreadable or cut. */
  dispatches?: () => Promise<DispatchStoreEntry[] | null>;
  /** One goal-host dispatch record with its resolverAnswers (goalWalkState by dispatchId); null when unreadable. */
  resolverDispatch?: (dispatchId: string) => Promise<ResolverDispatchLike | null>;
  /** goal-host's resolverRequest record by request_id; null when unreadable or unknown. */
  resolverRequest?: (requestId: string) => Promise<ResolverRequestLike | null>;
  /** Append one run's aggregate (append-only: a repeated key is refused). */
  /** A lane attempt's authoring execution written after registration (attemptAuthoring.jsonl), read by attempt-register's
   *  own reader (authoringOverride); null when it has none. */
  authoring?: (attemptId: string) => Promise<string | null>;
  persist: (key: string, record: Record<string, unknown>) => { appended: boolean };
  now: () => number;
  log: (line: string) => void;
}
const gitRun = (dir: string, args: string[]): { code: number; out: string } | null => git(args, dir, { raw: true, timeoutMs: 15_000 });
const gitIn = (dir: string, args: string[]): string | null => { const r = gitRun(dir, args); return r && r.code === 0 ? r.out : null; };
/** origin/dev reaches `sha` in `dir`: true / false, or null when it cannot be read. */
const onOriginDev = (dir: string, sha: string): boolean | null => { const r = gitRun(dir, ["merge-base", "--is-ancestor", sha, "origin/dev"]); return r === null ? null : r.code === 0 ? true : r.code === 1 ? false : null; };
const parseCommits = (out: string): SiteCommit[] => out.split("\x1e").map((b) => b.trim()).filter(Boolean).map((b) => {
  const [head, ...files] = b.split("\n");
  const [sha, author, at] = (head ?? "").split("\x1f");
  return { sha: sha ?? "", author: author ?? "", at: at ?? "", lane: author === LANE_AUTHOR, files: files.map((f) => f.trim()).filter(Boolean) };
}).filter((c) => /^[0-9a-f]{40}$/.test(c.sha));
/** Operator scope acts from the super-repo's history of the committed scope and this node's pin: a commit (not the
 *  lane's) after which a site is no longer excluded where it was before. Dated by the commit (earlier than any apply).
 *  The history is read ONCE per run (one log, two shows per commit), then every site is tested against it. */
async function scopeActsFromHistory(sites: string[]): Promise<Map<string, ScopeAct[]> | null> {
  const root = superRepoRoot();
  const log = gitIn(root, ["log", "--reverse", "--format=%H%x1f%an%x1f%cI", "origin/dev", "--", "scripts/substrate/autonomy-scope.json", ROWS_PATH]);
  if (log === null) return null;
  const { autonomyScopeExcludes, parseScopeExceptions } = await import("../judge/gap-policy.js");
  const node = thisNode();
  /** The scope this node is pinned to at `rev` (its expected_by_node value, else the fleet default), or null. */
  const scopeAt = (rev: string): AutonomyScopeLike | null => {
    let body: Record<string, unknown> | null = null;
    try {
      const rows = (JSON.parse(gitIn(root, ["show", `${rev}:${ROWS_PATH}`]) ?? "{}") as { rows?: SelfFactRow[] }).rows ?? [];
      const pin = rows.find((r) => r.instrument === "pool_record_pin" && r.pool_shape === "autonomyScope")?.expected_by_node?.[node];
      if (pin && !Array.isArray(pin) && typeof pin === "object") body = pin as Record<string, unknown>;
    } catch { /* fall back to the fleet default */ }
    if (!body) {
      try { body = (JSON.parse(gitIn(root, ["show", `${rev}:scripts/substrate/autonomy-scope.json`]) ?? "") as { autonomyScope?: Record<string, unknown> }).autonomyScope ?? null; } catch { return null; }
    }
    if (!body || !Array.isArray(body["excluded_paths"])) return null;
    return { readable: true, reason: "history", excluded: (body["excluded_paths"] as unknown[]).map(String), exceptions: parseScopeExceptions(body["excluded_path_exceptions"]) };
  };
  const commits = log.split("\n").map((l) => l.split("\x1f")).filter((p) => /^[0-9a-f]{40}$/.test(p[0] ?? ""));
  const versions = commits.map(([sha, author, at]) => ({ sha: sha!, author: author ?? "", at: at ?? "", scope: scopeAt(sha!) }));
  const before = commits.length > 0 ? scopeAt(`${commits[0]![0]}^`) : null;
  const out = new Map<string, ScopeAct[]>();
  for (const site of sites) {
    const acts: ScopeAct[] = [];
    let prev = before ? autonomyScopeExcludes(before as never, site) !== null : null;
    for (const v of versions) {
      const now = v.scope ? autonomyScopeExcludes(v.scope as never, site) !== null : null;
      if (prev === true && now === false && v.author !== LANE_AUTHOR) acts.push({ id: `super-repo ${v.sha.slice(0, 12)} (${v.author})`, opened: [site], effective_at: v.at });
      if (now !== null) prev = now;
    }
    out.set(site, acts);
  }
  return out;
}
type AutonomyScopeLike = { readable: true; reason: string; excluded: string[]; exceptions: string[] };
/**
 * THE ORACLE LABELS ON A CLOSURE'S PROVENANCE TRACES, read through the shape their store serves (activity-api
 * goal_verification_label), routed by discovery to this substrate's own producers at use time, one equality read per
 * trace id. Strict, as every reader here: no producer, a read that fails, a page that reaches the read's cap (some may
 * be missing), or a trace whose labels come from more than one org (the read is not org-scoped for an ApiKey caller,
 * and nothing served tells this vessel its own org, so the labels of one execution must at least agree on theirs)
 * returns null, which the reader reads as REVIEW. A trace with no label reads none.
 * The label rule's context is NOT served (fixLiveAt, forwardingKeys, nodeSelfAdminKeys and the key class map have no
 * producer), so it carries none: classifyOracleLabel then reads every label review, and only a closure whose traces
 * carry no label at all is judged on labels. Exported, with its transport injectable, for tests.
 */
export const ORACLE_LABEL_SHAPE = "goal_verification_label";
const ORACLE_LABEL_PAGE = 100;
export interface OracleLabelIo { urls: () => Promise<string[] | null>; post: (url: string, body: unknown) => Promise<Record<string, unknown> | null> }
const defaultOracleLabelIo: OracleLabelIo = {
  urls: async () => { const { discoverOwnResolveUrls } = await import("../judge/gap-policy.js"); const d = await discoverOwnResolveUrls(ORACLE_LABEL_SHAPE); return d.ok && d.urls.length > 0 ? d.urls : null; },
  post: async (url, body) => (await import("../judge/gap-policy.js")).postEnvelopeRead(url, body),
};
/**
 * THE KEY CLASS MAP, read through the shape identity serves (apiKeyClass: each key's class, by masked id), routed by
 * discovery to this substrate's own producers at use time. Every key the shape lists is kept, an unclassified one
 * included (owner_kind "unclassified", which no reader takes for system or operator), so two keys sharing a 6-character
 * prefix stay ambiguous for keyClass6. null when no producer answers or the answer is not a key list: a key-principal
 * write is then unattributable, never assumed system. Exported, with its transport injectable, for tests.
 */
export const KEY_CLASS_SHAPE = "apiKeyClass";
export interface KeyClassServed { id: string; owner_kind: string; owner_node: string | null; is_admin: boolean }
const defaultKeyClassIo: OracleLabelIo = {
  urls: async () => { const { discoverOwnResolveUrls } = await import("../judge/gap-policy.js"); const d = await discoverOwnResolveUrls(KEY_CLASS_SHAPE); return d.ok && d.urls.length > 0 ? d.urls : null; },
  post: async (url, body) => (await import("../judge/gap-policy.js")).postEnvelopeRead(url, body),
};
let keyClassIo: OracleLabelIo = defaultKeyClassIo;
/** Tests only: replace the key class map's transport (null restores discovery + the envelope read). */
export function __setKeyClassIoForTests(io: OracleLabelIo | null): void { keyClassIo = io ?? defaultKeyClassIo; }
export async function readKeyClassMap(io: OracleLabelIo = keyClassIo): Promise<KeyClassServed[] | null> {
  const urls = await io.urls();
  if (!urls) return null;
  for (const url of urls) {
    const r = await io.post(url, { impulse: { pointer: { type: KEY_CLASS_SHAPE } } });
    const keys = (r?.["data"] as { keys?: unknown } | undefined)?.keys;
    if (r?.["success"] !== true || !Array.isArray(keys)) continue;
    return keys.filter((k): k is Record<string, unknown> => !!k && typeof k === "object" && typeof (k as Record<string, unknown>)["key_id_mask12"] === "string")
      .map((k) => ({ id: String(k["key_id_mask12"]), owner_kind: typeof k["owner_kind"] === "string" && k["owner_kind"] ? String(k["owner_kind"]) : "unclassified", owner_node: typeof k["owner_node"] === "string" ? String(k["owner_node"]) : null, is_admin: k["is_admin"] === true }));
  }
  return null;
}
/** The label rule's key context from the served class map: forwarding keys are a peer's, or another node's system
 *  key; this node's own admin keys are its system keys with is_admin. fixLiveAt is not served yet. */
export function labelContextFrom(keys: readonly KeyClassServed[] | null, node: string): LabelClassContext {
  const ks = keys ?? [];
  return {
    fixLiveAt: "",
    keymap: ks.map((k) => ({ id: k.id, owner_kind: k.owner_kind })),
    forwardingKeys: ks.filter((k) => k.owner_kind === "peer" || (k.owner_kind === "system" && k.owner_node !== null && k.owner_node !== node)).map((k) => k.id),
    nodeSelfAdminKeys: ks.filter((k) => k.owner_kind === "system" && k.is_admin && k.owner_node === node).map((k) => k.id),
  };
}
let oracleLabelIo: OracleLabelIo = defaultOracleLabelIo;
/** Tests only: replace the label reader's transport (null restores discovery + the envelope read). */
export function __setOracleLabelIoForTests(io: OracleLabelIo | null): void { oracleLabelIo = io ?? defaultOracleLabelIo; }
export async function readOracleLabels(traceIds: string[], io: OracleLabelIo = defaultOracleLabelIo): Promise<{ labels: Array<OracleLabelLike & { execution_id?: string | null }>; context: LabelClassContext } | null> {
  let context: LabelClassContext = labelContextFrom(null, thisNode());
  const ids = [...new Set(traceIds.filter((x) => typeof x === "string" && x.length > 0))].sort();
  if (ids.length === 0) return { labels: [], context };
  const urls = await io.urls();
  if (!urls) return null;
  const labels: Array<OracleLabelLike & { execution_id?: string | null }> = [];
  for (const id of ids) {
    let rows: Array<Record<string, unknown>> | null = null;
    for (const url of urls) {
      const r = await io.post(url, { impulse: { pointer: { type: ORACLE_LABEL_SHAPE, execution_id: id, limit: ORACLE_LABEL_PAGE } } });
      if (!r || r["success"] !== true || typeof r["content"] !== "string") continue;
      try { const v: unknown = JSON.parse(r["content"]); if (Array.isArray(v)) { rows = v as Array<Record<string, unknown>>; break; } } catch { /* the next producer */ }
    }
    if (rows === null || rows.length >= ORACLE_LABEL_PAGE) return null;
    const mine = rows.filter((l) => l && typeof l === "object" && l["execution_id"] === id);
    if (new Set(mine.map((l) => String(l["org_id"] ?? ""))).size > 1) return null;
    labels.push(...mine.map((l) => ({ execution_id: id, labeler: (l["labeler"] as string | undefined) ?? null, source: (l["source"] as string | undefined) ?? null, created_at: (l["created_at"] as string | undefined) ?? null, principal_kind: (l["principal_kind"] as string | undefined) ?? null, principal_key_id: (l["principal_key_id"] as string | undefined) ?? null })));
  }
  // The key context is read only when there is a label to class (fixLiveAt is not served yet, so it decides nothing
  // today; it is read through the same shape the keymap is).
  if (labels.length > 0) { try { context = labelContextFrom(await readKeyClassMap(), thisNode()); } catch { /* unread: the empty context, every label REVIEW */ } }
  return { labels, context };
}
/**
 * goal-host's open reads for link 5 and the S-2 answers, READ-ONLY, routed by discovery to this substrate's own
 * producers at use time (the readKeyClassMap pattern). Any failure is null: unread, so UNATTRIBUTABLE downstream.
 */
async function goalHostResolve(shape: string, pointer: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const { discoverOwnResolveUrls, postEnvelopeRead } = await import("../judge/gap-policy.js");
  const d = await discoverOwnResolveUrls(shape);
  if (!d.ok || d.urls.length === 0) return null;
  for (const url of d.urls) {
    const r = await postEnvelopeRead(url, { impulse: { pointer: { type: shape, ...pointer } } });
    const b = (r?.["body"] ?? null) as Record<string, unknown> | null;
    if (b && typeof b === "object") return b;
  }
  return null;
}
/** Every activeDispatches page, or null when a page is unreadable or the store is longer than the bound read. */
const DISPATCH_PAGE = 50, DISPATCH_PAGES = 40;
async function readGoalHostDispatches(): Promise<DispatchStoreEntry[] | null> {
  const out: DispatchStoreEntry[] = [];
  for (let i = 0; i < DISPATCH_PAGES; i++) {
    const b = await goalHostResolve("activeDispatches", { limit: DISPATCH_PAGE, offset: i * DISPATCH_PAGE });
    if (!b || !Array.isArray(b["dispatches"])) return null;
    out.push(...(b["dispatches"] as Array<Record<string, unknown>>));
    if (b["hasMore"] !== true) return out;
  }
  return null; // more than the bound: some dispatches unseen, so the store reads unread
}
async function readGoalHostResolverDispatch(dispatchId: string): Promise<ResolverDispatchLike | null> {
  const b = await goalHostResolve("goalWalkState", { dispatchId });
  if (!b) return null;
  const answers = b["resolverAnswers"];
  return { dispatch_id: dispatchId, execution_id: typeof b["executionId"] === "string" ? b["executionId"] : null, resolverAnswers: Array.isArray(answers) ? (answers as ResolverAnswerLike[]) : null };
}
async function readGoalHostResolverRequest(requestId: string): Promise<ResolverRequestLike | null> {
  const b = await goalHostResolve("resolverRequest", { request_id: requestId });
  const reqs = b && Array.isArray(b["requests"]) && b["unknown"] !== true ? (b["requests"] as ResolverRequestLike[]) : null;
  const r = reqs?.find((x) => x && x.request_id === requestId);
  return r ?? null;
}
const defaultJudgementDeps: JudgementDeps = {
  ledger: (kind) => readRecords(kind).map((r) => ({ key: r.key, at: r.at, record: r.record as Record<string, unknown> })),
  ledgerPresent: (kind) => existsSync(join(ledgerDir(), `${kind}.jsonl`)),
  spool: () => {
    // The git hooks spool landing events; unaccounted_landing_scan ingests them into landingEvent. Read, never ingested
    // here: a landing still in the spool is a landing. An absent spool is unreadable (the scan says the same).
    const dir = join(ledgerDir(), "spool");
    if (!existsSync(dir)) return null;
    let names: string[];
    try { names = readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return null; }
    const out: Array<{ key: string; record: Record<string, unknown> | null }> = [];
    for (const f of names) {
      // A torn file is kept as record null: it may be a landing, so it is expected and unjudged, never dropped.
      try { const r: unknown = JSON.parse(readFileSync(join(dir, f), "utf8")); out.push({ key: `spool:${f}`, record: r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : null }); } catch { out.push({ key: `spool:${f}`, record: null }); }
    }
    return out;
  },
  readGaps: async () => {
    const r = await resolveSubstrateGap({ type: "substrateGap", limit: 1_000_000, include_held: true } as never);
    const gaps = (r.body as { gaps?: unknown } | undefined)?.gaps;
    if (r.shape === "structuredError" || !Array.isArray(gaps)) throw new Error("gap store unreadable");
    return gaps as GapRow[];
  },
  readEvents: async (gapId) => {
    const r = await resolveGapWriteEvent({ gap_id: gapId, limit: 1000 });
    const b = r.body as { events?: unknown; matched?: unknown } | undefined;
    return r.shape === "gapWriteEvent" && Array.isArray(b?.events) ? { events: b!.events as GapWriteEventLike[], matched: Number(b!.matched ?? (b!.events as unknown[]).length) } : null;
  },
  keymap: async () => { const ks = await readKeyClassMap(); return ks === null ? null : ks.map((k) => ({ id: k.id, owner_kind: k.owner_kind })); },
  labels: (traceIds) => readOracleLabels(traceIds, oracleLabelIo),
  locate: (sha) => {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return null;
    let names: string[] = [];
    try { names = readdirSync(cloneRoot()).sort(); } catch { return null; }
    for (const n of names) {
      const dir = join(cloneRoot(), n);
      if (!existsSync(join(dir, ".git"))) continue;
      const full = (gitIn(dir, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]) ?? "").trim();
      if (/^[0-9a-f]{40}$/.test(full)) return { repo: n, dir, fullSha: full };
    }
    return null;
  },
  cloneOf: (vessel) => { const d = join(cloneRoot(), vessel); return /^[A-Za-z0-9._-]+$/.test(vessel) && existsSync(join(d, ".git")) ? d : null; },
  revParse: (dir, sha) => { const f = (gitIn(dir, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]) ?? "").trim(); return /^[0-9a-f]{40}$/.test(f) ? f : null; },
  fixCommit: (dir, fullSha) => {
    const head = gitIn(dir, ["log", "-1", "--format=%an%x1f%cI", fullSha]);
    const files = gitIn(dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", fullSha]);
    if (head === null || files === null) return null;
    const [author, at] = head.trim().split("\x1f");
    return { author: author ?? "", at: at ?? "", files: files.split("\n").map((f) => f.trim()).filter(Boolean), on_origin_dev: onOriginDev(dir, fullSha) };
  },
  siteCommits: (dir, paths, sinceIso) => { const o = gitIn(dir, ["log", `--since=${sinceIso}`, "--format=%x1e%H%x1f%an%x1f%cI", "--name-only", "origin/dev", "--", ...paths]); return o === null ? null : parseCommits(o); },
  firstCommit: (dir, path) => { const o = gitIn(dir, ["log", "--diff-filter=A", "--reverse", "--format=%x1e%H%x1f%an%x1f%cI", "--name-only", "origin/dev", "--", path]); if (o === null) return null; return parseCommits(o)[0]; },
  revertsOf: (dir, fullSha) => {
    const o = gitIn(dir, ["log", "-E", "-i", "--grep", `reverts (\\w+ ){0,4}(commit )?(${fullSha}|${fullSha.slice(0, 12)})`, "--format=%x1e%H%x1f%cI%x1f%B", `${fullSha}..origin/dev`]);
    if (o === null) return null;
    return o.split("\x1e").map((b) => b.replace(/^\n/, "")).filter(Boolean).map((b) => { const [sha, at, ...msg] = b.split("\x1f"); return { sha: (sha ?? "").trim(), at: (at ?? "").trim(), message: msg.join("\x1f") }; }).filter((c) => /^[0-9a-f]{40}$/.test(c.sha));
  },
  commit: (dir, sha) => {
    if (onOriginDev(dir, sha) !== true) return null; // a revert only counts once it reached origin/dev
    const o = gitIn(dir, ["log", "-1", "--format=%H%x1f%cI%x1f%B", sha]);
    if (!o) return null;
    const [s, at, ...msg] = o.split("\x1f");
    return /^[0-9a-f]{40}$/.test((s ?? "").trim()) ? { sha: s!.trim(), at: (at ?? "").trim(), message: msg.join("\x1f") } : null;
  },
  show: (dir, sha, path) => gitIn(dir, ["show", `${sha}:${path}`]),
  scopeActs: scopeActsFromHistory,
  authoring: async (id) => (await (await import("./attempt-ledger.js")).authoringOverride(id)).authoring_execution_id ?? null,
  dispatches: () => readGoalHostDispatches(),
  resolverDispatch: (id) => readGoalHostResolverDispatch(id),
  resolverRequest: (id) => readGoalHostResolverRequest(id),
  persist: (key, record) => ({ appended: appendRecord("selfFactAggregate", key, record).appended }),
  now: () => Date.now(),
  log: (line) => console.log(line),
};
let judgementDeps: JudgementDeps = defaultJudgementDeps;
/** Tests only: replace what repair_autonomy and lane_revert_within_1h read (null restores the defaults). */
export function __setJudgementDepsForTests(d: Partial<JudgementDeps> | null): void {
  // The goal-host reads (link 5 dispatches, S-2 answers) are NOT ASKED unless a test injects them: a test of another
  // link must not reach a live goal-host, and "not asked" is not "unread" (operator-acts reads undefined as not asked).
  judgementDeps = d ? { ...defaultJudgementDeps, dispatches: undefined, resolverDispatch: undefined, resolverRequest: undefined, ...d } : defaultJudgementDeps;
}

/** A ledger or spool entry that may be a lane landing but cannot be tied to a gap: counted in expected, judged unjudged. */
export interface UnjudgeableLanding { key: string; reason: string; attempt_id: string | null; sha: string | null; at: string | null; from: "ledger" | "spool" }
/** The lane landings in the window, from the ledger AND its undrained spool, newest per gap (expected for
 *  repair_autonomy). A landing whose time cannot be parsed is kept (unknown is never out of the window). An entry that
 *  may be a lane landing but cannot be tied to a gap (a torn spool file; a landing whose attempt has no intent, or whose
 *  intent names no gap) is returned as unjudgeable, never dropped. */
export function ledgerLandings(deps: Pick<JudgementDeps, "ledger" | "spool">, sinceMs: number): { landings: RepairLanding[]; unjudgeable: UnjudgeableLanding[]; spool_readable: boolean } {
  const intents = new Map<string, Record<string, unknown>>();
  for (const r of deps.ledger("attemptIntent")) intents.set(r.key, r.record);
  const ingested = deps.ledger("landingEvent");
  const keys = new Set(ingested.map((r) => r.key));
  const spool = deps.spool();
  const events: Array<{ key: string; record: Record<string, unknown> | null; from: "ledger" | "spool" }> = [
    ...ingested.map((r) => ({ key: r.key, record: r.record, from: "ledger" as const })),
    ...(spool ?? []).filter((s) => !keys.has(s.key)).map((s) => ({ key: s.key, record: s.record, from: "spool" as const })),
  ];
  const byGap = new Map<string, RepairLanding>();
  const unjudgeable = new Map<string, UnjudgeableLanding>();
  for (const { key, record: e, from } of events) {
    if (e === null) { unjudgeable.set(key, { key, reason: "a torn spool file: it may be a lane landing, so it is expected and cannot be judged", attempt_id: null, sha: null, at: null, from }); continue; }
    // A rewrite (an amended landing) is a landing too, under its new sha; the newest per gap is judged.
    if (e["event"] !== "commit" && e["event"] !== "rewrite") continue;
    const att = typeof e["attempt_id"] === "string" ? e["attempt_id"] : "";
    const sha = typeof e["sha"] === "string" ? e["sha"] : "";
    if (!att.startsWith("att-") || !/^[0-9a-f]{40}$/.test(sha)) continue;
    const at = isoMs(e["at"]);
    if (at !== null && at < sinceMs) continue;
    const atText = at === null ? (typeof e["at"] === "string" ? e["at"] : null) : new Date(at).toISOString();
    const intent = intents.get(att);
    if (!intent) { unjudgeable.set(att, { key: att, reason: `the landing's attempt ${att} has no attemptIntent, so its gap and its directed flag are unknown`, attempt_id: att, sha, at: atText, from }); continue; }
    if (intent["route"] === "auto_revert") continue; // a revert is not a repair
    const gapId = typeof intent["gap_id"] === "string" ? intent["gap_id"] : "";
    if (!gapId) { unjudgeable.set(att, { key: att, reason: `the landing's attempt ${att} names no gap, so no closure can be judged`, attempt_id: att, sha, at: atText, from }); continue; }
    const repo = String(e["repo"] ?? "").split("/").filter(Boolean).pop() ?? "";
    const prev = byGap.get(gapId);
    const prevAt = prev ? isoMs(prev.at) : null;
    if (!prev || (at !== null && (prevAt === null || prevAt <= at))) {
      byGap.set(gapId, { attempt_id: att, gap_id: gapId, sha, repo, at: atText, directed: intent["directed"], authoring_execution_id: typeof intent["authoring_execution_id"] === "string" ? intent["authoring_execution_id"] : null, from });
    }
  }
  return { landings: [...byGap.values()].sort((a, b) => a.gap_id.localeCompare(b.gap_id)), unjudgeable: [...unjudgeable.values()].sort((a, b) => a.key.localeCompare(b.key)), spool_readable: spool !== null };
}
/** Every regressed settlement in the ledger, by key (the window is applied by the caller). */
export function ledgerRegressedSettlements(deps: Pick<JudgementDeps, "ledger">): Map<string, RegressedSettlement> {
  const out = new Map<string, RegressedSettlement>();
  for (const r of deps.ledger("attemptSettlement")) {
    const rec = r.record;
    if (rec["verdict"] !== "regressed") continue;
    const raw = rec["at"] ?? r.at;
    const at = isoMs(raw);
    const shas = Array.isArray(rec["shas"]) ? (rec["shas"] as unknown[]).map(String) : [];
    out.set(r.key, { key: r.key, attempt_id: String(rec["attempt_id"] ?? ""), gap_id: typeof rec["gap_id"] === "string" ? rec["gap_id"] : "", sha: shas[shas.length - 1] ?? "", at: at === null ? (typeof raw === "string" ? raw : null) : new Date(at).toISOString(), source: String(rec["source"] ?? "settle_regressed") });
  }
  return out;
}
/** Append one run's aggregate for a row, append-only (the key names the row, the node and the run). */
function persistAggregate(deps: JudgementDeps, fact: string, ranAt: string, planted: boolean, aggregate: Record<string, unknown>): { key: string; appended: boolean } {
  const key = `${fact}@${thisNode()}@${ranAt}@${planted ? "planted" : "recheck"}`;
  try {
    const r = deps.persist(key, { fact, node: thisNode(), ran_at: ranAt, planted, ...aggregate });
    return { key, appended: r.appended };
  } catch (err) {
    noteReadError(`selfFactAggregate append for ${fact}`, err);
    console.warn(`[self-fact] aggregate NOT persisted for ${fact} (${key}): ${String(err).slice(0, 160)}`);
    return { key, appended: false };
  }
}
const shortKey = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 12);

/**
 * THE 7-DAY TREND OF A §14 ROW (REALIGNMENT §14 #3: repair autonomy RISING over 7 days). The aggregates persisted
 * above are the series; this is their reader. Per UTC day of the trailing TREND_DAYS (today included), the day's
 * latest observed run on this node gives share = checked / expected, where expected counts every item the ledger
 * holds and checked only the ones that met the row: an unjudged or pending item is in expected and never in checked,
 * so an unjudged day is never read as autonomous. A day with no observed run, or with nothing expected, has no share.
 * Fewer than TREND_DAYS days with a share is insufficient_data (no slope); otherwise the least-squares slope of share
 * over the day index reads rising (> 0), flat (0) or falling (< 0). Pure: the records are handed in.
 */
export const TREND_DAYS = 7;
export interface AggregateTrendDay { day: string; ran_at: string | null; checked: number | null; expected: number | null; share: number | null }
export interface AggregateTrend { fact: string; window_days: number; trend: "rising" | "flat" | "falling" | "insufficient_data"; slope: number | null; days_with_share: number; days: AggregateTrendDay[]; reason: string }
export function aggregateTrend(records: readonly LedgerRow[], fact: string, node: string, nowMs: number): AggregateTrend {
  const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const latest = new Map<string, { ms: number; rec: Record<string, unknown> }>();
  for (const r of records) {
    const rec = r.record;
    if (rec["fact"] !== fact || rec["node"] !== node || rec["observed"] !== true) continue;
    const ms = isoMs(rec["ran_at"] ?? r.at);
    if (ms === null || ms > nowMs) continue;
    const d = dayOf(ms);
    const prev = latest.get(d);
    if (!prev || prev.ms <= ms) latest.set(d, { ms, rec });
  }
  const days: AggregateTrendDay[] = [];
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    const d = dayOf(nowMs - i * 86_400_000);
    const hit = latest.get(d);
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const checked = hit ? num(hit.rec["checked"]) : null;
    const expected = hit ? num(hit.rec["expected"]) : null;
    days.push({ day: d, ran_at: hit ? new Date(hit.ms).toISOString() : null, checked, expected, share: checked !== null && expected !== null && expected > 0 ? checked / expected : null });
  }
  const pts = days.map((d, i) => ({ x: i, y: d.share })).filter((p): p is { x: number; y: number } => p.y !== null);
  const base = { fact, window_days: TREND_DAYS, days_with_share: pts.length, days };
  if (pts.length < TREND_DAYS) return { ...base, trend: "insufficient_data", slope: null, reason: `${pts.length} of ${TREND_DAYS} day(s) have an observed run with something expected` };
  const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const sxx = pts.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  const raw = pts.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0) / sxx;
  const slope = Math.abs(raw) < 1e-12 ? 0 : raw;
  return { ...base, trend: slope > 0 ? "rising" : slope < 0 ? "falling" : "flat", slope, reason: `least-squares slope of checked/expected per day over ${TREND_DAYS} days` };
}
/** The row's trend after this run's aggregate is appended, and its divergence when the share is falling. */
function rowTrend(deps: JudgementDeps, fact: string, nowMs: number, out: SelfFactDivergence[]): AggregateTrend {
  let records: LedgerRow[] = [];
  try { records = deps.ledger("selfFactAggregate"); } catch (err) { noteReadError(`selfFactAggregate series for ${fact}`, err); }
  const t = aggregateTrend(records, fact, thisNode(), nowMs);
  if (t.trend === "falling") {
    out.push({ fact, key: "trend-falling", source: "attemptLedger selfFactAggregate (this node's runs)", copy: `${fact} trend over ${TREND_DAYS} days`, detail: `${fact}'s checked/expected share is falling over ${TREND_DAYS} days (slope ${t.slope!.toFixed(4)} per day): ${t.days.map((d) => `${d.day} ${d.checked}/${d.expected}`).join(", ")}`, canary: false });
  }
  return t;
}

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
      // LIVENESS-ONLY control: it is built by the same function as the finding, so it cannot fail; it shows only that
      // this branch ran (so the row is not read as blind). The completion line (trust_rows_applicable/judged) is the
      // check here that can fail.
      if (canary) { const planted = unpinned(`${node}-planted`, { id: "planted" }); out.push({ ...planted, key: `${row.id}-canary`, copy: "planted copy", detail: `liveness-only control on node ${node} (cannot fail; shows the unpinned branch ran): a planted node holding ${shape} with no pinned value was reported unpinned`, canary: true }); }
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
  },  /**
   * REPAIR AUTONOMY (§14 #3): one judgement per gap with a lane landing in the landing ledger (or its spool) over the
   * row's window (see "repair_autonomy and lane_revert_within_1h" above). The finding filed is the ledger landings the
   * instrument could not judge; the counts are the measurement. An absent ledger file or spool is UNOBSERVED, never an
   * empty ledger. Must-fail control: an operator-armed gap with a verified landing, judged by the same function, reads
   * not_counted (failing_link operator_act:arm) while its system-armed twin counts.
   */
  repair_autonomy: async (canary, row) => {
    const fact = row.id;
    const deps = judgementDeps;
    const nowMs = deps.now();
    const hours = typeof row.window_hours === "number" && row.window_hours > 0 ? row.window_hours : 168;
    const out: SelfFactDivergence[] = [];
    // An unobserved run is persisted too: a gap in the series is part of the series.
    const unread = (note: string): SelfFactResult => { const aggregate: Record<string, unknown> = { observed: false, note, window_hours: hours }; aggregate["persisted"] = persistAggregate(deps, fact, new Date(nowMs).toISOString(), canary, aggregate); return { fact, source_read: false, copies_read: 0, divergences: out, note, aggregate, trend: rowTrend(deps, fact, nowMs, out) }; };
    const absent = (["attemptIntent", "landingEvent", "attemptSettlement"] as const).filter((k) => !deps.ledgerPresent(k));
    if (absent.length > 0) return unread(`landing ledger file(s) absent: ${absent.join(", ")} (unknown is never an empty ledger)`);
    let landings: RepairLanding[];
    let unjudgeable: UnjudgeableLanding[];
    let settlements: LedgerRow[];
    try {
      const l = ledgerLandings(deps, nowMs - hours * 3600_000);
      if (!l.spool_readable) return unread("the landing spool is unreadable, so landings not yet ingested cannot be counted");
      landings = l.landings; unjudgeable = l.unjudgeable; settlements = deps.ledger("attemptSettlement");
    } catch (err) { noteReadError("landing ledger for repair_autonomy", err); return unread("landing ledger unreadable"); }
    let gaps: GapRow[];
    try { gaps = await deps.readGaps(); } catch (err) { noteReadError("gap store for repair_autonomy", err); return unread("gap store unreadable"); }
    const byId = new Map(gaps.map((g) => [String(g["id"] ?? ""), g] as [string, GapRow]));
    // link 5 and the S-2 answers: goal-host's dispatch records, read once for every closure this run judges.
    let dispatchStore: DispatchStoreEntry[] | null | undefined = undefined;
    if (deps.dispatches) { try { dispatchStore = await deps.dispatches(); } catch { dispatchStore = null; } }
    let keymap: KeyMapEntry[] | null = null;
    try { keymap = await deps.keymap(); } catch { keymap = null; }
    // The scope history is read once for every edit site this run judges.
    const sites = [...new Set(landings.map((l) => String(metaRec(byId.get(l.gap_id) ?? null)["edit_site"] ?? "")).filter((x) => x.length > 0))];
    const scopeBySite = sites.length > 0 ? await deps.scopeActs(sites) : new Map<string, ScopeAct[]>();
    const judgements: RepairJudgement[] = [];
    for (const l0 of landings) {
      // The authoring execution: the intent's, else the one the compose wrote later (attemptAuthoring.jsonl, through
      // attempt-register's reader). Still unknown: the closure is unattributable (judgeRepairClosure).
      let authoring = l0.authoring_execution_id;
      if (!authoring && deps.authoring) { try { authoring = await deps.authoring(l0.attempt_id); } catch { authoring = null; } }
      const l: RepairLanding = { ...l0, authoring_execution_id: authoring ?? null };
      const g = byId.get(l.gap_id) ?? null;
      const m = metaRec(g);
      const siteRaw = String(m["edit_site"] ?? "");
      const site = splitSite(siteRaw);
      const check = ownCheckFile(g);
      const siteDir = site ? deps.cloneOf(site.vessel) : null;
      // The fix is read in the EDIT SITE's clone only (link 3): a sha found elsewhere is not this fix.
      const fullSha = siteDir ? deps.revParse(siteDir, l.sha) ?? "" : "";
      const fixDir = siteDir && fullSha ? siteDir : null;
      const reg = settlements.filter((s) => s.record["attempt_id"] === l.attempt_id && s.record["verdict"] === "regressed").pop();
      // The filing time as the judge reads it; unknown means all history, never the window's start.
      const filed = (g ? String(g["first_detected_at"] ?? g["created_at"] ?? g["detected_at"] ?? "") : "") || "1970-01-01T00:00:00.000Z";
      const paths = [site?.path, check].filter((p): p is string => !!p);
      // Events of the row AND of each lineage ancestor; capped or not reaching the filing is incomplete.
      let events: Array<GapWriteEventLike & { source: "holder" }> | null = g ? [] : null;
      let capped = false;
      let fromFiling = false;
      if (g) {
        for (const id of [l.gap_id, ...lineageAncestors(l.gap_id, byId)]) {
          const r = await deps.readEvents(id);
          if (r === null) { events = null; break; }
          if (r.matched > r.events.length) capped = true;
          if (id === l.gap_id) fromFiling = r.events.some((e) => (e as { status_from?: unknown }).status_from === "absent" && String(e.outcome ?? "").startsWith("written"));
          events!.push(...r.events.map((e) => ({ ...e, gap_id: e.gap_id ?? id, source: "holder" as const })));
        }
      }
      // Labels for EVERY trace the reader considers (one list, provenanceTraceIds), not only the authoring execution.
      const traceIds = g ? provenanceTraceIds(g, l.authoring_execution_id ? [l.authoring_execution_id] : []) : [];
      let labelRead: Awaited<ReturnType<JudgementDeps["labels"]>> = null;
      try { labelRead = await deps.labels(traceIds); } catch { labelRead = null; }
      const j = judgeRepairClosure({
        landing: l, row: g, byId,
        regressed: reg ? { key: reg.key, source: String(reg.record["source"] ?? "settle_regressed"), at: String(reg.record["at"] ?? reg.at) } : null,
        reverts: fixDir ? deps.revertsOf(fixDir, fullSha) : null,
        fix: fixDir ? deps.fixCommit(fixDir, fullSha) : null,
        checkSource: fixDir && check ? deps.show(fixDir, fullSha, check) : null,
        siteSource: fixDir && site ? deps.show(fixDir, fullSha, site.path) : null,
        acts: {
          scopeActs: siteRaw ? (scopeBySite ? scopeBySite.get(siteRaw) ?? [] : null) : [],
          siteCommits: siteDir ? (paths.length > 0 ? deps.siteCommits(siteDir, paths, filed) : []) : null,
          checkFirstCommit: check ? (siteDir ? deps.firstCommit(siteDir, check) : null) : undefined,
          events, eventsCapped: capped, eventsFromFiling: fromFiling,
          labels: labelRead ? labelRead.labels : null, labelContext: labelRead ? labelRead.context : null,
          originPresent: false, keymap, peerKeys6: (keymap ?? []).filter((k) => k.owner_kind === "peer").map((k) => k.id.slice(0, 6)),
          ...(dispatchStore === undefined ? {} : { dispatches: dispatchStore, ...(await s2Inputs(deps, dispatchStore, l.gap_id, siteRaw)) }),
        },
        nowMs,
        authoringUnknown: !l.authoring_execution_id,
      });
      judgements.push(j);
      deps.log(judgementLine(j));
    }
    // Entries that may be landings but name no gap: expected, and unjudged (C).
    for (const u of unjudgeable) {
      const j: RepairJudgement = { fact: "repair_autonomy", gap_id: `ledger:${u.key}`, verdict: "unjudged", reason: u.reason, failing_links: [], arm_writer: "unread", operator_acts: null, fix_sha: u.sha ?? "", fix_repo: "", attempt_id: u.attempt_id ?? "", check: null, check_honest: { value: "unjudged", reason: "no gap" }, landing_verdict: { from: u.from, at: u.at }, durable_until: null, route_unverifiable: 0, window: { from: null, until: null } };
      judgements.push(j);
      deps.log(judgementLine(j));
    }
    const expectedN = landings.length + unjudgeable.length;
    const n = (v: RepairVerdict) => judgements.filter((j) => j.verdict === v).length;
    const aggregate: Record<string, unknown> = { observed: true, checked: n("counted"), expected: expectedN, judged: judgements.length - n("unjudged"), counted: n("counted"), not_counted: n("not_counted"), pending: n("pending"), unjudged: n("unjudged"), window_hours: hours, keymap: keymap === null ? "none served (key-principal writes unattributable)" : `${keymap.length} key(s)` };
    if (n("unjudged") > 0) {
      const which = judgements.filter((j) => j.verdict === "unjudged");
      out.push({ fact, key: "unjudged-landings", source: "landing ledger (lane landings in the window)", copy: "repair_autonomy judgements", detail: `${which.length} of ${expectedN} ledger landing(s) over ${hours}h could not be judged, so checked == expected cannot be read for them: ${which.slice(0, 4).map((j) => `${j.gap_id.slice(0, 60)} (${j.reason.slice(0, 100)})`).join("; ")}`, canary: false });
    }
    aggregate["persisted"] = persistAggregate(deps, fact, new Date(nowMs).toISOString(), canary, aggregate);
    let controls: RepairJudgement[] = [];
    if (canary) {
      const mf = judgeRepairClosure(repairControlInputs(nowMs, true));
      const pos = judgeRepairClosure(repairControlInputs(nowMs, false));
      controls = [mf, pos];
      for (const c of controls) deps.log(judgementLine(c));
      if (mf.verdict === "not_counted" && mf.failing_link === "operator_act:arm" && pos.verdict === "counted") {
        out.push({ fact, key: `${row.id}-canary`, source: REPAIR_MUST_FAIL_ID, copy: "judgeRepairClosure", detail: "must-fail control: an operator-armed gap with a verified landing read not_counted (operator_act:arm) and its system-armed twin counted", canary: true });
      }
    }
    const trend = rowTrend(deps, fact, nowMs, out);
    return { fact, source_read: true, copies_read: expectedN, divergences: out, judgements, aggregate, controls, trend,
      note: `${expectedN} ledger landing(s) over ${hours}h: counted=${n("counted")} not_counted=${n("not_counted")} pending=${n("pending")} unjudged=${n("unjudged")}; checked ${n("counted")} of expected ${expectedN}` };
  },
  /**
   * LANE REVERT WITHIN 1 H (§14 #6, §7 step 5 exit): one judgement per regressed settlement in the landing ledger over
   * the row's window, plus every settlement whose red divergence is still open. Green only on an observed lane revert
   * on origin/dev; everything else keeps its divergence, so a red settlement's gap closes only on that revert (aging out
   * of the window reads "expired unreverted" and stays red). Must-fail control: a regressed settlement with no revert
   * reads red (and a timely lane revert naming the sha green, a late, sha-less or expired one red).
   */
  lane_revert_within_1h: async (canary, row) => {
    const fact = row.id;
    const deps = judgementDeps;
    const nowMs = deps.now();
    const hours = typeof row.window_hours === "number" && row.window_hours > 0 ? row.window_hours : 168;
    const windowStart = nowMs - hours * 3600_000;
    const out: SelfFactDivergence[] = [];
    const unread = (note: string): SelfFactResult => { const aggregate: Record<string, unknown> = { observed: false, note, window_hours: hours }; aggregate["persisted"] = persistAggregate(deps, fact, new Date(nowMs).toISOString(), canary, aggregate); return { fact, source_read: false, copies_read: 0, divergences: out, note, aggregate, trend: rowTrend(deps, fact, nowMs, out) }; };
    if (!deps.ledgerPresent("attemptSettlement")) return unread("landing ledger file absent: attemptSettlement (unknown is never an empty ledger)");
    let all: Map<string, RegressedSettlement>;
    let marks: LedgerRow[];
    try { all = ledgerRegressedSettlements(deps); marks = deps.ledger("attemptRevert"); } catch (err) {
      noteReadError("landing ledger for lane_revert_within_1h", err);
      return unread("landing ledger unreadable");
    }
    // Settlements whose red divergence is still open are judged whatever their age (they close only on a revert).
    let gaps: GapRow[];
    try { gaps = await deps.readGaps(); } catch (err) { noteReadError("gap store for lane_revert_within_1h", err); return unread("gap store unreadable, so open red settlements cannot be carried"); }
    const carriedKeys = new Set<string>();
    for (const g of gaps) {
      const m = metaRec(g);
      if (String(g["status"] ?? "") !== "open" || m["detector"] !== SELF_FACT_RECONCILE_ID || m["fact"] !== fact) continue;
      const k = String(m["divergence_key"] ?? "");
      if (k.startsWith("settlement-")) carriedKeys.add(k.slice("settlement-".length));
    }
    const inWindow = [...all.values()].filter((s) => { const t = isoMs(s.at); return t === null || t >= windowStart; });
    const keys = new Set([...inWindow.map((s) => s.key), ...carriedKeys]);
    const judgements: LaneRevertJudgement[] = [];
    let expected = 0;
    for (const key of [...keys].sort()) {
      const carried = carriedKeys.has(key);
      const s = all.get(key);
      let j: LaneRevertJudgement;
      if (!s) {
        j = { fact: "lane_revert_within_1h", settlement_id: key, gap_id: "", regressed_sha: "", regressed_repo: null, regressed_at: null, source: "?", revert_sha: null, revert_at: null, revert_names_sha: false, lag_s: null, verdict: "red", reason: "the settlement record is no longer in the ledger and no revert was observed: it stays red", carried };
      } else {
        if (!carried || inWindow.includes(s)) expected += 1;
        const loc = s.sha ? deps.locate(s.sha) : null;
        let reverts = loc ? deps.revertsOf(loc.dir, loc.fullSha) : null;
        // The auto-revert's own marker names its commit even when that commit's message does not name the sha.
        const mark = marks.filter((r) => r.record["reverted_attempt_id"] === s.attempt_id && typeof r.record["revert_sha"] === "string").pop();
        if (loc && reverts && mark && !reverts.some((r) => r.sha.startsWith(String(mark.record["revert_sha"])))) {
          const c = deps.commit(loc.dir, String(mark.record["revert_sha"]));
          if (c) reverts = [...reverts, c];
        }
        j = judgeLaneRevert(s, loc?.repo ?? null, loc?.fullSha ?? null, reverts, nowMs, windowStart, carried);
      }
      judgements.push(j);
      deps.log(judgementLine(j));
      // A red settlement is filed; a carried one keeps its divergence until a revert is OBSERVED (green), whatever else
      // this run could or could not read.
      if (j.verdict === "red" || (carried && j.verdict !== "green")) {
        out.push({ fact, key: `settlement-${key}`, source: `attemptSettlement ${key} (${j.source})`, copy: j.regressed_repo ? `${j.regressed_repo} clone (origin/dev)` : "vessel clones", detail: `regressed settlement ${key} of ${j.regressed_sha.slice(0, 12) || "?"} (gap ${j.gap_id.slice(0, 80) || "?"}) at ${j.regressed_at ?? "?"}: ${j.reason}${carried && j.verdict !== "red" ? ` (verdict ${j.verdict}; kept open until a revert is observed)` : ""}`, canary: false });
      }
    }
    const n = (v: LaneRevertVerdict) => judgements.filter((j) => j.verdict === v).length;
    const aggregate: Record<string, unknown> = { observed: true, checked: judgements.filter((j) => j.verdict === "green" && !(j.carried && !inWindow.some((s) => s.key === j.settlement_id))).length, expected, green: n("green"), red: n("red"), pending: n("pending"), unjudged: n("unjudged"), carried: carriedKeys.size, window_hours: hours };
    const fresh = judgements.filter((j) => j.verdict === "unjudged" && !j.carried);
    if (fresh.length > 0) {
      out.push({ fact, key: "unjudged-settlements", source: "landing ledger (regressed settlements in the window)", copy: "vessel clones", detail: `${fresh.length} regressed settlement(s) could not be judged: ${fresh.slice(0, 4).map((j) => `${j.settlement_id} (${j.reason.slice(0, 100)})`).join("; ")}`, canary: false });
    }
    aggregate["persisted"] = persistAggregate(deps, fact, new Date(nowMs).toISOString(), canary, aggregate);
    let controls: LaneRevertJudgement[] = [];
    if (canary) {
      const cs = laneRevertControls(nowMs);
      controls = cs.map((c) => ({ ...c.j, settlement_id: c.name }));
      for (const c of controls) deps.log(judgementLine(c));
      if (cs.every((c) => c.j.verdict === c.want)) out.push({ fact, key: `${row.id}-canary`, source: LANE_REVERT_MUST_FAIL_ID, copy: "judgeLaneRevert", detail: "must-fail control: a regressed settlement with no revert read red; a timely lane revert naming the sha read green, a late, a sha-less and an expired-unreverted one red", canary: true });
    }
    const trend = rowTrend(deps, fact, nowMs, out);
    return { fact, source_read: true, copies_read: keys.size, divergences: out, judgements, aggregate, controls, trend,
      note: `${keys.size} regressed settlement(s) (${carriedKeys.size} carried open) over ${hours}h: green=${n("green")} red=${n("red")} pending=${n("pending")} unjudged=${n("unjudged")}; checked ${String(aggregate["checked"])} of expected ${expected}` };
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

// The fact a trust-root completion finding is filed under (not a row: every run computes it).
const TRUST_COMPLETION_FACT = "trust_root_completion";

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
  // Which trust-root pin rows this node must judge: every pool_record_pin row in its profile whose shape it HOLDS,
  // read here independently of the row filter below (an unreadable store counts as held: the row reports it).
  const heldPinRows = new Set<SelfFactRow>();
  {
    const heldByShape = new Map<string, boolean>();
    for (const r of rows ?? []) {
      if (!profileOk(r) || r.instrument !== "pool_record_pin" || typeof r.pool_shape !== "string" || r.pool_shape.length === 0) continue;
      if (!heldByShape.has(r.pool_shape)) {
        let held = true;
        try { held = (await poolPinDeps.readNewest(r.pool_shape)) !== null; } catch { held = true; }
        heldByShape.set(r.pool_shape, held);
      }
      if (heldByShape.get(r.pool_shape)) heldPinRows.add(r);
    }
  }
  const pinnedHere = (r: SelfFactRow) => !!r.expected_by_node && Object.prototype.hasOwnProperty.call(r.expected_by_node, thisNode());
  const unpinnedHolders = new Set([...heldPinRows].filter((r) => !nodeListed(r) && !pinnedHere(r)));
  const inScope = (rows ?? []).filter((r) => profileOk(r) && (nodeListed(r) || unpinnedHolders.has(r)));
  const unregistered = inScope.filter((r) => !(r.instrument in FACTS)).map((r) => r.id);
  const runnable = inScope.filter((r) => r.instrument in FACTS);
  // A per-node predicate asked of another node checks nothing here: no rows run, the run is unobserved (null).
  const foreignNode = typeof pointer.node === "string" && pointer.node.length > 0 && pointer.node !== thisNode();
  // The completion check (a fact of its own) needs every held pin row run, so asking for it runs them too.
  const completionAsked = !foreignNode && rows !== null && (!Array.isArray(pointer.facts) || pointer.facts.length === 0 || pointer.facts.includes(TRUST_COMPLETION_FACT));
  const wanted = foreignNode ? [] : (Array.isArray(pointer.facts) && pointer.facts.length > 0 ? runnable.filter((r) => pointer.facts!.includes(r.id) || (completionAsked && heldPinRows.has(r))) : runnable).map((r) => r.id);
  // Keyed by instrument and by row id (journal_pattern reports under its row id), so rows sharing an instrument
  // keep their own edit sites.
  rowEditSite = Object.fromEntries(runnable.flatMap((r) => [[r.instrument, r.edit_site], [r.id, r.edit_site]]));
  rowLinkedGap = Object.fromEntries(runnable.filter((r) => typeof r.linked_gap === "string" && r.linked_gap.length > 0).map((r) => [r.id, r.linked_gap as string]));
  // EVERY row runs its must-fail control (the canary) on every planted run, so one
  // blind instrument cannot hide behind another row's canary.
  const results: SelfFactResult[] = [];
  for (const id of wanted) { const row = runnable.find((r) => r.id === id)!; results.push(await FACTS[row.instrument]!(plant, row)); }
  const all = results.flatMap((r) => r.divergences);
  // TRUST-ROOT COMPLETION: applicable = held pin rows; judged = those this run read. Fewer judged than applicable
  // (a row a filter dropped, or one read unobserved) leaves a trust root unguarded here: <node>-unjudged.
  const trustCompletion = completionAsked ? (() => {
    const applicable = [...heldPinRows].map((r) => r.id);
    const judged = applicable.filter((id) => results.some((x) => x.fact === id && x.source_read));
    return { node: thisNode(), applicable, judged, unjudged: applicable.filter((id) => !judged.includes(id)) };
  })() : null;
  if (trustCompletion && trustCompletion.unjudged.length > 0) {
    all.push({ fact: TRUST_COMPLETION_FACT, key: `${trustCompletion.node}-unjudged`, node: trustCompletion.node, source: "pool_record_pin rows in this node's profile whose shape it holds", copy: `this self-fact run on ${trustCompletion.node}`, detail: `node ${trustCompletion.node} holds the pinned shape of ${trustCompletion.applicable.length} trust-root pin row(s) but judged ${trustCompletion.judged.length}; unjudged: ${trustCompletion.unjudged.join(", ")} (dropped by a row filter or read unobserved), so those trust roots are unguarded on this node`, canary: false });
  }
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
    if (trustCompletion) console.log(`[self-fact] completion: thisNode=${trustCompletion.node} trust_rows_applicable=${trustCompletion.applicable.length} judged=${trustCompletion.judged.length}`);
  }
  const canaryFact = blindRows.join(", ");
  // Key scoping: a per-gap predicate asks about ONE (fact, key); everything else is
  // not this gap's business, so it must not keep the gap open.
  // (Asked about the completion fact alone, the held pin rows run too; the key still scopes to the one finding.)
  const keyed = typeof pointer.key === "string" && pointer.key.length > 0 && (wanted.length === 1 || (Array.isArray(pointer.facts) && pointer.facts.length === 1 && pointer.facts[0] === TRUST_COMPLETION_FACT));
  const real = all.filter((d) => !d.canary && (!keyed || d.key === pointer.key));
  // Zero rows checked is not an observation: a node with nothing in scope says so.
  // Asked about the completion fact alone, the completion count IS the measurement (it read the store for every
  // pin row itself), so a dropped row (no result) or an unobserved one still reads present, never unknown.
  const completionOnly = Array.isArray(pointer.facts) && pointer.facts.length === 1 && pointer.facts[0] === TRUST_COMPLETION_FACT;
  const observed = completionOnly ? trustCompletion !== null && canaryFound : results.length > 0 && results.every((r) => r.source_read) && canaryFound;
  let filed = 0;
  let closed = 0;
  let selfGap = false;
  if (plant && rows === null) {
    // No rows, no instruments ran: say so about ITSELF; there is no built-in fallback.
    await fileDivergence({ fact: "self_fact_reconcile", key: "rows-unreadable", source: rowsSource, copy: superRepoRoot(), detail: `the self-fact rows could not be read from ${rowsSource} (${readErrors[readErrors.length - 1] ?? "unknown"}) — no row ran, so this run is not evidence`, canary: false });
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
    closed = await closeResolved([...wanted.filter((id) => readFacts.has(id)), ...(trustCompletion ? [TRUST_COMPLETION_FACT] : [])], real);
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
      facts_checked: results.map((r) => ({ fact: r.fact, source_read: r.source_read, copies_read: r.copies_read, divergences: r.divergences.filter((d) => !d.canary).length, note: r.note, ...(r.aggregate ? { aggregate: r.aggregate } : {}) })),
      // Per-item judgements by fact (repair_autonomy, lane_revert_within_1h), and the must-fail controls' own.
      judgements: Object.fromEntries(results.filter((r) => Array.isArray(r.judgements)).map((r) => [r.fact, r.judgements])),
      must_fail_controls: Object.fromEntries(results.filter((r) => Array.isArray(r.controls) && r.controls.length > 0).map((r) => [r.fact, r.controls])),
      // Each §14 row's 7-day trend over its persisted aggregates (aggregateTrend).
      trends: Object.fromEntries(results.filter((r) => r.trend).map((r) => [r.fact, r.trend])),
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
      trust_completion: trustCompletion,
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
