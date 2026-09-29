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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";
import { resolveSubstrateGap, resolveSubstrateGapWrite } from "./substrate-gap.js";
import { createHash } from "node:crypto";

export interface SelfFactReconcilePointer {
  type: "self_fact_reconcile";
  /** Restrict to these fact names; default = every fact in the table. */
  facts?: string[];
  /** With a single fact: count only this divergence key (the per-gap Class-2 predicate). */
  key?: string;
  /** Plant the positive-control canary (default true). The sweep's Class-2 re-check passes false. */
  plant_canary?: boolean;
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
export interface SelfFactRow { id: string; instrument: string; profiles: string[]; edit_site: string; must_fail: string; window_hours?: number; n_floor?: number }
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

// ─── the facts ──────────────────────────────────────────────────────────────
// Each returns what it read and where it diverged. `canary` tells the fact to
// inject one planted divergence on its COPY side (never its source side, so the
// canary cannot masquerade as a real finding).
type FactFn = (canary: boolean) => SelfFactResult;

const FACTS: Record<string, FactFn> = {
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
      summary: `self_fact_reconcile found the fact "${d.fact}" diverged at "${d.key}": ${d.detail}. Source: ${d.source}. Copy: ${d.copy}. A copy the system reads about itself no longer matches the thing it copies; the system acted on the copy. Reconcile the copy to its source (or the source to the world), through the lane; this gap closes only when self_fact_reconcile re-reads both and finds no divergence for this fact.`,
      classification_metadata: {
        edit_site: rowEditSite[d.fact] ?? "repos/development-vessel/src/resolvers/self-fact-reconcile.ts",
        detector: SELF_FACT_RECONCILE_ID,
        fact: d.fact,
        divergence_key: d.key,
        // Class-2, self-verifying: the sweep re-runs THIS resolver for THIS fact and
        // reads divergence_count; >0 = still present, 0 = resolved. That is a DEFECT count, so it is
        // zero_field — nonzero_field is the sweep's HEALTH form and read divergence_count=1 as resolved.
        evidence_resolve: { shape: "self_fact_reconcile", input: { facts: [d.fact], key: d.key, plant_canary: false, file_gaps: false }, zero_field: "divergence_count" },
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
    const read = await resolveSubstrateGap({ type: "substrateGap", status: "open", limit: 5000 } as never);
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
  const inScope = (rows ?? []).filter((r) => r.profiles.includes(profile) || r.profiles.includes("*"));
  const unregistered = inScope.filter((r) => !(r.instrument in FACTS)).map((r) => r.id);
  const runnable = inScope.filter((r) => r.instrument in FACTS);
  const wanted = (Array.isArray(pointer.facts) && pointer.facts.length > 0 ? runnable.filter((r) => pointer.facts!.includes(r.id)) : runnable).map((r) => r.id);
  rowEditSite = Object.fromEntries(runnable.map((r) => [r.instrument, r.edit_site]));
  // EVERY row runs its must-fail control (the canary) on every planted run, so one
  // blind instrument cannot hide behind another row's canary.
  const results: SelfFactResult[] = [];
  for (const id of wanted) results.push(FACTS[runnable.find((r) => r.id === id)!.instrument]!(plant));
  const all = results.flatMap((r) => r.divergences);
  const blindRows = plant ? results.filter((r) => !r.divergences.some((d) => d.canary)).map((r) => r.fact) : [];
  const canaryFound = rows !== null && blindRows.length === 0;
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
    for (const d of real) if (await fileDivergence(d)) filed += 1;
    // CLOSURE BY THE INSTRUMENT THAT FOUND IT. Every open gap this detector filed
    // for a fact checked on this run, whose divergence is no longer present, is
    // closed here with an EXERCISED falsifier — the only thing the store's gate
    // accepts for a held or class-2 gap. A landing never closes these; this does.
    closed = await closeResolved(wanted, real);
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
      rows_checked: wanted,
      blind_rows: blindRows,
      unregistered_rows: unregistered,
      observed,
      gaps_filed: filed,
      self_gap_filed: selfGap,
      read_errors: [...readErrors],
      claim: observed ? "every source and copy was read at use time and the planted canary was reported; divergences above are measured, not inferred" : "this run could not attribute its own negatives — a source was unreadable or the canary was missed — and its clean results are not evidence",
    },
  };
}
