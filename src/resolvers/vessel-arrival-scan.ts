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
 *        vessel would be reported as "arrived" and flood the drafter.
 *   3. For each genuinely-new vessel, classify each advertised shape's coverage
 *      via activity-api discover-by-shapes (forward=producers, backward=
 *      consumers): covered / producer_only / consumer_only / orphaned.
 *        Routing invariant: an arrived vessel ALWAYS brought a resolver for its
 *        shapes (it advertises them), so an uncovered shape is a TEMPLATE gap,
 *        never a resolver gap → route to the drafter, not scaffold-vessel.
 *   4. For vessels with any uncovered shape, write a deterministic gap scenario
 *      into the scenarios dir the drafter already polls (drafter-trigger-tick).
 *      Only filesystem-safe slugs are interpolated, so the file always parses
 *      (avoids the LLM-text-in-JSON ghost-success draft-gap-closing just fixed).
 *      Scenario id is deterministic per vessel → re-runs UPSERT, never flood.
 *   5. Credit the new vessel's shapes via the reward edge (credit_vessel_shapes)
 *      so their cold-start relevance leaves zero.
 *   6. Persist the union snapshot.
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

async function readSnapshot(snapshotPath: string): Promise<Set<string> | null> {
  try {
    const raw = await fs.readFile(snapshotPath, "utf8");
    const parsed = JSON.parse(raw) as { known?: string[] };
    return new Set(Array.isArray(parsed.known) ? parsed.known : []);
  } catch {
    return null; // missing/unreadable → baseline run
  }
}

async function writeSnapshot(snapshotPath: string, known: Set<string>): Promise<void> {
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  await fs.writeFile(
    snapshotPath,
    JSON.stringify({ known: [...known].sort(), updated_at: new Date().toISOString() }, null, 2),
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
  const known = await readSnapshot(snapshotPath);

  // BASELINE: first run records the world without reporting arrivals.
  if (known === null) {
    await writeSnapshot(snapshotPath, currentIds);
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

  const newVessels = registry.filter((v) => v.vesselId && !known.has(v.vesselId));

  const classifications: VesselClassification[] = [];
  for (const v of newVessels) {
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
      shape_count: shapes.length,
      shapes: shapeClasses,
      uncovered_shapes: uncovered,
      verdict,
      routing: verdict === "needs_integration" ? "draft_template" : "none",
      scenario_id: verdict === "needs_integration" ? `vessel-arrival-${slug(v.vesselId)}` : null,
    });
  }

  // Emit deterministic gap scenarios for vessels needing integration.
  let scenariosWritten = 0;
  const scenarioErrors: string[] = [];
  if (emitScenarios) {
    for (const v of classifications) {
      if (v.verdict !== "needs_integration" || !v.scenario_id) continue;
      try {
        await fs.mkdir(scenariosDir, { recursive: true });
        await fs.writeFile(
          path.join(scenariosDir, `${v.scenario_id}.json`),
          JSON.stringify(buildScenario(v), null, 2),
          "utf8",
        );
        scenariosWritten += 1;
      } catch (err) {
        scenarioErrors.push(`${v.vessel_id}:${err instanceof Error ? err.message.slice(0, 60) : "err"}`);
      }
    }
  }

  // Reward edge: credit the characterized vessels' shapes (down-weighted).
  let creditedVessels = 0;
  if (creditOnCharacterize) {
    for (const v of classifications) {
      if (v.shape_count === 0) continue;
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

  // Persist the union so these vessels are not re-reported next run.
  for (const id of currentIds) known.add(id);
  await writeSnapshot(snapshotPath, known);

  return {
    shape: "vesselArrivalReport",
    body: {
      baseline: false,
      known_before: known.size - newVessels.length,
      current_vessels: currentIds.size,
      new_vessel_count: newVessels.length,
      new_vessels: classifications,
      scenarios_written: scenariosWritten,
      ...(scenarioErrors.length ? { scenario_errors: scenarioErrors } : {}),
      credited_vessels: creditedVessels,
      generated_at: generatedAt,
    },
  };
}
