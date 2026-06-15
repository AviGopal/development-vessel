import type { ResolverResult } from "./types.js";

/**
 * obsidian_learn_commands (2026-06-15) — the AUTONOMOUS learn loop, in-substrate.
 *
 * Closes "observe → learn → gate → act" by making the LEARN step a dispatchable
 * substrate resolver instead of an operator-run shell script. Two modes:
 *
 * - **catalog** (DEFAULT, non-intrusive — the autonomous-tick path): read the
 *   vessel's `obsidian:command_catalog` and persist each command's classification
 *   (`permission_class` + `reversibility_class` + deny status) as an
 *   `obsidian_action_effect` prior. This learns the FULL controllable surface
 *   WITHOUT executing anything, so it is safe on the LIVE vault the operator is
 *   using (no UI shuffling, no probe-vault dependency). Idempotent: only NEW
 *   commands (absent from existing priors) are persisted, so the 30-min tick
 *   doesn't bloat concept-db. This is what feeds `obsidian_command_gate`.
 *
 * - **probe** (opt-in, intrusive): dispatch `obsidian:action_effect_model` to
 *   EXECUTE the grant-covered command subset and learn P(post-state | command).
 *   Execution changes UI state, so this wants an isolated instance + an explicit
 *   grant — never the autonomous default. Widen `granted_classes` for
 *   mutate/destructive (a deliberate, content-observable elevation).
 *
 * The old probe-vault confinement is gone (capability model is the safety floor);
 * catalog mode makes the non-intrusive half run autonomously on the live vault.
 */

const DEFAULT_OBSIDIAN_ENDPOINT =
  process.env["OBSIDIAN_LEARN_ENDPOINT"] ?? process.env["OBSIDIAN_PROBE_ENDPOINT"] ?? "http://host.docker.internal:27183";
const DEFAULT_CONCEPT_DB = process.env["CONCEPT_DB_ENDPOINT"] ?? "http://127.0.0.1:8260";
const API_KEY = process.env["METABOB_API_KEY"] ?? process.env["DEV_VESSEL_API_KEY"];

export type ObsidianGrantClass = "read" | "navigate" | "mutate" | "destructive";

export interface ObsidianLearnCommandsPointer {
  type: "obsidian_learn_commands";
  /**
   * "catalog" (default) = non-intrusive surface learning from command_catalog,
   * safe on the live vault. "probe" = execution-based effect learning (intrusive).
   */
  learnMode?: "catalog" | "probe";
  /** Defaults to the LIVE vault (27183). Catalog mode is read-only there. */
  obsidianEndpoint?: string;
  conceptDbBase?: string;
  apiKey?: string;
  /** Authority granted in PROBE mode. Default `['navigate']`. */
  grantedClasses?: ObsidianGrantClass[];
  /** Max commands to probe per invocation in PROBE mode (plugin caps at 10). */
  maxCommands?: number;
  /** Max catalog commands to classify per invocation in CATALOG mode. */
  maxCatalog?: number;
  timeoutMs?: number;
}

interface CatalogCommand {
  id: string;
  name?: string;
  permission_class?: string;
  reversibility_class?: string;
  deny_blocked?: boolean;
}

/** Read the command_ids already classified, so catalog mode only persists NEW ones. */
async function knownCommandIds(
  conceptBase: string,
  auth: Record<string, string>,
  timeoutMs: number,
): Promise<Set<string>> {
  const known = new Set<string>();
  try {
    const res = await fetch(`${conceptBase}/concepts/search?shape=obsidian_action_effect&limit=500`, {
      headers: auth,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return known;
    const json = (await res.json()) as { concepts?: Array<{ content?: string }> };
    for (const c of json.concepts ?? []) {
      try {
        const parsed = JSON.parse(c.content ?? "{}") as { command_id?: string };
        if (parsed.command_id) known.add(parsed.command_id);
      } catch { /* skip unparseable */ }
    }
  } catch { /* unreachable concept-db → treat all as new (best-effort) */ }
  return known;
}

/**
 * CATALOG mode: read obsidian:command_catalog (no execution) and persist
 * classification priors for commands not yet known. Non-intrusive, live-vault-safe.
 */
async function learnViaCatalog(
  endpoint: string,
  conceptBase: string,
  auth: Record<string, string>,
  maxCatalog: number,
  timeoutMs: number,
  generatedAt: string,
): Promise<ResolverResult> {
  let commands: CatalogCommand[] = [];
  try {
    const res = await fetch(`${endpoint}/resolve`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ impulse: { pointer: { type: "obsidian:command_catalog" } } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as { content?: string; error?: string };
    if (json.error) {
      return { shape: "obsidianLearnResult", body: { mode: "catalog", endpoint, learned: 0, persisted: 0, probe_error: json.error, generated_at: generatedAt } };
    }
    const parsed = json.content ? (JSON.parse(json.content) as { commands?: CatalogCommand[] }) : {};
    commands = Array.isArray(parsed.commands) ? parsed.commands : [];
  } catch (err) {
    // Vessel unreachable → IDLE (external app may be disconnected), never a hard error.
    return {
      shape: "obsidianLearnResult",
      body: { mode: "catalog", endpoint, learned: 0, persisted: 0, unreachable: true, error: err instanceof Error ? err.message.slice(0, 200) : String(err), generated_at: generatedAt },
    };
  }

  const known = await knownCommandIds(conceptBase, auth, timeoutMs);
  const fresh = commands.filter((c) => c.id && !known.has(c.id)).slice(0, maxCatalog);

  let persisted = 0;
  let perr = 0;
  for (const c of fresh) {
    const model = {
      command_id: c.id,
      name: c.name ?? c.id,
      permission_class: c.permission_class ?? "unknown",
      reversibility_class: c.reversibility_class ?? "unknown",
      deny_blocked: c.deny_blocked ?? false,
      observation_count: 0,
      source: "catalog_classification",
    };
    try {
      const res = await fetch(`${conceptBase}/v2/impulses/resolve`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          impulse: {
            pointer: {
              type: "concept_create_write",
              conceptData: {
                shape: "obsidian_action_effect",
                source_type: "extracted",
                summary: `obsidian command ${c.id}: ${model.permission_class}/${model.reversibility_class} (catalog classification)`,
                content: JSON.stringify(model),
                priority: 0.4,
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
  }

  return {
    shape: "obsidianLearnResult",
    body: {
      mode: "catalog",
      endpoint,
      catalog_size: commands.length,
      already_known: known.size,
      learned: fresh.length,
      persisted,
      persist_errors: perr,
      newly_classified: fresh.map((c) => ({ command_id: c.id, permission_class: c.permission_class, reversibility_class: c.reversibility_class })),
      generated_at: generatedAt,
    },
  };
}

interface ActionEffectModel {
  command_id: string;
  observation_count: number;
  post_signature_distribution: Array<{ post_signature: string; probability: number }>;
  reversibility_class: string;
}

export async function resolveObsidianLearnCommands(
  pointer: ObsidianLearnCommandsPointer,
): Promise<ResolverResult> {
  const endpoint = (pointer.obsidianEndpoint ?? DEFAULT_OBSIDIAN_ENDPOINT).replace(/\/+$/, "");
  const conceptBase = (pointer.conceptDbBase ?? DEFAULT_CONCEPT_DB).replace(/\/+$/, "");
  const apiKey = pointer.apiKey ?? API_KEY;
  const learnMode = pointer.learnMode ?? "catalog";
  const grantedClasses = pointer.grantedClasses ?? ["navigate"];
  const maxCommands = pointer.maxCommands ?? 10;
  const maxCatalog = pointer.maxCatalog ?? 300;
  const timeoutMs = pointer.timeoutMs ?? 180_000;
  const generatedAt = new Date().toISOString();

  if (!apiKey) {
    return { shape: "obsidianLearnResult", body: { error: "missing_api_key", learned: 0, persisted: 0 } };
  }
  const auth = { "Content-Type": "application/json", Authorization: `ApiKey ${apiKey}` };

  // CATALOG mode (default): non-intrusive surface learning, safe on the live vault.
  if (learnMode === "catalog") {
    return learnViaCatalog(endpoint, conceptBase, auth, maxCatalog, Math.min(timeoutMs, 15_000), generatedAt);
  }

  // PROBE mode (opt-in, intrusive): execute the grant-covered command subset.
  // 1. Batch-probe the grant-covered command subset.
  let models: ActionEffectModel[] = [];
  try {
    const res = await fetch(`${endpoint}/resolve`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        impulse: { pointer: { type: "obsidian:action_effect_model", granted_classes: grantedClasses, max_commands: maxCommands } },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as { content?: string; error?: string };
    if (json.error) {
      return { shape: "obsidianLearnResult", body: { endpoint, learned: 0, persisted: 0, probe_error: json.error, generated_at: generatedAt } };
    }
    const parsed = json.content ? (JSON.parse(json.content) as { models?: ActionEffectModel[] }) : {};
    models = Array.isArray(parsed.models) ? parsed.models : [];
  } catch (err) {
    return {
      shape: "obsidianLearnResult",
      body: {
        endpoint,
        learned: 0,
        persisted: 0,
        // Unreachable instance is IDLE (external app may be disconnected), not a hard error.
        unreachable: true,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
        generated_at: generatedAt,
      },
    };
  }

  // 2. Persist each model as a durable obsidian_action_effect prior.
  let persisted = 0;
  let perr = 0;
  for (const m of models) {
    try {
      const summary = `obsidian command ${m.command_id} → ${m.reversibility_class} (${m.observation_count} obs, ${(m.post_signature_distribution ?? []).length} post-state(s))`;
      const res = await fetch(`${conceptBase}/v2/impulses/resolve`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          impulse: {
            pointer: {
              type: "concept_create_write",
              conceptData: {
                shape: "obsidian_action_effect",
                source_type: "extracted",
                summary,
                content: JSON.stringify(m),
                priority: 0.5,
                budget: 2000,
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
  }

  return {
    shape: "obsidianLearnResult",
    body: {
      endpoint,
      granted_classes: grantedClasses,
      learned: models.length,
      persisted,
      persist_errors: perr,
      commands: models.map((m) => ({ command_id: m.command_id, reversibility_class: m.reversibility_class })),
      generated_at: generatedAt,
    },
  };
}
