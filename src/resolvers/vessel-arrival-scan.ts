import { promises as fs } from "node:fs";
import path from "node:path";
import type { ResolverResult } from "./types.js";
import { resolveCreditVesselShapes } from "./credit-vessel-shapes.js";

/**
 * vessel_arrival_scan (2026-06-13) — the VESSEL-ARRIVAL HORIZON CLASSIFIER.
 *
 * SUBSTRATE_AS_MDP §8.4/§8.6: the substrate already routes detected gaps to the
 * drafter (template gap) or scaffold-and-publish-vessel (resolver gap), and it
 * already OBSERVES registry staleness (discovery_vessel_registry_observer). What
 * was missing is the *arrival trigger*: nothing watched "a NEW vessel joined
 * discovery → characterize the shapes it brought." Without it, an arbitrary
 * vessel can connect and its shapes stay observable-but-unmanipulable — no
 * activity consumes them, so the action node never enters applicable(s).
 *
 * Each run:
 *   1. Query discovery for the live vesselRegistry.
 *   2. Diff against a persisted snapshot of known vessel ids.
 *        FIRST RUN (no snapshot) = BASELINE: record everything, emit ZERO
 *        arrivals. This is the anti-flood guard — otherwise every pre-existing
 *        vessel would be reported as "arrived" and flood the drafter. The
 *        baseline fleet (the substrate's own infra: activity-api, dev-vessel,
 *        local-tools, …) is recorded as known but NEVER becomes an integration
 *        target — its write/terminal shapes have no consumer BY DESIGN.
 *   3. Classify the WORK SET = fresh arrivals (in registry, not in `known`) ∪
 *      still-pending arrivals (in registry ∩ persisted `pending`). Per shape,
 *      discover-by-shapes (forward=producers, backward=consumers):
 *      covered / producer_only / consumer_only / orphaned.
 *        Routing invariant: an arrived vessel ALWAYS brought a resolver for its
 *        shapes (it advertises them), so an uncovered shape is a TEMPLATE gap,
 *        never a resolver gap → route to the drafter, not scaffold-vessel.
 *   4. INTEGRATION-GAP, NOT ARRIVAL-NOVELTY, is the trigger. A genuine arrival
 *      that still has an unconsumed shape stays in `pending` and re-emits its
 *      deterministic (UPSERT) gap scenario every run until a consumer is
 *      authored — that is what turns "detected once" into "driven until
 *      integrated". Once integrated it leaves `pending` and its stale scenario
 *      is cleared. The baseline infra fleet is out of scope, so this never
 *      floods the drafter with terminal-effect shapes.
 *   5. Credit a genuine arrival's shapes via the reward edge (credit_vessel_shapes)
 *      once, so their cold-start relevance leaves zero. Pending re-drives are
 *      NOT re-credited (that would inflate relevance every tick).
 *   6. Persist the union `known` + the live `pending` set.
 *
 * The verdict is trace-inspectable: per-shape coverage counts are in the body,
 * never an opaque "all good" (the self-audit-blindness failure mode).
 */

const DEFAULT_DISCOVERY = process.env["DISCOVERY_ENDPOINT"] ?? "http://127.0.0.1:8100";
const DEFAULT_METABOB = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
const API_KEY = process.env["METABOB_API_KEY"] ?? process.env["DEV_VESSEL_API_KEY"];
const DEFAULT_SNAPSHOT = "/workspace/state/vessel-arrival-snapshot.json";
const DEFAULT_SCENARIOS_DIR = "/workspace/validation/failure-modes/scenarios";

export interface VesselArrivalScanPointer {
  type: "vessel_arrival_scan";
  discoveryEndpoint?: string;
  metabobEndpoint?: string;
  apiKey?: string;
  /** JSON file persisting the set of known vessel ids across runs. */
  snapshotPath?: string;
  /** Directory the drafter polls; uncovered-shape scenarios land here. */
  scenariosDir?: string;
  emitScenarios?: boolean;
  creditOnCharacterize?: boolean;
  timeoutMs?: number;
}

interface RegistryVessel {
  vesselId: string;
  vesselName?: string;
  shapes?: string[];
}

type ShapeCoverage = "covered" | "producer_only" | "consumer_only" | "orphaned";

interface ShapeClassification {
  shape: string;
  has_producer: boolean;
  has_consumer: boolean;
  coverage: ShapeCoverage;
}

interface VesselClassification {
  vessel_id: string;
  vessel_name: string | null;
  /** True if this vessel was absent from the snapshot (a genuine arrival). */
  arrival: boolean;
  shape_count: number;
  shapes: ShapeClassification[];
  uncovered_shapes: string[];
  verdict: "integrated" | "needs_integration";
  routing: "none" | "draft_template";
  scenario_id: string | null;
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

interface Snapshot {
  known: Set<string>;
  /** Post-baseline arrivals still awaiting integration (re-drive targets). */
  pending: Set<string>;
}

async function readSnapshot(snapshotPath: string): Promise<Snapshot | null> {
  try {
    const raw = await fs.readFile(snapshotPath, "utf8");
    const parsed = JSON.parse(raw) as { known?: string[]; pending?: string[] };
    return {
      known: new Set(Array.isArray(parsed.known) ? parsed.known : []),
      pending: new Set(Array.isArray(parsed.pending) ? parsed.pending : []),
    };
  } catch {
    return null; // missing/unreadable → baseline run
  }
}

async function writeSnapshot(
  snapshotPath: string,
  known: Set<string>,
  pending: Set<string>,
): Promise<void> {
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  await fs.writeFile(
    snapshotPath,
    JSON.stringify(
      { known: [...known].sort(), pending: [...pending].sort(), updated_at: new Date().toISOString() },
      null,
      2,
    ),
    "utf8",
  );
}

async function fetchRegistry(
  endpoint: string,
  apiKey: string,
  timeoutMs: number,
): Promise<RegistryVessel[]> {
  const res = await fetch(`${endpoint.replace(/\/+$/, "")}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `ApiKey ${apiKey}` },
    body: JSON.stringify({ pointer: { type: "vesselRegistry" } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`registry ${res.status}`);
  const json = (await res.json()) as { content?: { vessels?: RegistryVessel[] }; vessels?: RegistryVessel[] };
  return json.content?.vessels ?? json.vessels ?? [];
}

/** Returns true if discover-by-shapes finds at least one match (not a "gap"). */
async function shapeHasMatch(
  metabob: string,
  apiKey: string,
  shape: string,
  mode: "forward" | "backward",
  timeoutMs: number,
): Promise<boolean> {
  try {
    const res = await fetch(`${metabob.replace(/\/+$/, "")}/v2/activities/discover-by-shapes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${apiKey}` },
      body: JSON.stringify({ required_shapes: [shape], mode, limit: 1 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as {
      activities?: unknown[];
      candidates?: unknown[];
      templates?: unknown[];
      matched?: boolean;
      emergence_class?: string;
    };
    if (typeof json.matched === "boolean") return json.matched;
    if (json.emergence_class) return json.emergence_class !== "gap";
    const list = json.activities ?? json.candidates ?? json.templates ?? [];
    return Array.isArray(list) && list.length > 0;
  } catch {
    return false;
  }
}

function buildScenario(v: VesselClassification): Record<string, unknown> {
  const shapesList = v.uncovered_shapes.join(", ");
  return {
    id: v.scenario_id,
    mode_class: "vessel_arrival",
    stage: "detection",
    outcome_class: "gap",
    title: `vessel ${v.vessel_id} arrived with ${v.uncovered_shapes.length} unconsumed shape(s)`,
    description:
      `Vessel ${v.vessel_id} joined discovery advertising shapes [${shapesList}] that no ` +
      `existing activity consumes or produces. The vessel resolves these shapes, so a ` +
      `resolver exists — this is a TEMPLATE gap, not a resolver gap.`,
    goal_text:
      `Vessel ${v.vessel_id} advertises the shapes [${shapesList}] but no activity template ` +
      `consumes them, so the substrate can observe this vessel's state without being able to ` +
      `act on it. Draft a gap-closing activity that takes one of these shapes as input (or ` +
      `produces it as output) so the substrate gains a selectable action over ${v.vessel_id}. ` +
      `Prefer the smallest activity that turns an observation into a usable downstream impulse.`,
    expected_input_shapes: v.uncovered_shapes,
    expected_output_shapes: [],
    cite_principle: null,
    target_file_paths: [],
    operator_seed: false,
    bridge_source: "vessel_arrival_scan",
    source_gap_id: `vessel-arrival-${slug(v.vessel_id)}`,
    source_gap_source: "substrate_detected",
  };
}

export async function resolveVesselArrivalScan(
  pointer: VesselArrivalScanPointer,
): Promise<ResolverResult> {
  const discovery = pointer.discoveryEndpoint ?? DEFAULT_DISCOVERY;
  const metabob = pointer.metabobEndpoint ?? DEFAULT_METABOB;
  const apiKey = pointer.apiKey ?? API_KEY;
  const snapshotPath = pointer.snapshotPath ?? DEFAULT_SNAPSHOT;
  const scenariosDir = pointer.scenariosDir ?? DEFAULT_SCENARIOS_DIR;
  const emitScenarios = pointer.emitScenarios ?? true;
  const creditOnCharacterize = pointer.creditOnCharacterize ?? true;
  const timeoutMs = pointer.timeoutMs ?? 8000;
  const generatedAt = new Date().toISOString();

  if (!apiKey) {
    return {
      shape: "vesselArrivalReport",
      body: { error: "missing_api_key", baseline: false, new_vessel_count: 0, generated_at: generatedAt },
    };
  }

  let registry: RegistryVessel[];
  try {
    registry = await fetchRegistry(discovery, apiKey, timeoutMs);
  } catch (err) {
    return {
      shape: "vesselArrivalReport",
      body: {
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
        reachable: false,
        new_vessel_count: 0,
        generated_at: generatedAt,
      },
    };
  }

  const currentIds = new Set(registry.map((v) => v.vesselId).filter(Boolean));
  const snapshot = await readSnapshot(snapshotPath);

  // BASELINE: first run records the world without reporting arrivals. The whole
  // existing fleet enters `known` and an empty `pending` — so the substrate's
  // own infra is never an integration target.
  if (snapshot === null) {
    await writeSnapshot(snapshotPath, currentIds, new Set());
    return {
      shape: "vesselArrivalReport",
      body: {
        baseline: true,
        recorded_vessels: currentIds.size,
        new_vessel_count: 0,
        new_vessels: [],
        note: "baseline snapshot recorded; arrivals reported from next run",
        generated_at: generatedAt,
      },
    };
  }

  const { known, pending } = snapshot;

  // WORK SET = fresh arrivals (in registry, not known) ∪ still-pending arrivals
  // (in registry ∩ pending). The baseline infra fleet is in neither, so it is
  // never re-driven — only genuine arrivals that still have an unconsumed shape.
  const arrivalIds = new Set(registry.filter((v) => v.vesselId && !known.has(v.vesselId)).map((v) => v.vesselId));
  const toClassify = registry.filter(
    (v) => v.vesselId && (arrivalIds.has(v.vesselId) || pending.has(v.vesselId)),
  );

  const classifications: VesselClassification[] = [];
  for (const v of toClassify) {
    const shapes = Array.isArray(v.shapes) ? v.shapes : [];
    const shapeClasses: ShapeClassification[] = [];
    for (const shape of shapes) {
      const [hasProducer, hasConsumer] = await Promise.all([
        shapeHasMatch(metabob, apiKey, shape, "forward", timeoutMs),
        shapeHasMatch(metabob, apiKey, shape, "backward", timeoutMs),
      ]);
      const coverage: ShapeCoverage =
        hasProducer && hasConsumer
          ? "covered"
          : hasProducer
            ? "producer_only"
            : hasConsumer
              ? "consumer_only"
              : "orphaned";
      shapeClasses.push({ shape, has_producer: hasProducer, has_consumer: hasConsumer, coverage });
    }
    // A shape the substrate can act on needs a CONSUMER (turns observation into
    // a downstream impulse). Shapes with no consumer are the integration gap.
    const uncovered = shapeClasses.filter((s) => !s.has_consumer).map((s) => s.shape);
    const verdict = uncovered.length > 0 ? "needs_integration" : "integrated";
    classifications.push({
      vessel_id: v.vesselId,
      vessel_name: v.vesselName ?? null,
      arrival: arrivalIds.has(v.vesselId),
      shape_count: shapes.length,
      shapes: shapeClasses,
      uncovered_shapes: uncovered,
      verdict,
      routing: verdict === "needs_integration" ? "draft_template" : "none",
      scenario_id: verdict === "needs_integration" ? `vessel-arrival-${slug(v.vesselId)}` : null,
    });
  }

  // Emit deterministic gap scenarios for vessels needing integration, and clear
  // stale scenarios for vessels that have since been integrated. Deterministic
  // scenario ids make the write an UPSERT (re-emit without flooding) and make
  // the clear a targeted unlink — the queue tracks the live integration state.
  let scenariosWritten = 0;
  let scenariosCleared = 0;
  const scenarioErrors: string[] = [];
  if (emitScenarios) {
    await fs.mkdir(scenariosDir, { recursive: true }).catch(() => {});
    for (const v of classifications) {
      const scenarioId = `vessel-arrival-${slug(v.vessel_id)}`;
      const scenarioFile = path.join(scenariosDir, `${scenarioId}.json`);
      if (v.verdict === "needs_integration") {
        try {
          await fs.writeFile(scenarioFile, JSON.stringify(buildScenario(v), null, 2), "utf8");
          scenariosWritten += 1;
        } catch (err) {
          scenarioErrors.push(`${v.vessel_id}:${err instanceof Error ? err.message.slice(0, 60) : "err"}`);
        }
      } else {
        // integrated → remove any stale gap scenario so the drafter stops working it.
        try {
          await fs.unlink(scenarioFile);
          scenariosCleared += 1;
        } catch {
          /* no stale scenario to clear — expected for already-integrated vessels */
        }
      }
    }
  }

  // Reward edge: credit only genuine arrivals' shapes (down-weighted). Known
  // vessels are NOT re-credited every rescan — that would inflate relevance.
  let creditedVessels = 0;
  if (creditOnCharacterize) {
    for (const v of classifications) {
      if (v.shape_count === 0 || !v.arrival) continue;
      const credit = await resolveCreditVesselShapes({
        type: "credit_vessel_shapes",
        metabobEndpoint: metabob,
        apiKey,
        vesselId: v.vessel_id,
        shapes: v.shapes.map((s) => s.shape),
        activityVariantId: "development-vessel:characterize-arrived-vessel",
        outcome: "success",
        source: "vessel_arrival_characterization",
        replayWeight: 0.5,
        timeoutMs,
      });
      const body = credit.body as { credited?: number };
      if ((body.credited ?? 0) > 0) creditedVessels += 1;
    }
  }

  // Recompute `pending`: a classified vessel that still needs integration stays
  // (or enters) pending; one that is now integrated leaves. Vessels no longer in
  // the registry drop out of pending (a departed vessel isn't an open gap). The
  // baseline infra fleet was never classified, so it never enters pending.
  const nextPending = new Set<string>();
  for (const id of pending) if (currentIds.has(id)) nextPending.add(id); // carry forward live ones
  for (const c of classifications) {
    if (c.verdict === "needs_integration") nextPending.add(c.vessel_id);
    else nextPending.delete(c.vessel_id);
  }

  // Persist the union `known` (anti-re-arrival) + the live `pending` set.
  for (const id of currentIds) known.add(id);
  await writeSnapshot(snapshotPath, known, nextPending);

  const arrivals = classifications.filter((c) => c.arrival);
  const reintegrationTargets = classifications.filter(
    (c) => !c.arrival && c.verdict === "needs_integration",
  );

  return {
    shape: "vesselArrivalReport",
    body: {
      baseline: false,
      known_before: known.size,
      current_vessels: currentIds.size,
      pending_count: nextPending.size,
      classified_vessels: classifications.length,
      new_vessel_count: arrivals.length,
      new_vessels: arrivals,
      reintegration_target_count: reintegrationTargets.length,
      reintegration_targets: reintegrationTargets.map((v) => ({
        vessel_id: v.vessel_id,
        uncovered_shapes: v.uncovered_shapes,
        scenario_id: v.scenario_id,
      })),
      scenarios_written: scenariosWritten,
      scenarios_cleared: scenariosCleared,
      ...(scenarioErrors.length ? { scenario_errors: scenarioErrors } : {}),
      credited_vessels: creditedVessels,
      generated_at: generatedAt,
    },
  };
}
