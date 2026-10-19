import { METABOB_ENDPOINT, METABOB_API_KEY, WORKSPACE_ROOT } from "../config.js";
import type { ResolverResult } from "./types.js";
import { readdir, readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fetchWithRetry } from "./http-retry.js";
import { isMetaTemplate } from "../lib/meta-templates.js";
import { resolveDiscoveryVesselRegistryObserver } from "./discovery-vessel-registry-observer.js";
import { resolveSubstrateGapWrite } from "./substrate-gap.js";
import { readTuningNumber } from "../judge/gap-policy.js";

export interface SubstrateHealthTickPointer {
  type: "substrate_health_tick";
  lookback_window_seconds?: number;
  // Operator-tunable thresholds (defaults match spec §G table)
  confidence_floor?: number;           // default 10 (α+β)
  confidence_ratio_threshold?: number; // default 0.25
  confidence_min_pairs?: number;       // default 8 — below this the ratio is UNMEASURED (null), not false
  stability_rate_ceiling?: number;     // default 1.0 per hour
  optimality_ratio_ceiling?: number;   // default 2.0
  // Ticks a running vessel may stay absent from discovery before ONE gap is filed. Pointer first,
  // then the tuning row substrate_health.unregistered_alarm_ticks, else 3.
  unregistered_alarm_ticks?: number;
  inventory_path?: string;             // default <WORKSPACE_ROOT>/substrate/fleet/vessels.inventory.json
}

interface VariantMetrics {
  id: string;
  activity_template_id?: string;
  thompson_alpha?: number;
  thompson_beta?: number;
  sample_size?: number;
}

interface Template {
  id: string;
  created_at?: string;
  proposed?: boolean;
}

interface CompositionEdge {
  from_activity: string;
  via_shape: string;
  to_activity: string;
  created_at?: string;
}

interface HarnessReport {
  mean_optimality_ratio?: number;
  run_at?: string;
  generated_at?: string;
}

// Persistent daemon vessels whose systemd unit must be "active".
//
// DERIVED FROM THE INVENTORY (vessel set = placement), the way validation/scripts/vessel-secrets-dropin.test.sh
// derives its universe: every inventory row with a repo, a .service unit and a health port, not retired. The hand
// list below is only the fallback when the deployed inventory cannot be read, and the report says which was used.
// A unit that is not active is DOWN only when it is placed here; one this node's profile leaves out (disabled,
// masked, not installed) is not_placed, since a spoke legitimately runs no copy of what its hub owns.
// boredom-vessel stays out by construction: Type=oneshot under a timer, no health port. Its liveness is captured
// by the execution traces it produces, not by a persistent service status.
const FALLBACK_SUBSTRATE_VESSELS = [
  "activity-api",
  "development-vessel",
  "discovery-vessel",
  "identity-vessel",
  "goal-host-vessel",
  "llm-resolver-vessel",
  "local-tools-vessel",
  "ribosome-vessel",
  "concept-db",
] as const;

export interface DaemonVessel {
  /** Unit name without ".service"; the key of vessel_liveness.statuses. */
  name: string;
  repo: string;
  /**
   * Expected to hold a discovery record. False for the registry itself (role "registry") and for a row that
   * declares `"registers": false`: a vessel that serves no shape has nothing to advertise and does not register.
   */
  registers: boolean;
}

/** The daemon vessel set from a parsed inventory, or null when it names none. Pure. */
export function daemonVesselsFromInventory(raw: unknown): DaemonVessel[] | null {
  const rows = (raw as { vessels?: unknown } | null)?.vessels;
  if (!Array.isArray(rows)) return null;
  const out: DaemonVessel[] = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    const unit = typeof r?.unit === "string" ? r.unit : "";
    if (!unit.endsWith(".service") || typeof r.repo !== "string" || r.repo.length === 0) continue;
    if (typeof r.health_port !== "number" || r.retired === true) continue;
    out.push({ name: unit.slice(0, -".service".length), repo: r.repo, registers: r.registers !== false && r.role !== "registry" });
  }
  return out.length > 0 ? out : null;
}

type UnitState = { active: string; enabled: string };
type LivenessStatus = "active" | "inactive" | "not_placed" | "unknown";
// is-enabled answers for a unit this node does not run: the profile masked or disabled it, or it is not installed.
const NOT_PLACED = new Set(["disabled", "masked", "masked-runtime", "not-found", ""]);

async function systemctlOut(args: string[]): Promise<string> {
  const proc = Bun.spawn(["systemctl", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out;
}
async function systemctlUnitState(unit: string): Promise<UnitState> {
  const active = await systemctlOut(["is-active", unit]);
  return { active, enabled: active === "active" ? "" : await systemctlOut(["is-enabled", unit]) };
}

async function checkVesselLiveness(vessels: readonly string[], unitState: (unit: string) => Promise<UnitState>): Promise<{
  statuses: Record<string, LivenessStatus>;
  down: string[];
}> {
  const statuses: Record<string, LivenessStatus> = {};
  const down: string[] = [];
  await Promise.all(
    vessels.map(async (vessel) => {
      try {
        const st = await unitState(`${vessel}.service`);
        const status: LivenessStatus = st.active === "active" ? "active" : NOT_PLACED.has(st.enabled) ? "not_placed" : "inactive";
        statuses[vessel] = status;
        if (status === "inactive") down.push(vessel);
      } catch {
        statuses[vessel] = "unknown";
        down.push(vessel);
      }
    }),
  );
  return { statuses, down };
}

// ─── Running but unregistered ──────────────────────────────────────────────────────────────────────────────────────
// A vessel whose unit is active but which holds no discovery record is unreachable by routing, and nothing said so:
// the ribosome logged a refused /register every minute for days while every liveness view read it as healthy. This
// tick already knows which vessels run here, so it compares that set against discovery's registry (read through
// discovery_vessel_registry_observer) and files ONE gap per vessel once it has been absent for N consecutive ticks.
//
// MATCH RULE. Registry ids are not unit names (concept-db registers as concept-db-local, identity as
// identity-vessel-<host>), so a row matches a vessel when its id, before any "@<peer>" suffix, equals the vessel's
// repo or unit name or extends one with "-". A match only through "@"-suffixed rows is remote_only: a federated copy
// may be standing in for this node's own record, so it is reported and never alarmed on. The streak survives a dv
// restart in the heartbeat file this tick already writes.
export interface RegistrationJoin {
  registered: Record<string, string>;
  remote_only: Record<string, string>;
  unregistered: string[];
  not_expected: string[];
}
/** Join the running, registration-expected vessels against the registry's ids. Pure. */
export function registrationJoin(running: readonly DaemonVessel[], registryIds: readonly string[]): RegistrationJoin {
  const out: RegistrationJoin = { registered: {}, remote_only: {}, unregistered: [], not_expected: [] };
  for (const v of running) {
    if (!v.registers) { out.not_expected.push(v.name); continue; }
    const names = [...new Set([v.repo, v.name])];
    const hits = registryIds.filter((id) => {
      const base = id.split("@")[0] ?? "";
      return names.some((n) => base === n || base.startsWith(`${n}-`));
    });
    const local = hits.find((id) => !id.includes("@"));
    if (local) out.registered[v.name] = local;
    else if (hits.length > 0) out.remote_only[v.name] = hits[0]!;
    else out.unregistered.push(v.name);
  }
  out.unregistered.sort();
  out.not_expected.sort();
  return out;
}
/**
 * Next per-vessel streaks of consecutive unregistered ticks, and the vessels that crossed `alarmTicks` on THIS tick
 * (exactly once per episode; registering resets it). An unmeasured tick (null) leaves the streaks as they were. Pure.
 */
export function advanceUnregisteredTicks(prev: Record<string, number>, unregistered: readonly string[] | null, alarmTicks: number): { ticks: Record<string, number>; alarm: string[] } {
  if (unregistered === null) return { ticks: { ...prev }, alarm: [] };
  const ticks: Record<string, number> = {};
  const alarm: string[] = [];
  for (const v of unregistered) {
    const before = typeof prev[v] === "number" && Number.isFinite(prev[v]) ? prev[v]! : 0;
    ticks[v] = before + 1;
    if (ticks[v]! >= alarmTicks && before < alarmTicks) alarm.push(v);
  }
  return { ticks, alarm };
}

async function lastRegisterFailure(unit: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["journalctl", "--no-pager", "-o", "cat", "-u", unit, "--since", "-30min"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const line = out.split("\n").filter((l) => l.includes("register failed")).pop();
    return line ? line.trim().slice(0, 400) : null;
  } catch { return null; }
}

async function registryIdsLive(): Promise<string[] | null> {
  const r = await resolveDiscoveryVesselRegistryObserver({ type: "discovery_vessel_registry_observer" });
  const b = r.body as { reachable?: boolean; per_vessel?: Array<{ vessel_id?: unknown }> };
  if (b?.reachable !== true || !Array.isArray(b.per_vessel)) return null;
  return b.per_vessel.map((v) => String(v.vessel_id ?? "")).filter((id) => id.length > 0);
}

async function readJsonFile(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf-8")); } catch { return null; }
}

interface TickDeps {
  unitState: (unit: string) => Promise<UnitState>;
  registryIds: () => Promise<string[] | null>;
  lastRegisterFailure: (unit: string) => Promise<string | null>;
  alarmTicks: () => Promise<number | null>;
  writeGap: (pointer: Record<string, unknown>) => Promise<unknown>;
  heartbeatPath: () => string;
}
const liveDeps: TickDeps = {
  unitState: systemctlUnitState,
  registryIds: registryIdsLive,
  lastRegisterFailure,
  alarmTicks: () => readTuningNumber("substrate_health.unregistered_alarm_ticks"),
  writeGap: (pointer) => resolveSubstrateGapWrite(pointer),
  heartbeatPath: () => join(WORKSPACE_ROOT, "substrate-heartbeat.json"),
};
let tickDeps: TickDeps = liveDeps;
/** Tests only: replace the systemctl, registry, journal, tuning, gap-write and heartbeat-file edges (null restores them). */
export function __setSubstrateHealthTickDepsForTests(d: Partial<TickDeps> | null): void {
  tickDeps = d ? { ...liveDeps, ...d } : liveDeps;
}

export const UNREGISTERED_GAP_PREFIX = "vessel-runs-but-is-not-registered-in-discovery-";

async function readMostRecentHarnessReport(workspace: string): Promise<HarnessReport | null> {
  const resultsDir = join(workspace, "validation", "results");
  let files: string[] = [];
  try {
    const entries = await readdir(resultsDir, { withFileTypes: true });
    files = entries
      .filter(e => e.isFile() && e.name.endsWith(".json") && e.name.includes("harness"))
      .map(e => e.name)
      .sort()
      .reverse(); // most recent first (lexicographic date prefix)
  } catch {
    return null;
  }
  for (const fname of files.slice(0, 5)) {
    try {
      const raw = await readFile(join(resultsDir, fname), "utf-8");
      const parsed = JSON.parse(raw) as HarnessReport;
      return parsed;
    } catch { /* try next */ }
  }
  return null;
}

async function checkVesselRegistration(
  derived: DaemonVessel[] | null,
  statuses: Record<string, LivenessStatus>,
  pointer: SubstrateHealthTickPointer,
  inventoryPath: string,
) {
  const prevBeat = (await readJsonFile(tickDeps.heartbeatPath())) as { unregistered_ticks?: Record<string, number> } | null;
  const prev = prevBeat?.unregistered_ticks && typeof prevBeat.unregistered_ticks === "object" ? prevBeat.unregistered_ticks : {};
  const tuned = typeof pointer.unregistered_alarm_ticks === "number" ? null : await tickDeps.alarmTicks().catch(() => null);
  const alarmTicks = typeof pointer.unregistered_alarm_ticks === "number" && pointer.unregistered_alarm_ticks >= 1
    ? { value: pointer.unregistered_alarm_ticks, source: "pointer" }
    : typeof tuned === "number" && tuned >= 1 ? { value: tuned, source: "tuning:substrate_health.unregistered_alarm_ticks" } : { value: 3, source: "default" };
  const ids = derived ? await tickDeps.registryIds().catch(() => null) : null;
  const running = (derived ?? []).filter((v) => statuses[v.name] === "active");
  const reg = ids ? registrationJoin(running, ids) : null;
  const { ticks, alarm } = advanceUnregisteredTicks(prev, reg ? reg.unregistered : null, alarmTicks.value);
  const filed: string[] = [];
  for (const name of alarm) {
    const v = running.find((r) => r.name === name);
    const reason = await tickDeps.lastRegisterFailure(`${name}.service`).catch(() => null);
    const id = `${UNREGISTERED_GAP_PREFIX}${name}`;
    try {
      await tickDeps.writeGap({
        type: "substrateGap_write",
        gap: {
          id,
          category: "systematic_failure",
          source: "substrate_detected",
          status: "open",
          detected_at: new Date().toISOString(),
          summary:
            `${name} is running (unit active) but has no discovery record for ${ticks[name]} consecutive substrate_health_tick runs, ` +
            `so no shape it serves is reachable by routing. ${reason ? `Its last refusal: ${reason}.` : "Its journal names no refused /register in the last 30 min."} ` +
            `If it serves no shape it should not register: declare "registers": false on its inventory row. Otherwise repair the registration it sends.`,
          classification_metadata: {
            vessel: name,
            repo: v?.repo ?? null,
            consecutive_ticks: ticks[name],
            alarm_ticks: alarmTicks,
            register_failure: reason,
            match_rule: "registry id (before @peer) equals the repo or unit name, or extends one with '-'",
            detector: "substrate_health_tick",
          },
        },
      });
      filed.push(id);
    } catch (err) {
      console.warn(`[substrate-health-tick] gap write FAILED for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    measured: reg !== null,
    ...(reg === null ? { unmeasured_reason: derived ? "discovery registry unreadable" : `inventory unreadable at ${inventoryPath}` } : {}),
    registered: reg?.registered ?? {},
    remote_only: reg?.remote_only ?? {},
    unregistered: reg?.unregistered ?? [],
    not_expected: reg?.not_expected ?? [],
    unregistered_ticks: ticks,
    alarm_ticks: alarmTicks,
    gaps_filed: filed,
  };
}

export async function resolveSubstrateHealthTick(
  pointer: SubstrateHealthTickPointer,
): Promise<ResolverResult> {
  const lookbackSecs = pointer.lookback_window_seconds ?? 3600;
  const since = new Date(Date.now() - lookbackSecs * 1000).toISOString();
  const auth = { Authorization: `ApiKey ${METABOB_API_KEY}` };

  const confidenceFloor = pointer.confidence_floor ?? 10;
  const confidenceRatioThreshold = pointer.confidence_ratio_threshold ?? 0.25;
  // MINIMUM SAMPLE (2026-08-29). The confidence ratio below is meaningless on a thin window, and
  // without a floor it moves in the WRONG DIRECTION as the substrate goes quiet. Measured on the
  // same unchanged system 4h apart, with no learning intervention between:
  //   01:11Z  total_pairs 17, pairs_above_floor 2  -> 0.12  FAIL
  //   05:00Z  total_pairs  4, pairs_above_floor 2  -> 0.50  PASS
  // The numerator never moved. The gate flipped because the DENOMINATOR COLLAPSED — fewer distinct
  // (state, activity) pairs exercised in the 1h window. The degenerate case is total_pairs 1 with
  // that pair above floor: 1/1 = a confident PASS on a single observation.
  //
  // That is not a metric nit. development-vessel/CLAUDE.md defines the S1->S2 lift as three
  // consecutive coverage_progress=true AND overall_passing=true, so an IDLE substrate manufactures
  // lift: the system certifies itself ready to advance BY DOING LESS. SUBSTRATE_AS_MDP.md §12.6
  // names exactly this class — a gameable reward converges on the wrong objective.
  const confidenceMinPairs = pointer.confidence_min_pairs ?? 8;
  // Ceiling of 10.0/hr: accommodates post-restart seed churn (bootstrap-seeder +
  // seed-templates both run on restart, producing ~20 template UPSERTs within seconds).
  // The 1.0/hr ceiling was too tight — it flagged normal operational maintenance as
  // instability. 10.0/hr still detects genuinely runaway ribosome/improviser scenarios
  // (which would produce dozens of templates per hour continuously).
  const stabilityRateCeiling = pointer.stability_rate_ceiling ?? 10.0;
  const optimalityRatioCeiling = pointer.optimality_ratio_ceiling ?? 2.0;

  // — Posterior confidence via execution trace counts —
  // Template records reset thompson_alpha/beta to 1 on every re-seed, so reading
  // from the templates list gives a misleading uniform prior. Instead, derive
  // approximate per-template posteriors from execution trace counts over the last
  // 30 days: alpha ≈ successes+1, beta ≈ failures+1, alpha+beta = total+2.
  // This source is stable across restarts and reflects real accumulated learning.
  const templates: Template[] = [];
  let offset = 0;
  const pageSize = 100;
  // Fetch the FULL catalogue. Prior bug: the `< 500` cap plus `break` on the
  // first short page truncated this — the corpus is ~1500 and the templates
  // endpoint intermittently returns a short first page under load, so the
  // detector emitted (lift-gate) verdicts over a sliver of reality. Loop until
  // the endpoint-reported `total` is fetched or a page is empty; a short page
  // is NOT a stop signal.
  let templatesTotal = Infinity;
  let fetchInterrupted = false;
  for (let guard = 0; templates.length < templatesTotal && guard < 100; guard++) {
    // Self-measurement must survive its OWN load. The topology chain fires this
    // resolver concurrently with the boredom loop; activity-api intermittently
    // drops connections under that contention. Use generous retries so a transient
    // blip on one page does NOT truncate the registry view — a truncated view
    // silently corrupts confidence + stability and flaps the lift verdict.
    const pageUrl = `${METABOB_ENDPOINT}/v2/activities/templates?limit=${pageSize}&offset=${offset}`;
    let r = await fetchWithRetry(pageUrl, { headers: auth }, { attempts: 6, baseDelayMs: 250 });
    if (!r || !r.ok) {
      // One page exhausting its retries used to abandon the WHOLE enumeration
      // (fetchInterrupted=true; break) — a single unlucky page during a boredom
      // burst marked the entire corpus incomplete and pinned the lift gate at
      // overall_passing=null indefinitely. Give the struggling offset a real
      // second chance in a calmer window (longer cooldown + more attempts)
      // before giving up on the entire measurement.
      await new Promise((res) => setTimeout(res, 3000));
      r = await fetchWithRetry(pageUrl, { headers: auth }, { attempts: 10, baseDelayMs: 500 });
    }
    if (!r || !r.ok) { fetchInterrupted = true; break; }
    const page = await r.json() as { templates?: Template[]; total?: number };
    if (typeof page.total === "number") templatesTotal = page.total;
    const rows = page.templates ?? [];
    if (rows.length === 0) break;
    templates.push(...rows);
    offset += rows.length;
  }
  // The corpus is COMPLETE only if the endpoint reported a total and we fetched
  // all of it without an interrupted page. An incomplete corpus means confidence
  // and stability were computed over a sliver — those dimensions are UNMEASURED,
  // not failing. Emitting a confident pass/fail over a truncated registry is the
  // self-misunderstanding defect this guard prevents.
  const corpus_complete = !fetchInterrupted && templatesTotal !== Infinity && templates.length >= templatesTotal;

  // Fetch recent traces (last 30 days) to build execution counts per template.
  const traceLookbackSince = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const traceCounts = new Map<string, { success: number; fail: number }>();
  let traceOffset = 0;
  while (traceOffset < 5000) {
    const r = await fetchWithRetry(
      `${METABOB_ENDPOINT}/v2/activities/execution-traces?limit=200&offset=${traceOffset}&since_iso=${encodeURIComponent(traceLookbackSince)}`,
      { headers: auth },
    );
    if (!r?.ok) break;
    const page = await r.json() as { executions?: { activity_id?: string; status?: string; success?: boolean }[] };
    const rows = page.executions ?? [];
    if (rows.length === 0) break;
    for (const t of rows) {
      const id = t.activity_id ?? "unknown";
      const entry = traceCounts.get(id) ?? { success: 0, fail: 0 };
      if (t.success === true || t.status === "success" || t.status === "completed") entry.success++;
      else entry.fail++;
      traceCounts.set(id, entry);
    }
    traceOffset += rows.length;
    if (rows.length < 200) break;
  }

  const variantPairs: { alpha: number; beta: number }[] = [];
  // Only include ACTIVE (non-proposed) templates in the confidence calculation.
  // Proposed templates are awaiting empirical evidence by design — including
  // them with uniform priors (α=1, β=1) dilutes the confidence ratio and makes
  // the substrate appear less confident than it actually is.
  const activeTemplates = templates.filter(t => !t.proposed);

  // Normalize IDs: activity:⟨foo⟩ → foo, or bare foo → foo.
  // Trace activity_ids mix both formats (e.g. 'validator-dispatch' bare vs
  // 'activity:⟨development-vessel:coverage-tick⟩' wrapped). Template IDs from
  // the API always include the wrapper. We strip the wrapper for comparison.
  const normalizeId = (id: string) => id.replace(/^activity:⟨(.+)⟩$/, "$1");

  const activeNormIds = new Set(activeTemplates.map(t => normalizeId(t.id)));

  // Each active template with traces gets a pair from its execution counts. META templates (lib/meta-templates.ts, the
  // shared definition: routing activities that run no task of their own) are structural, not learned arms, and are
  // left out (CHANGE DB1): their normal runs are COUNTED rather than traced when lifecycle.subscriber_trace_mode = 1,
  // so only their failures would reach this window and their pair would read as failing.
  for (const [id, counts] of traceCounts) {
    if (activeNormIds.has(normalizeId(id)) && !isMetaTemplate(id)) {
      variantPairs.push({ alpha: counts.success + 1, beta: counts.fail + 1 });
    }
  }
  // Active templates with no traces are NOT included in the confidence pairs.
  // Including them with uniform prior (α=1, β=1) causes the denominator to grow
  // as the substrate authors new gap-closing templates, diluting the ratio below
  // the 25% threshold even when the registry's active, tested templates are healthy.
  // Confidence should reflect: "of the templates that have been tried, what fraction
  // have enough evidence?" — not "of all templates including untested ones."
  // Templates with no executions are excluded; they contribute nothing to evidence.
  const coveredNormIds = new Set([...traceCounts.keys()].map(normalizeId));

  const total_pairs = variantPairs.length;
  const pairs_above_floor = variantPairs.filter(p => (p.alpha + p.beta) >= confidenceFloor).length;
  const alphaBetaSums = variantPairs.map(p => p.alpha + p.beta);
  alphaBetaSums.sort((a, b) => a - b);
  const median_alpha_plus_beta = total_pairs > 0
    ? alphaBetaSums[Math.floor(total_pairs / 2)]!
    : 0;
  const p25_alpha_plus_beta = total_pairs > 0
    ? alphaBetaSums[Math.floor(total_pairs * 0.25)]!
    : 0;
  const p75_alpha_plus_beta = total_pairs > 0
    ? alphaBetaSums[Math.floor(total_pairs * 0.75)]!
    : 0;
  const mean_variance = total_pairs > 0
    ? variantPairs.reduce((sum, p) => {
        const ab = p.alpha + p.beta;
        return sum + (p.alpha * p.beta) / (ab * ab * (ab + 1));
      }, 0) / total_pairs
    : 0;

  const posterior_confidence = {
    total_pairs,
    pairs_above_floor,
    floor: confidenceFloor,
    median_alpha_plus_beta,
    p25_alpha_plus_beta,
    p75_alpha_plus_beta,
    mean_variance,
  };

  // — Graph stability: new templates + edges in a 15-minute window —
  // Use a short 15-minute window for mutation rate so operator restarts
  // (which re-seed templates with new created_at timestamps) don't falsely
  // signal instability. 15 minutes captures active ribosome churn without
  // penalising legitimate deploy events.
  const stabilityWindowSecs = 60 * 60; // 60 minutes — matches the boredom cycle's natural authoring cadence
  const stabilitySince = new Date(Date.now() - stabilityWindowSecs * 1000).toISOString();
  // Exclude from "new" count:
  // 1. development-vessel: seed templates — re-upserted with fresh created_at on every
  //    dev-vessel restart, which would falsely signal instability after any deploy.
  // 2. gap-closing: substrate-authored variants — these are the OUTPUT of the autonomous
  //    authoring loop (draft-gap-closing-activity). Adding 1-3 of these per hour is the
  //    substrate working correctly, not instability. Stability should flag ribosome-extracted
  //    or improviser-generated templates that appear unexpectedly.
  const normId = (id: string) => id.replace(/^activity:⟨(.+)⟩$/, "$1");
  const recentTemplates = templates.filter(t => {
    if (!t.created_at || t.created_at < stabilitySince) return false;
    const clean = normId(t.id);
    if (clean.startsWith("development-vessel:")) return false;
    if (clean.startsWith("gap-closing:")) return false;
    if (clean.startsWith("variant-")) return false; // anonymous test artifacts
    // Exclude templates that already have execution history — they were re-seeded on
    // restart (UPSERT sets created_at=now() on every restart), not genuinely new.
    // traceCounts is populated from the last 30 days of traces (built above).
    if (traceCounts.has(clean) || traceCounts.has(t.id) || traceCounts.has(normId(t.id))) return false;
    return true;
  });
  const new_templates_added = recentTemplates.length;
  const template_count_at_window_start = templates.length - recentTemplates.length;
  const template_count_at_window_end = templates.length;

  // Composition edges: OBSERVABILITY ONLY (feeds edge_growth_rate_per_hour, NOT the
  // gated stability rate). The prior URL /v2/activities/composition?since= returned
  // 404 — the real edge endpoint is /v2/activities/composition/graph — so this count
  // was silently 0 for the whole gate's history (harmless, since edges don't gate
  // stability). Fixed to the working endpoint + client-side created_at filter so the
  // reported edge-growth metric reflects reality (2026-06-19).
  let new_edges_added = 0;
  try {
    const edgeRes = await fetch(
      `${METABOB_ENDPOINT}/v2/activities/composition/graph?limit=500`,
      { headers: auth },
    );
    if (edgeRes.ok) {
      const edgeData = await edgeRes.json() as { edges?: CompositionEdge[]; compositions?: CompositionEdge[] };
      const edges = edgeData.edges ?? edgeData.compositions ?? [];
      new_edges_added = edges.filter(e => e.created_at && e.created_at >= stabilitySince).length;
    }
  } catch { /* non-critical */ }

  const stabilityHours = stabilityWindowSecs / 3600;
  // Stability gates on TEMPLATE-authoring burst ONLY, not edge formation (2026-06-19).
  // WHY: this dimension exists to catch runaway ribosome/improviser TEMPLATE churn
  // (see the "dozens of templates per hour" rationale above). Composition edges are
  // the OPPOSITE — they are the desirable convergence the DEC master inequality wants
  // MORE of (λ₁ credit-mixing, escaping the star topology), and their growth health is
  // already governed by the separate spectral-gap governor (λ₁ ≳ ρ_grow). Lumping edges
  // into the instability rate made the lift gate chronically FLAP: a healthy 4 templates
  // + 30 edges/hr read as 34/hr ≫ 10 ceiling, failing stability for doing exactly what
  // autonomy requires. new_edges_added stays REPORTED below for observability; it just
  // no longer counts as instability.
  const mutation_rate_per_hour = new_templates_added / Math.max(stabilityHours, 0.001);
  const edge_growth_rate_per_hour = new_edges_added / Math.max(stabilityHours, 0.001);

  const graph_stability = {
    new_templates_added,
    new_edges_added,
    template_count_at_window_start,
    template_count_at_window_end,
    mutation_rate_per_hour,          // templates/hr — the value gated by stabilityRateCeiling
    edge_growth_rate_per_hour,       // edges/hr — observational only (governed by spectral-gap governor)
  };

  // — Vessel set (inventory), liveness, registration; optimality: read most recent harness report —
  const inventoryPath = pointer.inventory_path ?? join(WORKSPACE_ROOT, "substrate", "fleet", "vessels.inventory.json");
  const derived = daemonVesselsFromInventory(await readJsonFile(inventoryPath));
  const daemonNames = derived ? derived.map((v) => v.name) : [...FALLBACK_SUBSTRATE_VESSELS];
  const [harnessReport, vesselLiveness] = await Promise.all([
    readMostRecentHarnessReport(WORKSPACE_ROOT),
    checkVesselLiveness(daemonNames, tickDeps.unitState),
  ]);
  const vesselRegistration = await checkVesselRegistration(derived, vesselLiveness.statuses, pointer, inventoryPath);
  const optimality = {
    most_recent_harness_run_at: harnessReport?.run_at ?? harnessReport?.generated_at ?? null,
    mean_optimality_ratio: harnessReport?.mean_optimality_ratio ?? null,
  };

  // — Health verdict —
  // When the registry corpus could not be fully read, confidence + stability are
  // UNMEASURED (null), never a confident pass/fail. A null dimension makes
  // overall_passing null ("couldn't measure this tick"), which resets the lift
  // streak honestly instead of falsely signalling a regression.
  const confidence_passing = !corpus_complete
    ? null
    // null, NOT false, on a thin sample. This file already treats null as "couldn't measure this
    // tick" three lines above, and the comment there states the reason: a null dimension "makes
    // overall_passing null … which resets the lift streak honestly instead of falsely signalling a
    // regression". A thin sample is owed that same honesty — returning false would assert a
    // MEASURED regression, which is the opposite of the truth, and would be as dishonest in the
    // pessimistic direction as the current behaviour is in the optimistic one. Subsumes the old
    // total_pairs === 0 guard, since 0 < confidenceMinPairs.
    : (total_pairs < confidenceMinPairs ? null : pairs_above_floor / total_pairs >= confidenceRatioThreshold);
  const stability_passing = !corpus_complete
    ? null
    : mutation_rate_per_hour <= stabilityRateCeiling;
  const optimality_passing =
    optimality.mean_optimality_ratio !== null
      ? optimality.mean_optimality_ratio <= optimalityRatioCeiling
      : null;
  const vessels_passing = vesselLiveness.down.length === 0;
  const measurable = confidence_passing !== null && stability_passing !== null;
  const overall_passing = !measurable
    ? null
    : (confidence_passing &&
       stability_passing &&
       vessels_passing &&
       (optimality_passing === null ? true : optimality_passing));
  // Honesty: optimality is structurally never measured (the harness writes no
  // ratio), so it silently dropped out of overall_passing as null->true.
  // Surface that it is UNMEASURED rather than letting it read as a passing
  // dimension — the lift gate keys on overall_passing.
  const optimality_measured = optimality.mean_optimality_ratio !== null;
  const unmeasured_dimensions: string[] = [];
  if (!optimality_measured) unmeasured_dimensions.push("optimality");
  if (!corpus_complete) unmeasured_dimensions.push("posterior_confidence", "graph_stability");

  const report = {
    generated_at: new Date().toISOString(),
    lookback_window_seconds: lookbackSecs,
    posterior_confidence,
    graph_stability,
    optimality,
    vessel_liveness: {
      statuses: vesselLiveness.statuses,
      down: vesselLiveness.down,
      all_active: vessels_passing,
      vessel_set: derived ? { source: "inventory", path: inventoryPath } : { source: "fallback", path: inventoryPath, reason: "inventory unreadable or names no daemon vessel" },
    },
    vessel_registration: vesselRegistration,
    registry_fetch: {
      corpus_complete,
      templates_fetched: template_count_at_window_end,
      templates_total: templatesTotal === Infinity ? null : templatesTotal,
    },
    health_verdict: {
      confidence_passing,
      stability_passing,
      optimality_passing,
      optimality_measured,
      vessels_passing,
      overall_passing,
      corpus_complete,
      unmeasured_dimensions,
    },
  };

  // Write a heartbeat file to the host-mounted workspace so external agents
  // (validation, audit) can detect substrate liveness by stat'ing the file
  // rather than polling HTTP — closes gap-008.
  // Atomic write: write to .tmp then rename so readers never see a partial file.
  try {
    const heartbeatPath = tickDeps.heartbeatPath();
    const tmpPath = heartbeatPath + ".tmp";
    const heartbeat = JSON.stringify({
      ts: report.generated_at,
      overall_passing: report.health_verdict.overall_passing,
      template_count: report.graph_stability.template_count_at_window_end,
      template_total: report.registry_fetch.templates_total,
      corpus_complete: report.registry_fetch.corpus_complete,
      vessels_down: report.vessel_liveness.down,
      vessels_unregistered: vesselRegistration.unregistered,
      // Read back by the next tick (checkVesselRegistration): the streak must survive a dv restart.
      unregistered_ticks: vesselRegistration.unregistered_ticks,
    });
    await mkdir(dirname(heartbeatPath), { recursive: true });
    await writeFile(tmpPath, heartbeat, "utf-8");
    await rename(tmpPath, heartbeatPath);
  } catch {
    // Non-fatal — heartbeat failure must not crash the health tick itself.
  }

  return {
    shape: "substrateHealthReport",
    body: report,
  };
}
