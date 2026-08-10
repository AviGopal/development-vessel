import { promises as fs } from "node:fs";
import path from "node:path";
import { METABOB_ENDPOINT, METABOB_API_KEY, DISCOVERY_ENDPOINT } from "../config.js";
import type { ResolverResult } from "./types.js";

/**
 * vessel_gap_to_cluster (2026-06-14) — the PRODUCER adapter that lets the
 * substrate author a GENUINE consumer for a vessel-arrival gap.
 *
 * The gap drafter (draft-gap-closing-activity) authors scaffold-clones
 * (read_scenario → analyse → write a *Proposal) — caught by
 * consumer_productivity_audit, refused by the arrival-scan gate. The REAL
 * resolver-chain author is `draft-activity-from-pattern`, but it consumes a
 * `recurringPatternCluster` (observed trace topology), NOT a registry-gap
 * scenario. This resolver bridges the two: it synthesises a cluster whose
 * expected_outputs is `concept_create_write` (a genuine state-write — exactly
 * what productivity requires) and whose topology_hint instructs the author to
 * FETCH the orphaned shape from its owning vessel and PERSIST extracted signal
 * to concept-db. The author then composes a real fetch→classify→persist chain
 * instead of a meta-activity.
 *
 * Deterministic: no LLM, no business decision — it only reshapes a known gap
 * into the cluster contract the real author already understands. Optionally
 * dispatches the author (goal-host /run-goal) so the loop is autonomous.
 *
 * Honesty note: an authored chain is `declared_unproven` until it EXECUTES and
 * emits concept_create_write (which, for an external app like Obsidian, needs
 * the app live). The frontier will not read "integrated" until then — by design.
 */

// WRITE THE PATTERN WHERE THE READER IS ALLOWED TO LOOK.
//
// This wrote to the literal /workspace/patterns, but the drafter it dispatches
// (development-vessel:draft-activity-from-pattern) opens that path with fs_read,
// which enforces containment inside WORKSPACE_ROOT (/workspace/git/super-repo).
// So every dispatch died on:
//
//   [engine] execution ... template activity:<development-vessel:draft-activity-from-pattern>
//   failed after 1 task(s): dev-vessel fs_read HTTP 500: {"error":"path outside workspace"}
//
// which is why 45 orphaned-capability gaps — the single largest family in the
// backlog — could not be drained: the clusterer succeeded, wrote its pattern, and
// handed the drafter a path it was forbidden to read.
//
// Only NEW patterns need to move: the drafter reads the file this call just wrote,
// never the directory, so the 104 files already under /workspace/patterns are not
// stranded by this and need no migration.
const DEFAULT_PATTERNS_DIR = path.join(
  process.env["WORKSPACE_ROOT"] ?? "/workspace",
  "patterns",
);
const DEFAULT_CONCEPT_DB = process.env["CONCEPT_DB_ENDPOINT"] ?? "http://127.0.0.1:8260";
const DEFAULT_GOAL_HOST = process.env["GOAL_HOST_ENDPOINT"] ?? "http://127.0.0.1:8210";
const DRAFTER_TEMPLATE_ID = "development-vessel:draft-activity-from-pattern";

export interface VesselGapToClusterPointer {
  type: "vessel_gap_to_cluster";
  /** The orphaned/uncovered shape to author a consumer for. */
  shape: string;
  /** Owning vessel id (for the summary); endpoint is looked up from discovery. */
  vesselId?: string;
  patternsDir?: string;
  conceptDbEndpoint?: string;
  discoveryEndpoint?: string;
  goalHostEndpoint?: string;
  metabobEndpoint?: string;
  apiKey?: string;
  /** When true, dispatch draft-activity-from-pattern on the written cluster. */
  dispatch?: boolean;
  timeoutMs?: number;
}

interface RegistryVessel {
  vesselId: string;
  shapes?: string[];
  endpoint?: string;
  resolve_endpoint?: string;
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

/** Find the live vessel that advertises `shape` and return (id, resolve endpoint). */
async function lookupOwningVessel(
  discovery: string,
  apiKey: string,
  shape: string,
  timeoutMs: number,
): Promise<{ vesselId: string; endpoint: string } | null> {
  try {
    const res = await fetch(`${discovery.replace(/\/+$/, "")}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${apiKey}` },
      body: JSON.stringify({ pointer: { type: "vesselRegistry" } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { content?: { vessels?: RegistryVessel[] }; vessels?: RegistryVessel[] };
    const vessels = json.content?.vessels ?? json.vessels ?? [];
    const owner = vessels.find((v) => (v.shapes ?? []).includes(shape));
    if (!owner) return null;
    return { vesselId: owner.vesselId, endpoint: owner.resolve_endpoint ?? owner.endpoint ?? "" };
  } catch {
    return null;
  }
}

/** A few concept ids to cite (best-effort; empty is acceptable). */
async function fetchConceptIds(
  conceptDb: string,
  apiKey: string,
  shape: string,
  timeoutMs: number,
): Promise<string[]> {
  try {
    const res = await fetch(`${conceptDb.replace(/\/+$/, "")}/v2/impulses/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${apiKey}` },
      body: JSON.stringify({ impulse: { pointer: { type: "concept_search_by_source", source: shape, limit: 5 } } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { content?: { concepts?: Array<{ id?: string }> }; concepts?: Array<{ id?: string }> };
    const concepts = json.content?.concepts ?? json.concepts ?? [];
    return concepts.map((c) => c.id ?? "").filter(Boolean).slice(0, 5);
  } catch {
    return [];
  }
}

function buildCluster(args: {
  patternId: string;
  shape: string;
  vesselId: string;
  vesselEndpoint: string;
  conceptDb: string;
  conceptIds: string[];
  generatedAt: string;
}): Record<string, unknown> {
  const { patternId, shape, vesselId, vesselEndpoint, conceptDb, conceptIds, generatedAt } = args;
  const ep = vesselEndpoint || "the owning vessel's resolve endpoint";
  return {
    pattern_id: patternId,
    summary:
      `Vessel ${vesselId} advertises shape ${shape} but no PRODUCTIVE consumer turns it into a ` +
      `downstream impulse — a scaffold-clone that merely declares it as input does not count. ` +
      `Author the smallest real resolver chain that FETCHES ${shape} from ${vesselId} and PERSISTS ` +
      `extracted signal as concept_create_write, so the substrate gains a genuine selectable action ` +
      `over ${vesselId}. This is a vessel-shape bridge, not a meta-activity.`,
    observation_window: `${generatedAt}/${generatedAt}`,
    n_observations: 1,
    n_contrast_examples: 0,
    n_concept_citations_available: conceptIds.length,
    available_concept_ids: conceptIds,
    expected_inputs: [shape],
    // The genuine state-write that makes the authored consumer PRODUCTIVE. Use
    // the TYPED concept_write resolver (emits conceptCreateResult) — NOT a raw
    // http_fetch POST, which (a) needs hand-built JSON that the LLM gets wrong
    // (400 Invalid JSON body) and (b) records its output as `httpResponse`, so
    // a 400 ghost-succeeds and no concept is actually minted.
    expected_outputs: ["conceptCreateResult"],
    topology_hint:
      `1. http_fetch the ${shape} data from ${vesselId} at ${ep}. ` +
      `Use the vessel's documented READ path that returns ACTUAL content (not a lazy pointer stub): ` +
      `for activity-api read shapes that is a GET to its REST route ` +
      `(e.g. executionTraceList → GET ${ep}/v2/activities/execution-traces?limit=20; ` +
      `activityMetrics/thompson_posterior → the matching /v2/activities GET); ` +
      `for a vessel resolver shape it is POST ${ep}/v2/impulses/resolve with body ` +
      `{"impulse":{"pointer":{"type":"${shape}"}}}. Pick whichever returns real rows. ` +
      `2. llm_completion_dispatch: classify/summarise the fetched content into a short concept summary. ` +
      `3. Persist with the TYPED concept_write resolver (NOT raw http_fetch): config ` +
      `{"type":"concept_write","name":"<short title>","content":"{{<classify_task>_text}}",` +
      `"source_type":"extracted"}. This resolver builds the concept-db body itself, emits ` +
      `conceptCreateResult on real success, and emits structuredError (a FAILURE, not a ghost ` +
      `success) if the write is rejected — so the trace cannot lie about minting a concept. ` +
      `The LAST task MUST be this concept_write and emit conceptCreateResult. ` +
      `Do NOT author a read_scenario → analyse → write-a-Proposal scaffold; emit no *Proposal output. ` +
      `Do NOT POST concept_create_write via raw http_fetch — use concept_write.`,
    deny_list: ["fs_read of a scenario file", "activityTemplateProposal", "patch_proposal", "raw http_fetch to concept-db"],
    bridge_source: "vessel_gap_to_cluster",
    target_shape: shape,
  };
}

async function dispatchAuthor(
  goalHost: string,
  apiKey: string,
  patternId: string,
  patternsDir: string,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${goalHost.replace(/\/+$/, "")}/run-goal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${apiKey}` },
      body: JSON.stringify({
        goal: `author a vessel-shape bridge consumer from pattern ${patternId}`,
        targetTemplateId: DRAFTER_TEMPLATE_ID,
        // activity_api_endpoint: the drafter's prime_vocabulary task fetches
        // activity-api. Its default is loopback, which is dead on a spoke (role "api"
        // is hub-only), so pass the configured endpoint or the drafter dies at task 2.
        variables: {
          pattern_id: patternId,
          patterns_dir: patternsDir,
          activity_api_endpoint: process.env["ACTIVITY_API_ENDPOINT"] ?? process.env["ACTIVITY_API_URL"] ?? "http://127.0.0.1:8080",
          source: "vessel_gap_to_cluster",
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return { ok: res.ok, detail: text.slice(0, 200) };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message.slice(0, 120) : "dispatch error" };
  }
}

export async function resolveVesselGapToCluster(
  pointer: VesselGapToClusterPointer,
): Promise<ResolverResult> {
  const shape = pointer.shape;
  const metabob = pointer.metabobEndpoint ?? METABOB_ENDPOINT;
  const apiKey = pointer.apiKey ?? METABOB_API_KEY;
  const discovery = pointer.discoveryEndpoint ?? DISCOVERY_ENDPOINT;
  const conceptDb = pointer.conceptDbEndpoint ?? DEFAULT_CONCEPT_DB;
  const goalHost = pointer.goalHostEndpoint ?? DEFAULT_GOAL_HOST;
  const patternsDir = pointer.patternsDir ?? DEFAULT_PATTERNS_DIR;
  const timeoutMs = pointer.timeoutMs ?? 8000;
  const generatedAt = new Date().toISOString();
  void metabob;

  if (!shape) {
    return { shape: "vesselBridgeCluster", body: { error: "no_shape_specified", generated_at: generatedAt } };
  }
  if (!apiKey) {
    return { shape: "vesselBridgeCluster", body: { error: "missing_api_key", generated_at: generatedAt } };
  }

  const owner = await lookupOwningVessel(discovery, apiKey, shape, timeoutMs);
  const vesselId = pointer.vesselId ?? owner?.vesselId ?? "unknown-vessel";
  const vesselEndpoint = owner?.endpoint ?? "";
  const conceptIds = await fetchConceptIds(conceptDb, apiKey, shape, timeoutMs);

  const patternId = `vessel-bridge-${slug(shape)}`;
  const cluster = buildCluster({ patternId, shape, vesselId, vesselEndpoint, conceptDb, conceptIds, generatedAt });

  let clusterPath = "";
  let writeError: string | null = null;
  try {
    await fs.mkdir(patternsDir, { recursive: true });
    clusterPath = path.join(patternsDir, `${patternId}.json`);
    await fs.writeFile(clusterPath, JSON.stringify(cluster, null, 2), "utf8");
  } catch (err) {
    writeError = err instanceof Error ? err.message.slice(0, 120) : "write error";
  }

  let dispatched: { ok: boolean; detail: string } | null = null;
  if (pointer.dispatch && !writeError) {
    dispatched = await dispatchAuthor(goalHost, apiKey, patternId, patternsDir, timeoutMs);
  }

  return {
    shape: "vesselBridgeCluster",
    body: {
      generated_at: generatedAt,
      shape,
      vessel_id: vesselId,
      vessel_endpoint: vesselEndpoint || null,
      owner_found: owner !== null,
      pattern_id: patternId,
      cluster_path: clusterPath || null,
      expected_outputs: ["conceptCreateResult"],
      cited_concepts: conceptIds.length,
      ...(writeError ? { write_error: writeError } : {}),
      ...(dispatched ? { dispatched_to_author: dispatched.ok, dispatch_detail: dispatched.detail } : {}),
      next: pointer.dispatch
        ? "draft-activity-from-pattern dispatched; inspect the authored variant + run consumer_productivity_audit"
        : `dispatch draft-activity-from-pattern with { pattern_id: ${patternId}, patterns_dir: ${patternsDir} }`,
    },
  };
}
