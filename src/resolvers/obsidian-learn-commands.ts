import type { ResolverResult } from "./types.js";

/**
 * obsidian_learn_commands (2026-06-15) — the AUTONOMOUS learn loop, in-substrate.
 *
 * Closes "observe → learn → gate → act" by making the LEARN step a dispatchable
 * substrate resolver instead of an operator-run shell script
 * (scripts/substrate/obsidian-learning-probe.sh). Flow:
 *
 *   1. Dispatch `obsidian:action_effect_model` to an Obsidian instance with a
 *      portable GRANT (default `['navigate']`). The plugin batch-probes only the
 *      commands the grant covers — navigation/UI commands are non-destructive
 *      and structurally observable on ANY vault, so this needs no probe-vault
 *      confinement and no host-specific config (the old `probe_vault_path` gate
 *      is gone; safety is the capability model).
 *   2. Persist each returned effect-model into concept-db as a durable
 *      `obsidian_action_effect` prior (`concept_create_write`). This is what
 *      turns "the probe ran" into "the substrate learned" — and it now lives
 *      inside an exercisable activity, not a shell loop.
 *
 * To learn `mutate`/`destructive` commands, the caller must explicitly widen
 * `granted_classes` AND target an instance whose posture permits it — a
 * deliberate, content-observable elevation, never the default.
 */

const DEFAULT_OBSIDIAN_ENDPOINT =
  process.env["OBSIDIAN_PROBE_ENDPOINT"] ?? "http://host.docker.internal:27184";
const DEFAULT_CONCEPT_DB = process.env["CONCEPT_DB_ENDPOINT"] ?? "http://127.0.0.1:8260";
const API_KEY = process.env["METABOB_API_KEY"] ?? process.env["DEV_VESSEL_API_KEY"];

export type ObsidianGrantClass = "read" | "navigate" | "mutate" | "destructive";

export interface ObsidianLearnCommandsPointer {
  type: "obsidian_learn_commands";
  /** Defaults to the probe instance; point at 27183 for real-vault navigation. */
  obsidianEndpoint?: string;
  conceptDbBase?: string;
  apiKey?: string;
  /** Authority granted to the probe. Default `['navigate']` — safe on any vault. */
  grantedClasses?: ObsidianGrantClass[];
  /** Max commands to probe in one invocation (plugin caps at 10). */
  maxCommands?: number;
  timeoutMs?: number;
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
  const grantedClasses = pointer.grantedClasses ?? ["navigate"];
  const maxCommands = pointer.maxCommands ?? 10;
  const timeoutMs = pointer.timeoutMs ?? 180_000;
  const generatedAt = new Date().toISOString();

  if (!apiKey) {
    return { shape: "obsidianLearnResult", body: { error: "missing_api_key", learned: 0, persisted: 0 } };
  }
  const auth = { "Content-Type": "application/json", Authorization: `ApiKey ${apiKey}` };

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
