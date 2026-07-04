import type { ResolverResult } from "./types.js";

/**
 * implicit_vessel_scan (2026-07-01) — the GENERIC IMPLICIT-VESSEL CLASSIFIER.
 *
 * Generalizes vessel_arrival_scan (models a vessel the substrate DRIVES via
 * discovery) and obsidian_behavior_scan (models the human via obsidian) into one
 * classifier for any external actor the substrate MODELS but does NOT self-drive.
 * We call such an actor an IMPLICIT VESSEL: it is not registered in discovery as
 * a resolver the substrate can dispatch to, yet its actions change state the
 * substrate observes. The only implicit vessel today is the HUMAN via obsidian —
 * the operator opens/edits/navigates notes and the substrate watches, but never
 * "runs" the human. This scan gives that actor a first-class report.
 *
 * The substrate's ability to COOPERATE with an implicit vessel is exactly the
 * strength of its FORWARD MODEL of that actor (can it anticipate the next action?).
 * So this resolver:
 *   1. Reads the obsidian observe substrate (obsidian:event_observed via the
 *      plugin) — the same window obsidian_behavior_scan uses. It filters out the
 *      substrate's OWN writes (file events under the sync/write roots) so the
 *      model reflects the OPERATOR, not the substrate re-observing itself.
 *   2. Builds the forward model P(next-kind | current-kind) with a modal
 *      expectation + consistency per current-kind (the transposed goal-host
 *      behavior model), and derives forward_model_strength = the sample-weighted
 *      mean consistency across modeled transitions (0 = unpredictable, 1 = fully
 *      anticipatable).
 *   3. Lists the unpredictable_transitions[] — current-kinds where the operator's
 *      next action deviates from the modal expectation past a threshold with
 *      enough distinct follow-ups to be a genuine gap.
 *   4. Emits shape `implicitVesselReport` = {vessel, observed_shapes,
 *      forward_model_strength, unpredictable_transitions[]}.
 *   5. When the forward model is WEAK (strength below a floor OR any unpredictable
 *      transition exists), emits a `substrateGap` (category
 *      implicit_vessel_gap by default, or obsidian_unpredictable_behavior for the
 *      obsidian actor) reusing obsidian_behavior_scan's gap-emit idiom
 *      (substrateGap_write to the dev-vessel resolve endpoint), so the existing
 *      detect→draft→exercise loop can author a better predictor/response.
 *
 * READS ONLY — never executes, never gates. Safe on the live vault. Unreachable
 * obsidian = graceful idle (external app), never a hard failure.
 */

import { resolveObsidianEndpointViaDiscovery } from "./obsidian-request-scan.js";
const DEFAULT_OBSIDIAN_ENDPOINT =
  process.env["OBSIDIAN_LEARN_ENDPOINT"] ??
  process.env["OBSIDIAN_PLUGIN_ENDPOINT"] ??
  "http://host.docker.internal:27182";
const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";
const API_KEY = process.env["METABOB_API_KEY"] ?? process.env["DEV_VESSEL_API_KEY"];

// Substrate-originated file events (concept-sync note materialization + the
// Substrate/ board) must be filtered out so the operator forward model isn't
// swamped by the substrate re-observing its own writes. Provenance-by-path.
const DEFAULT_SUBSTRATE_WRITE_PREFIXES = ["concept-db/", "substrate/", "Substrate/"];
const FILE_EVENT_KINDS = new Set(["file-create", "file-modify", "file-delete", "file-rename"]);

export interface ImplicitVesselScanPointer {
  type: "implicit_vessel_scan";
  /** The implicit vessel to characterize. Only "obsidian" (the human) today. */
  vessel?: string;
  obsidianEndpoint?: string;
  emitGapUrl?: string;
  apiKey?: string;
  /** Min transitions out of a current-kind to model it. Default 3. */
  minSamples?: number;
  /** deviation_fraction >= this AND distinct_next >= 3 → unpredictable. Default 0.5. */
  inconsistentThreshold?: number;
  /** forward_model_strength below this floor → weak model → emit a gap. Default 0.6. */
  weakModelFloor?: number;
  /** Events to pull from the vessel log (cap 10k). Default 5000. */
  eventLimit?: number;
  /** Vault-relative roots whose file events are substrate-originated (filtered out). */
  substrateWritePrefixes?: string[];
  /**
   * substrateGap category to emit when the model is weak. Defaults to
   * "obsidian_unpredictable_behavior" for the obsidian actor (so it dovetails
   * with obsidian_behavior_scan's existing gap stream), else "implicit_vessel_gap".
   */
  gapCategory?: string;
  /** Emit a substrateGap when the model is weak (default true). */
  emitGap?: boolean;
  timeoutMs?: number;
}

interface ObservedEvent {
  kind?: string;
  timestamp?: string;
  event_id?: string;
  sync_root_relative_path?: string;
}

interface Transition {
  current_kind: string;
  expected_next_kind: string;
  consistency: number;
  deviation_fraction: number;
  distinct_next_kinds: number;
  samples: number;
}

async function emitImplicitVesselGap(
  emitUrl: string,
  apiKey: string,
  vessel: string,
  category: string,
  strength: number,
  observedShapes: string[],
  unpredictable: Transition[],
): Promise<boolean> {
  const worst = unpredictable[0];
  const detail = worst
    ? ` The weakest transition is after "${worst.current_kind}": ${worst.distinct_next_kinds} distinct ` +
      `follow-ups, ${(worst.deviation_fraction * 100).toFixed(0)}% deviation from the modal next action ` +
      `("${worst.expected_next_kind}") over ${worst.samples} observations.`
    : "";
  const body = {
    impulse: {
      pointer: {
        type: "substrateGap_write",
        gap: {
          id: `implicit_vessel_gap-${vessel}`,
          category,
          source: "substrate_detected",
          summary:
            `The implicit vessel "${vessel}" (an external actor the substrate models but does not ` +
            `self-drive) has a WEAK forward model: forward_model_strength=${strength.toFixed(2)} over ` +
            `observed shapes [${observedShapes.join(", ")}], with ${unpredictable.length} unpredictable ` +
            `transition(s). The substrate cannot yet anticipate this actor well enough to cooperate.` +
            detail,
          detected_at: new Date().toISOString(),
          status: "open",
          classification_metadata: {
            detector: "implicit_vessel_scan",
            gap_class: category,
            vessel,
            forward_model_strength: Number(strength.toFixed(3)),
            observed_shapes: observedShapes,
            unpredictable_transition_count: unpredictable.length,
            unpredictable_transitions: unpredictable.map((t) => ({
              current_kind: t.current_kind,
              expected_next_kind: t.expected_next_kind,
              deviation_fraction: Number(t.deviation_fraction.toFixed(3)),
              distinct_next_kinds: t.distinct_next_kinds,
              samples: t.samples,
            })),
            suggested_remediation:
              `Author an activity that observes more state around the weak transition(s) for "${vessel}" ` +
              `(or proactively surfaces a relevant note/question) so the actor's next action becomes ` +
              `anticipatable, strengthening the forward model above the weak floor.`,
          },
        },
      },
    },
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const r = await fetch(emitUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function resolveImplicitVesselScan(
  pointer: ImplicitVesselScanPointer,
): Promise<ResolverResult> {
  const vessel = pointer.vessel ?? "obsidian";
  const endpoint = (pointer.obsidianEndpoint ?? (await resolveObsidianEndpointViaDiscovery()) ?? DEFAULT_OBSIDIAN_ENDPOINT).replace(/\/+$/, "");
  const emitUrl = pointer.emitGapUrl ?? DEFAULT_DEV_VESSEL_URL;
  const apiKey = pointer.apiKey ?? API_KEY;
  const minSamples = pointer.minSamples ?? 3;
  const inconsistentThreshold = pointer.inconsistentThreshold ?? 0.5;
  const weakModelFloor = pointer.weakModelFloor ?? 0.6;
  const eventLimit = pointer.eventLimit ?? 5000;
  const substratePrefixes = pointer.substrateWritePrefixes ?? DEFAULT_SUBSTRATE_WRITE_PREFIXES;
  const gapCategory =
    pointer.gapCategory ??
    (vessel === "obsidian" ? "obsidian_unpredictable_behavior" : "implicit_vessel_gap");
  const emitGap = pointer.emitGap ?? true;
  const timeoutMs = pointer.timeoutMs ?? 12_000;
  const generatedAt = new Date().toISOString();

  if (!apiKey) {
    return {
      shape: "implicitVesselReport",
      body: { vessel, error: "missing_api_key", forward_model_strength: 0 },
    };
  }
  const auth = { "Content-Type": "application/json", Authorization: `ApiKey ${apiKey}` };

  // Today the only implicit vessel is the human via obsidian; the read path is
  // the obsidian observe substrate. Other actors would slot in additional read
  // branches keyed on `vessel`.
  if (vessel !== "obsidian") {
    return {
      shape: "implicitVesselReport",
      body: {
        vessel,
        unsupported: true,
        note: `only the "obsidian" implicit vessel is characterized today`,
        forward_model_strength: 0,
        observed_shapes: [],
        unpredictable_transitions: [],
        generated_at: generatedAt,
      },
    };
  }

  // 1. Read the actor's observed actions (reads only — never executes).
  let events: ObservedEvent[] = [];
  try {
    const res = await fetch(`${endpoint}/resolve`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        impulse: { pointer: { type: "obsidian:event_observed", limit: eventLimit } },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as { content?: string; error?: string };
    if (json.error) {
      return {
        shape: "implicitVesselReport",
        body: {
          vessel,
          endpoint,
          forward_model_strength: 0,
          observed_shapes: [],
          unpredictable_transitions: [],
          probe_error: json.error,
          generated_at: generatedAt,
        },
      };
    }
    const parsed = json.content ? (JSON.parse(json.content) as { events?: ObservedEvent[] }) : {};
    events = Array.isArray(parsed.events) ? parsed.events : [];
  } catch (err) {
    return {
      shape: "implicitVesselReport",
      body: {
        vessel,
        endpoint,
        unreachable: true,
        forward_model_strength: 0,
        observed_shapes: [],
        unpredictable_transitions: [],
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
        generated_at: generatedAt,
      },
    };
  }

  // PROVENANCE FILTER: drop the substrate's OWN writes so the model reflects the
  // actor, not the substrate re-observing itself.
  const totalEvents = events.length;
  const isSubstrateWrite = (e: ObservedEvent): boolean =>
    FILE_EVENT_KINDS.has(e.kind ?? "") &&
    typeof e.sync_root_relative_path === "string" &&
    substratePrefixes.some((pfx) => e.sync_root_relative_path!.startsWith(pfx));
  const actorEvents = events.filter((e) => !isSubstrateWrite(e));
  const substrateFiltered = totalEvents - actorEvents.length;

  // 2. Build P(next-kind | current-kind) from ordered transitions.
  const ordered = actorEvents
    .filter((e) => typeof e.kind === "string")
    .sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
  const transitions = new Map<string, Map<string, number>>();
  for (let i = 0; i < ordered.length - 1; i++) {
    const from = ordered[i]!.kind!;
    const to = ordered[i + 1]!.kind!;
    if (!transitions.has(from)) transitions.set(from, new Map());
    const m = transitions.get(from)!;
    m.set(to, (m.get(to) ?? 0) + 1);
  }

  const models: Transition[] = [];
  for (const [current, nexts] of transitions) {
    const samples = [...nexts.values()].reduce((a, b) => a + b, 0);
    if (samples < minSamples) continue;
    let modalKind = "";
    let modalCount = 0;
    for (const [k, c] of nexts)
      if (c > modalCount) {
        modalCount = c;
        modalKind = k;
      }
    const consistency = modalCount / samples;
    models.push({
      current_kind: current,
      expected_next_kind: modalKind,
      consistency,
      deviation_fraction: 1 - consistency,
      distinct_next_kinds: nexts.size,
      samples,
    });
  }

  // forward_model_strength = sample-weighted mean consistency. 0 when nothing is
  // modeled (the substrate has no anticipation of this actor at all).
  const totalSamples = models.reduce((a, m) => a + m.samples, 0);
  const forwardModelStrength =
    totalSamples > 0
      ? models.reduce((a, m) => a + m.consistency * m.samples, 0) / totalSamples
      : 0;

  // unpredictable_transitions: high deviation with enough distinct follow-ups.
  const unpredictable = models
    .filter((m) => m.deviation_fraction >= inconsistentThreshold && m.distinct_next_kinds >= 3)
    .sort((a, b) => b.deviation_fraction - a.deviation_fraction);

  const observedShapes = [...new Set(ordered.map((e) => e.kind!))].sort();

  // 3. A weak forward model → emit a substrateGap so the author loop strengthens it.
  const modelIsWeak = models.length > 0 && (forwardModelStrength < weakModelFloor || unpredictable.length > 0);
  let gapEmitted = false;
  if (emitGap && modelIsWeak) {
    gapEmitted = await emitImplicitVesselGap(
      emitUrl,
      apiKey,
      vessel,
      gapCategory,
      forwardModelStrength,
      observedShapes,
      unpredictable,
    );
  }

  return {
    shape: "implicitVesselReport",
    body: {
      vessel,
      endpoint,
      observed_shapes: observedShapes,
      forward_model_strength: Number(forwardModelStrength.toFixed(3)),
      model_is_weak: modelIsWeak,
      gap_emitted: gapEmitted,
      gap_category: modelIsWeak ? gapCategory : null,
      unpredictable_transitions: unpredictable.map((m) => ({
        current_kind: m.current_kind,
        expected_next_kind: m.expected_next_kind,
        deviation_fraction: Number(m.deviation_fraction.toFixed(3)),
        distinct_next_kinds: m.distinct_next_kinds,
        samples: m.samples,
      })),
      // Diagnostics: how the window was formed and what the forward model looks like.
      total_events_pulled: totalEvents,
      substrate_writes_filtered: substrateFiltered,
      events_observed: ordered.length,
      modeled_transitions: models.length,
      transitions_summary: models.map((m) => ({
        current_kind: m.current_kind,
        expected_next_kind: m.expected_next_kind,
        consistency: Number(m.consistency.toFixed(2)),
        samples: m.samples,
      })),
      generated_at: generatedAt,
    },
  };
}
