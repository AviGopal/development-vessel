import type { ResolverResult } from "./types.js";
import { resolveObsidianCommandGate } from "./obsidian-command-gate.js";

/**
 * obsidian_execute_gated (2026-06-13) — the GATED EXECUTE path: the substrate
 * dispatches a single Obsidian command, but only after the learned-prior gate
 * (obsidian_command_gate) clears it. This is the operational close of the
 * manipulability loop: observe → learn effects → gate → ACT.
 *
 * Flow (conditionality in code, not a fragile task-graph branch):
 *   1. Ask obsidian_command_gate (operate mode) to classify command_id against
 *      the learned obsidian_action_effect priors.
 *   2. verdict=allow  → POST obsidian:execute_command to the obsidian endpoint
 *                       (defaults to the PROBE instance — real-vault execution
 *                       is an explicit endpoint opt-in, never the default).
 *      verdict!=allow → REFUSE; the command never reaches the plugin. The
 *                       refusal carries the gate's reason (deny / escalate /
 *                       unobserved) so it is auditable.
 *
 * Two safety layers: this gate (learned-reversible only) is the ceiling; the
 * plugin's execute_command resolver enforces deny-globs + irreversibility as
 * an independent in-process floor.
 */

const DEFAULT_OBSIDIAN_ENDPOINT =
  process.env["OBSIDIAN_PROBE_ENDPOINT"] ?? "http://host.docker.internal:27184";
const API_KEY = process.env["METABOB_API_KEY"] ?? process.env["DEV_VESSEL_API_KEY"];

export interface ObsidianExecuteGatedPointer {
  type: "obsidian_execute_gated";
  command_id: string;
  /** Defaults to the probe instance. Point at 27183 for real-vault operation. */
  obsidianEndpoint?: string;
  conceptDbBase?: string;
  apiKey?: string;
  mode?: "operate" | "learn";
  timeoutMs?: number;
}

interface GateBody {
  command_verdicts?: Array<{ command_id: string; verdict: string; reason: string; reversibility_class: string | null }>;
}

export async function resolveObsidianExecuteGated(
  pointer: ObsidianExecuteGatedPointer,
): Promise<ResolverResult> {
  const commandId = pointer.command_id;
  const endpoint = (pointer.obsidianEndpoint ?? DEFAULT_OBSIDIAN_ENDPOINT).replace(/\/+$/, "");
  const apiKey = pointer.apiKey ?? API_KEY;
  const mode = pointer.mode ?? "operate";
  const timeoutMs = pointer.timeoutMs ?? 30_000;
  const generatedAt = new Date().toISOString();

  if (!commandId) {
    return { shape: "gatedExecuteResult", body: { error: "command_id is required", executed: false } };
  }

  // 1. Consult the learned-prior gate.
  const gate = await resolveObsidianCommandGate({
    type: "obsidian_command_gate",
    command_ids: [commandId],
    mode,
    ...(pointer.conceptDbBase ? { conceptDbBase: pointer.conceptDbBase } : {}),
    ...(apiKey ? { apiKey } : {}),
  });
  const gv = (gate.body as GateBody).command_verdicts?.[0];
  const verdict = gv?.verdict ?? "deny";
  const reason = gv?.reason ?? "no gate verdict";

  if (verdict !== "allow") {
    return {
      shape: "gatedExecuteResult",
      body: {
        command_id: commandId,
        executed: false,
        gate_verdict: verdict,
        gate_reason: reason,
        reversibility_class: gv?.reversibility_class ?? null,
        refused: true,
        endpoint,
        generated_at: generatedAt,
      },
    };
  }

  // 2. Gate cleared → dispatch the command to the obsidian plugin.
  if (!apiKey) {
    return { shape: "gatedExecuteResult", body: { command_id: commandId, executed: false, error: "missing_api_key" } };
  }
  try {
    const res = await fetch(`${endpoint}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${apiKey}` },
      body: JSON.stringify({ impulse: { pointer: { type: "obsidian:execute_command", command_id: commandId } } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as { success?: boolean; content?: string; error?: string };
    let effect: unknown = null;
    if (json.content) {
      try { effect = JSON.parse(json.content); } catch { effect = json.content; }
    }
    return {
      shape: "gatedExecuteResult",
      body: {
        command_id: commandId,
        executed: json.success === true,
        gate_verdict: "allow",
        gate_reason: reason,
        endpoint,
        effect,
        ...(json.error ? { plugin_error: json.error } : {}),
        generated_at: generatedAt,
      },
    };
  } catch (err) {
    return {
      shape: "gatedExecuteResult",
      body: {
        command_id: commandId,
        executed: false,
        gate_verdict: "allow",
        endpoint,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
        generated_at: generatedAt,
      },
    };
  }
}
