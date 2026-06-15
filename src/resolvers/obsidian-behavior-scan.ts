import type { ResolverResult } from "./types.js";

/**
 * obsidian_behavior_scan (2026-06-15) — learn the HUMAN, the other side of obsidian.
 *
 * The goal_host_behavior_scan pattern transposed to the operator: instead of
 * modeling the executor from its traces, OBSERVE the human's actual actions
 * (`obsidian:event_observed` — file-open/create/modify/etc., the substrate's
 * window onto what the operator does) and build a FORWARD MODEL of them. Reads
 * only — never executes, never gates — so it is safe on the live vault.
 *
 *   - SITUATION = the current observed action kind (cf. SUBSTRATE_AS_MDP state).
 *   - EXPECTATION model = P(next-action-kind | current-kind): the modal next
 *     action the human takes, its consistency, and how many distinct follow-ups
 *     exist. This is "we always need expectations" made concrete for the human.
 *   - DEVIATION = 1 - consistency: how unpredictable the human is after a given
 *     action. High deviation on a frequent kind = a learning gap (the substrate
 *     cannot yet anticipate the operator there) → emit substrateGap so the
 *     existing detect→draft→exercise loop can author a better predictor/response.
 *
 * Persists one `obsidian_behavior` prior per current-kind to concept-db, so the
 * substrate accumulates expectations about the operator. Unreachable obsidian =
 * graceful idle (external app), never a hard failure. Side-loop, NOT core boredom.
 */

const DEFAULT_OBSIDIAN_ENDPOINT =
  process.env["OBSIDIAN_LEARN_ENDPOINT"] ?? process.env["OBSIDIAN_PLUGIN_ENDPOINT"] ?? "http://host.docker.internal:27183";
const DEFAULT_CONCEPT_DB = process.env["CONCEPT_DB_ENDPOINT"] ?? "http://127.0.0.1:8260";
const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";
const API_KEY = process.env["METABOB_API_KEY"] ?? process.env["DEV_VESSEL_API_KEY"];

// The substrate's OWN writes land under these vault roots (concept-sync note
// materialization = the file-create flood; vessel/activity-family sync). File
// events under them are substrate-originated, NOT operator actions, and must be
// filtered out so the operator forward model isn't swamped. Provenance-by-path:
// the cheap separation that needs no plugin change.
const DEFAULT_SUBSTRATE_WRITE_PREFIXES = ["concept-db/", "substrate/"];
const FILE_EVENT_KINDS = new Set(["file-create", "file-modify", "file-delete", "file-rename"]);

export interface ObsidianBehaviorScanPointer {
  type: "obsidian_behavior_scan";
  obsidianEndpoint?: string;
  conceptDbBase?: string;
  emitGapUrl?: string;
  apiKey?: string;
  /** Min transitions out of a current-kind to model it. Default 3. */
  minSamples?: number;
  /** deviation_fraction ≥ this AND distinct_next ≥ 3 → emit a gap. Default 0.5. */
  inconsistentThreshold?: number;
  /** Events to pull from the vessel log (cap 10k). Default 5000 — reaches past the sync flood. */
  eventLimit?: number;
  /** Vault-relative roots whose file events are substrate-originated (filtered out). */
  substrateWritePrefixes?: string[];
  timeoutMs?: number;
}

interface ObservedEvent {
  kind?: string;
  timestamp?: string;
  event_id?: string;
  sync_root_relative_path?: string;
}

interface BehaviorModel {
  current_kind: string;
  expected_next_kind: string;
  consistency: number;
  deviation_fraction: number;
  distinct_next_kinds: number;
  samples: number;
}

async function emitInconsistentGap(
  emitUrl: string,
  apiKey: string,
  m: BehaviorModel,
): Promise<boolean> {
  const slug = m.current_kind.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 50);
  const body = {
    impulse: {
      pointer: {
        type: "substrateGap_write",
        gap: {
          id: `obsidian_unpredictable_behavior-${slug}`,
          category: "obsidian_unpredictable_behavior",
          source: "substrate_detected",
          summary:
            `The operator's behavior after "${m.current_kind}" is unpredictable: ${m.distinct_next_kinds} distinct ` +
            `follow-up actions, ${(m.deviation_fraction * 100).toFixed(0)}% deviation from the modal next action ` +
            `("${m.expected_next_kind}") over ${m.samples} observations. The substrate cannot yet anticipate the ` +
            `operator here.`,
          detected_at: new Date().toISOString(),
          status: "open",
          classification_metadata: {
            detector: "obsidian_behavior_scan",
            gap_class: "obsidian_unpredictable_behavior",
            current_kind: m.current_kind,
            expected_next_kind: m.expected_next_kind,
            consistency: m.consistency,
            distinct_next_kinds: m.distinct_next_kinds,
            samples: m.samples,
            suggested_remediation:
              `Author an activity that observes more obsidian state around "${m.current_kind}" (or proactively ` +
              `surfaces a relevant note/question) so the operator's next action becomes anticipatable.`,
          },
        },
      },
    },
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const r = await fetch(emitUrl, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function resolveObsidianBehaviorScan(
  pointer: ObsidianBehaviorScanPointer,
): Promise<ResolverResult> {
  const endpoint = (pointer.obsidianEndpoint ?? DEFAULT_OBSIDIAN_ENDPOINT).replace(/\/+$/, "");
  const conceptBase = (pointer.conceptDbBase ?? DEFAULT_CONCEPT_DB).replace(/\/+$/, "");
  const emitUrl = pointer.emitGapUrl ?? DEFAULT_DEV_VESSEL_URL;
  const apiKey = pointer.apiKey ?? API_KEY;
  const minSamples = pointer.minSamples ?? 3;
  const inconsistentThreshold = pointer.inconsistentThreshold ?? 0.5;
  const eventLimit = pointer.eventLimit ?? 5000;
  const substratePrefixes = pointer.substrateWritePrefixes ?? DEFAULT_SUBSTRATE_WRITE_PREFIXES;
  const timeoutMs = pointer.timeoutMs ?? 12_000;
  const generatedAt = new Date().toISOString();

  if (!apiKey) {
    return { shape: "obsidianBehaviorModel", body: { error: "missing_api_key", modeled: 0 } };
  }
  const auth = { "Content-Type": "application/json", Authorization: `ApiKey ${apiKey}` };

  // 1. Read the human's observed actions (reads only — never executes).
  let events: ObservedEvent[] = [];
  try {
    const res = await fetch(`${endpoint}/resolve`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ impulse: { pointer: { type: "obsidian:event_observed", limit: eventLimit } } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as { content?: string; error?: string };
    if (json.error) {
      return { shape: "obsidianBehaviorModel", body: { endpoint, modeled: 0, probe_error: json.error, generated_at: generatedAt } };
    }
    const parsed = json.content ? (JSON.parse(json.content) as { events?: ObservedEvent[] }) : {};
    events = Array.isArray(parsed.events) ? parsed.events : [];
  } catch (err) {
    return {
      shape: "obsidianBehaviorModel",
      body: { endpoint, modeled: 0, unreachable: true, error: err instanceof Error ? err.message.slice(0, 200) : String(err), generated_at: generatedAt },
    };
  }

  // PROVENANCE FILTER: drop the substrate's OWN writes (file events under the
  // sync/write roots — the concept-sync flood). What remains is operator signal:
  // workspace events (active-leaf/editor/layout/command) + file edits to the
  // operator's own notes. Without this the model just relearns the substrate.
  const totalEvents = events.length;
  const isSubstrateWrite = (e: ObservedEvent): boolean =>
    FILE_EVENT_KINDS.has(e.kind ?? "") &&
    typeof e.sync_root_relative_path === "string" &&
    substratePrefixes.some((pfx) => e.sync_root_relative_path!.startsWith(pfx));
  const operatorEvents = events.filter((e) => !isSubstrateWrite(e));
  const substrateFiltered = totalEvents - operatorEvents.length;

  // 2. Build the forward model P(next-kind | current-kind) from ordered transitions.
  const ordered = operatorEvents
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

  const models: BehaviorModel[] = [];
  for (const [current, nexts] of transitions) {
    const samples = [...nexts.values()].reduce((a, b) => a + b, 0);
    if (samples < minSamples) continue;
    let modalKind = "";
    let modalCount = 0;
    for (const [k, c] of nexts) if (c > modalCount) { modalCount = c; modalKind = k; }
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

  // 3. Persist one obsidian_behavior prior per modeled current-kind; emit gaps
  //    for unpredictable kinds (the autonomous-improvement driver).
  let persisted = 0;
  let perr = 0;
  let gapsEmitted = 0;
  for (const m of models) {
    try {
      const res = await fetch(`${conceptBase}/v2/impulses/resolve`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          impulse: {
            pointer: {
              type: "concept_create_write",
              conceptData: {
                shape: "obsidian_behavior",
                source_type: "extracted",
                summary: `after "${m.current_kind}" the operator most often does "${m.expected_next_kind}" (${(m.consistency * 100).toFixed(0)}% over ${m.samples})`,
                content: JSON.stringify(m),
                priority: 0.5,
                budget: 1500,
              },
            },
          },
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) persisted++;
      else perr++;
    } catch {
      perr++;
    }
    if (m.deviation_fraction >= inconsistentThreshold && m.distinct_next_kinds >= 3) {
      if (await emitInconsistentGap(emitUrl, apiKey, m)) gapsEmitted++;
    }
  }

  // CHANNEL-POLLUTION SELF-DETECTION. The EXPECTATION is a diverse human-action
  // stream (open/modify/search/navigate). A stream dominated by one kind means
  // the human signal is absent — almost always because the substrate's OWN writes
  // (concept-sync materializing notes = file-create floods) swamp and evict the
  // operator's events from the observable window. The substrate cannot learn the
  // human until operator-originated events are separated from substrate-originated
  // ones (provenance). Surface that as a gap so the loop can author the fix.
  const kindCounts = new Map<string, number>();
  for (const e of ordered) kindCounts.set(e.kind!, (kindCounts.get(e.kind!) ?? 0) + 1);
  let dominantKind = "";
  let dominantCount = 0;
  for (const [k, c] of kindCounts) if (c > dominantCount) { dominantCount = c; dominantKind = k; }
  const dominantFraction = ordered.length ? dominantCount / ordered.length : 0;
  let channelPolluted = false;
  if (ordered.length >= 20 && dominantFraction >= 0.9) {
    channelPolluted = true;
    const m = {
      impulse: {
        pointer: {
          type: "substrateGap_write",
          gap: {
            id: "obsidian_observation_channel_polluted",
            category: "obsidian_observation_channel_polluted",
            source: "substrate_detected",
            summary:
              `The obsidian observation channel is monotonic: ${(dominantFraction * 100).toFixed(0)}% of the last ` +
              `${ordered.length} observed events are "${dominantKind}" (only ${kindCounts.size} distinct kind(s)). ` +
              `The operator's interaction signal is absent/evicted — almost certainly the substrate's own writes ` +
              `(concept-sync note materialization) flooding event_observed. The human forward model cannot learn ` +
              `until operator-originated events are separated from substrate-originated ones.`,
            detected_at: new Date().toISOString(),
            status: "open",
            classification_metadata: {
              detector: "obsidian_behavior_scan",
              gap_class: "obsidian_observation_channel_polluted",
              dominant_kind: dominantKind,
              dominant_fraction: Number(dominantFraction.toFixed(3)),
              distinct_kinds: kindCounts.size,
              events_observed: ordered.length,
              suggested_remediation:
                `Tag obsidian:event_observed with provenance (operator vs substrate-write) so the behavior scan ` +
                `can filter to operator-originated events; or have obsidian-vessel exclude its own concept-sync ` +
                `file-create writes from the observed-event log.`,
            },
          },
        },
      },
    };
    try {
      const r = await fetch(emitUrl, { method: "POST", headers: auth, body: JSON.stringify(m), signal: AbortSignal.timeout(10_000) });
      if (r.ok) gapsEmitted++;
    } catch { /* emit best-effort */ }
  }

  return {
    shape: "obsidianBehaviorModel",
    body: {
      endpoint,
      total_events_pulled: totalEvents,
      substrate_writes_filtered: substrateFiltered,
      events_observed: ordered.length,
      distinct_kinds: kindCounts.size,
      dominant_kind: dominantKind,
      dominant_fraction: Number(dominantFraction.toFixed(3)),
      channel_polluted: channelPolluted,
      transitions: [...transitions.values()].reduce((a, m) => a + [...m.values()].reduce((x, y) => x + y, 0), 0),
      modeled: models.length,
      persisted,
      persist_errors: perr,
      gaps_emitted: gapsEmitted,
      models: models.map((m) => ({ current_kind: m.current_kind, expected_next_kind: m.expected_next_kind, consistency: Number(m.consistency.toFixed(2)), samples: m.samples })),
      generated_at: generatedAt,
    },
  };
}
