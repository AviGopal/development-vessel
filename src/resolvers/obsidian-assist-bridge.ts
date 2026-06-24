import { promises as fs } from "node:fs";
import path from "node:path";
import type { ResolverResult } from "./types.js";

/**
 * obsidian_assist_bridge (2026-06-15) — autonomous obsidian FUNCTIONALITY development.
 *
 * The arrival bridge authors OBSERVE activities (read a vessel's shapes). This
 * bridge authors ASSIST activities — functionality that helps the operator — by
 * routing an assist goal into the same real-chain author (draft-activity-from-pattern).
 *
 * It only acts when there is live operator signal (obsidian_behavior priors exist),
 * so the substrate develops functionality for an ACTIVE operator, not in a vacuum.
 * For each assist CLASS it writes a deterministic recurringPatternCluster and
 * dispatches the author ONCE (anti-spam by cluster-file existence). The authored
 * activity is hard-bounded to NON-INTRUSIVE behaviour: read-only obsidian shapes +
 * write ONLY via obsidian:write_note under Substrate/Assists/ (the plugin refuses
 * any other path). The operator's reaction to the delivered assist is observable
 * via obsidian_behavior_scan and grades the activity via Thompson — useful assists
 * are kept, useless ones pruned. Side-loop, never core boredom.
 */

const DEFAULT_CONCEPT_DB = process.env["CONCEPT_DB_ENDPOINT"] ?? "http://127.0.0.1:8260";
const DEFAULT_PATTERNS_DIR = process.env["PATTERNS_DIR"] ?? "/workspace/patterns";
const DEFAULT_GOAL_HOST = process.env["GOAL_HOST_ENDPOINT"] ?? "http://127.0.0.1:8210";
const DEFAULT_OBSIDIAN_ENDPOINT =
  process.env["OBSIDIAN_LEARN_ENDPOINT"] ?? process.env["OBSIDIAN_PLUGIN_ENDPOINT"] ?? "http://host.docker.internal:27183";
const DRAFTER_TEMPLATE_ID = "development-vessel:draft-activity-from-pattern";
const API_KEY = process.env["METABOB_API_KEY"] ?? process.env["DEV_VESSEL_API_KEY"];

export interface ObsidianAssistBridgePointer {
  type: "obsidian_assist_bridge";
  conceptDbBase?: string;
  patternsDir?: string;
  goalHostEndpoint?: string;
  obsidianEndpoint?: string;
  apiKey?: string;
  /** Skip the operator-signal gate (author even without behavior priors). */
  force?: boolean;
  timeoutMs?: number;
}

/** The first assist class — a non-intrusive active-note context assist. */
function assistClusters(resolveUrl: string): Array<{ id: string; cluster: Record<string, unknown> }> {
  const today = new Date().toISOString().slice(0, 10);
  return [
    {
      id: "obsidian-assist-active-note",
      cluster: {
        pattern_id: "obsidian-assist-active-note",
        summary:
          "The operator works in Obsidian and the substrate now reads their state but does NOT yet HELP them. " +
          "Author a NON-INTRUSIVE read-assist: observe the operator's current context and surface a useful " +
          "suggestion (related notes to link, a missing backlink, a one-line summary) into Substrate/Assists/ — " +
          "without ever touching the operator's own notes. This turns 'the substrate observes obsidian' into " +
          "'the substrate develops functionality FOR obsidian', graded by whether the operator acts on the suggestion.",
        observation_window: `${today}/${today}`,
        n_observations: 1,
        n_contrast_examples: 0,
        expected_inputs: [],
        expected_outputs: ["obsidianAssistDelivered"],
        topology_hint:
          `Author a MINIMAL non-intrusive assist activity named assist-active-note with EXACTLY ONE task. ` +
          `The task uses the deterministic primitive that performs the whole assist ATOMICALLY (so no cross-task ` +
          `data-flow / interpolation is needed): resolver "obsidian_deliver_assist", config {"type":"obsidian_deliver_assist"}, ` +
          `outputShapes ["obsidianAssistDelivered"]. That primitive reads the operator's obsidian:workspace_state, asks ` +
          `the llm tier for a short non-intrusive suggestion (related notes to link, a missing backlink, a one-line ` +
          `summary), and writes it to Substrate/Assists/ via obsidian:write_note — which the plugin hard-restricts to ` +
          `the Substrate/ namespace, so the operator's own notes are never touched. Declare the template input_shapes:[] ` +
          `and output_shapes:["obsidianAssistDelivered"]. The single task MUST emit obsidianAssistDelivered. Do NOT add ` +
          `http_fetch/llm tasks (the primitive does it all); do NOT author a read_scenario -> analyse -> write-Proposal scaffold.`,
        deny_list: ["execute_command", "concept_writeback", "write to operator notes", "read_scenario", "patch_proposal", "activityTemplateProposal"],
        bridge_source: "obsidian_assist_bridge",
        assist_class: "active-note-context",
      },
    },
  ];
}

async function fileExists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

async function hasOperatorSignal(conceptBase: string, auth: Record<string, string>, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`${conceptBase}/concepts/search?shape=obsidian_behavior&limit=5`, { headers: auth, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const json = (await res.json()) as { concepts?: unknown[] };
    return Array.isArray(json.concepts) && json.concepts.length > 0;
  } catch {
    return false;
  }
}

async function dispatchAuthor(goalHost: string, apiKey: string, patternId: string, patternsDir: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`${goalHost.replace(/\/+$/, "")}/run-goal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${apiKey}` },
      body: JSON.stringify({
        goal: `author an obsidian read-assist activity from pattern ${patternId}`,
        targetTemplateId: DRAFTER_TEMPLATE_ID,
        variables: { pattern_id: patternId, patterns_dir: patternsDir, source: "obsidian_assist_bridge" },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function resolveObsidianAssistBridge(
  pointer: ObsidianAssistBridgePointer,
): Promise<ResolverResult> {
  const conceptBase = (pointer.conceptDbBase ?? DEFAULT_CONCEPT_DB).replace(/\/+$/, "");
  const patternsDir = pointer.patternsDir ?? DEFAULT_PATTERNS_DIR;
  const goalHost = pointer.goalHostEndpoint ?? DEFAULT_GOAL_HOST;
  const obsidianEndpoint = (pointer.obsidianEndpoint ?? DEFAULT_OBSIDIAN_ENDPOINT).replace(/\/+$/, "");
  const apiKey = pointer.apiKey ?? API_KEY;
  const timeoutMs = pointer.timeoutMs ?? 10_000;
  const generatedAt = new Date().toISOString();
  const auth: Record<string, string> = apiKey ? { "Content-Type": "application/json", Authorization: `ApiKey ${apiKey}` } : { "Content-Type": "application/json" };

  if (!apiKey) {
    return { shape: "obsidianAssistBridgeReport", body: { error: "missing_api_key", clusters_written: 0, authors_dispatched: 0 } };
  }

  // Develop functionality only for an ACTIVE operator (live behavior signal).
  const operatorActive = pointer.force || (await hasOperatorSignal(conceptBase, auth, timeoutMs));
  if (!operatorActive) {
    return {
      shape: "obsidianAssistBridgeReport",
      body: { operator_active: false, note: "no obsidian_behavior signal yet — not developing assists in a vacuum", clusters_written: 0, authors_dispatched: 0, generated_at: generatedAt },
    };
  }

  await fs.mkdir(patternsDir, { recursive: true }).catch(() => {});
  let clustersWritten = 0;
  let authorsDispatched = 0;
  const errors: string[] = [];

  for (const { id, cluster } of assistClusters(`${obsidianEndpoint}/resolve`)) {
    const clusterFile = path.join(patternsDir, `${id}.json`);
    const existed = await fileExists(clusterFile);
    try {
      await fs.writeFile(clusterFile, JSON.stringify(cluster, null, 2), "utf8");
      clustersWritten += 1;
    } catch (err) {
      errors.push(`${id}:${err instanceof Error ? err.message.slice(0, 60) : "err"}`);
      continue;
    }
    // Dispatch the author once per assist class (anti-spam on cluster-file existence).
    if (!existed) {
      if (await dispatchAuthor(goalHost, apiKey, id, patternsDir, timeoutMs)) authorsDispatched += 1;
      else errors.push(`dispatch:${id}`);
    }
  }

  return {
    shape: "obsidianAssistBridgeReport",
    body: {
      operator_active: true,
      clusters_written: clustersWritten,
      authors_dispatched: authorsDispatched,
      assist_classes: assistClusters("").map((a) => a.id),
      ...(errors.length ? { errors } : {}),
      generated_at: generatedAt,
    },
  };
}
