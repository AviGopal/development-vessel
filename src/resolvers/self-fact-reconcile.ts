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
 * v1 carries its (fact, source, copies) table IN CODE. The instance-as-impulse
 * form — a `selfFactSpec` shape the tick reads so a new pair is data, not a
 * commit — is the next instance of this class, not this one. The table is small
 * and every entry names its source and its copies so that migration is mechanical.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";
import { resolveSubstrateGapWrite } from "./substrate-gap.js";

export interface SelfFactReconcilePointer {
  type: "self_fact_reconcile";
  /** Restrict to these fact names; default = every fact in the table. */
  facts?: string[];
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
        const tsconfig = join(root, "tsconfig.json");
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
const EDIT_SITE: Record<string, string> = {
  fleet_inventory_copy: "repos/development-vessel/src/resolvers/pull-cutover.ts",
  authoring_root: "repos/development-vessel/src/resolvers/patch-with-tools.ts",
  manifest_checkout_lag: "repos/development-vessel/src/resolvers/pull-cutover.ts",
  lane_coverage: "repos/development-vessel/src/resolvers/feature-compose.ts",
};
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
        edit_site: EDIT_SITE[d.fact] ?? "repos/development-vessel/src/resolvers/self-fact-reconcile.ts",
        detector: SELF_FACT_RECONCILE_ID,
        fact: d.fact,
        divergence_key: d.key,
        // Class-2, self-verifying: the sweep re-runs THIS resolver for THIS fact and
        // reads divergence_count; >0 = still present, 0 = resolved.
        evidence_resolve: { shape: "self_fact_reconcile", input: { facts: [d.fact], plant_canary: false, file_gaps: false }, nonzero_field: "divergence_count" },
        falsifier: `class 2: self_fact_reconcile with facts=[${d.fact}] reports divergence_count 0 for key ${d.key}`,
      },
    },
  });
  return res.shape !== "structuredError";
}

// ─── the resolver ───────────────────────────────────────────────────────────
export async function resolveSelfFactReconcile(pointer: SelfFactReconcilePointer): Promise<ResolverResult> {
  const wanted = Array.isArray(pointer.facts) && pointer.facts.length > 0 ? pointer.facts.filter((f) => f in FACTS) : Object.keys(FACTS);
  const plant = pointer.plant_canary !== false;
  const file = pointer.file_gaps !== false;
  const ranAt = new Date().toISOString();
  readErrors.length = 0;
  // The canary rides on the LAST fact run, so a fact-restricted re-check still carries one when asked.
  const canaryFact = wanted[wanted.length - 1];
  const results: SelfFactResult[] = [];
  for (const f of wanted) results.push(FACTS[f]!(plant && f === canaryFact));
  const all = results.flatMap((r) => r.divergences);
  const canaryFound = !plant || all.some((d) => d.canary);
  const real = all.filter((d) => !d.canary);
  const observed = results.every((r) => r.source_read) && canaryFound;
  let filed = 0;
  let selfGap = false;
  if (plant && !canaryFound) {
    // The instrument cannot see: say so about ITSELF and file nothing else.
    selfGap = await fileDivergence({ fact: "self_fact_reconcile", key: "canary-not-found", source: "planted canary", copy: "this run", detail: `the planted canary on fact ${canaryFact} was not reported — clean results from this instrument are not evidence until this is fixed`, canary: false });
  } else if (file) {
    for (const d of real) if (await fileDivergence(d)) filed += 1;
  }
  return {
    shape: "selfFactReconcileReport",
    body: {
      detector: SELF_FACT_RECONCILE_ID,
      ran_at: ranAt,
      facts_checked: results.map((r) => ({ fact: r.fact, source_read: r.source_read, copies_read: r.copies_read, divergences: r.divergences.filter((d) => !d.canary).length, note: r.note })),
      divergence_count: real.length,
      divergences: real,
      canary_planted: plant,
      canary_found: canaryFound,
      observed,
      gaps_filed: filed,
      self_gap_filed: selfGap,
      read_errors: [...readErrors],
      claim: observed ? "every source and copy was read at use time and the planted canary was reported; divergences above are measured, not inferred" : "this run could not attribute its own negatives — a source was unreadable or the canary was missed — and its clean results are not evidence",
    },
  };
}
