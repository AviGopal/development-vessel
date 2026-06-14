import type { ResolverResult } from "./types.js";

/**
 * obsidian_command_gate (2026-06-13) — USE the learned action-effect priors to
 * gate Obsidian command dispatch.
 *
 * The probe (obsidian:action_effect_model) executes Obsidian commands in a
 * dedicated probe vault and persists per-command effect models to concept-db
 * (shape obsidian_action_effect) with a reversibility_class. This resolver is
 * the decision layer that consults those priors: given candidate command ids it
 * returns a dispatch verdict per command, and a deny-set that plugs straight
 * into the probe/dispatch `extra_deny_globs` hook — so the substrate's LEARNED
 * policy governs which commands it is willing to dispatch.
 *
 * Policy (operate mode, the default):
 *   reversible        → allow     (characterized as reversible in the probe vault)
 *   soft_irreversible → escalate  (human confirmation required)
 *   hard_irreversible → deny
 *   unknown           → escalate  (effect uncertain)
 *   UNOBSERVED        → deny       (never characterized — refuse until probed)
 * In learn mode UNOBSERVED → allow, so the probe is free to explore-and-learn
 * commands it hasn't seen; operate mode refuses anything not proven reversible.
 *
 * This is the manipulability gate: the substrate will only autonomously dispatch
 * Obsidian commands whose effects it has learned and judged safe.
 */

const DEFAULT_CONCEPT_DB = process.env["CONCEPT_DB_ENDPOINT"] ?? "http://127.0.0.1:8260";
const API_KEY = process.env["METABOB_API_KEY"] ?? process.env["DEV_VESSEL_API_KEY"];

type Reversibility = "reversible" | "soft_irreversible" | "hard_irreversible" | "unknown";
type Verdict = "allow" | "escalate" | "deny";

export interface ObsidianCommandGatePointer {
  type: "obsidian_command_gate";
  conceptDbBase?: string;
  apiKey?: string;
  /** Candidate command ids to classify. If absent, returns the learned allow-set. */
  command_ids?: string[];
  /** operate (default): unobserved→deny. learn: unobserved→allow (explore). */
  mode?: "operate" | "learn";
  timeoutMs?: number;
}

interface CommandVerdict {
  command_id: string;
  reversibility_class: Reversibility | null;
  observed: boolean;
  observation_count: number;
  verdict: Verdict;
  reason: string;
}

function decide(
  rev: Reversibility | null,
  observed: boolean,
  mode: "operate" | "learn",
): { verdict: Verdict; reason: string } {
  if (!observed) {
    return mode === "learn"
      ? { verdict: "allow", reason: "unobserved — learn mode permits exploration" }
      : { verdict: "deny", reason: "unobserved — never characterized in the probe vault" };
  }
  switch (rev) {
    case "reversible":
      return { verdict: "allow", reason: "learned reversible" };
    case "soft_irreversible":
      return { verdict: "escalate", reason: "soft-irreversible — human confirmation required" };
    case "hard_irreversible":
      return { verdict: "deny", reason: "hard-irreversible" };
    default:
      return { verdict: "escalate", reason: "effect uncertain (reversibility unknown)" };
  }
}

interface ConceptRow { content?: string; summary?: string }

/** Parse the persisted action-effect priors into a command→(reversibility, count) map. */
function parsePriors(rows: ConceptRow[]): Map<string, { rev: Reversibility; count: number }> {
  const map = new Map<string, { rev: Reversibility; count: number }>();
  for (const row of rows) {
    let cmd: string | undefined;
    let rev: Reversibility | undefined;
    let count = 0;
    if (row.content) {
      try {
        const m = JSON.parse(row.content) as {
          command_id?: string;
          reversibility_class?: Reversibility;
          observation_count?: number;
        };
        cmd = m.command_id;
        rev = m.reversibility_class;
        count = m.observation_count ?? 0;
      } catch {
        /* fall through to summary parse */
      }
    }
    if ((!cmd || !rev) && row.summary) {
      // "obsidian command <cmd> → <rev> (...)"
      const match = row.summary.match(/obsidian command (\S+) → (\w+)/);
      if (match) {
        cmd = cmd ?? match[1];
        rev = rev ?? (match[2] as Reversibility);
      }
    }
    if (cmd && rev) {
      const existing = map.get(cmd);
      // Keep the most-observed / most-conservative record.
      if (!existing || count > existing.count) map.set(cmd, { rev, count });
    }
  }
  return map;
}

export async function resolveObsidianCommandGate(
  pointer: ObsidianCommandGatePointer,
): Promise<ResolverResult> {
  const base = (pointer.conceptDbBase ?? DEFAULT_CONCEPT_DB).replace(/\/+$/, "");
  const apiKey = pointer.apiKey ?? API_KEY;
  const mode = pointer.mode ?? "operate";
  const timeoutMs = pointer.timeoutMs ?? 8000;
  const candidates = Array.isArray(pointer.command_ids) ? pointer.command_ids : null;
  const generatedAt = new Date().toISOString();
  const authHeaders: Record<string, string> = apiKey ? { Authorization: `ApiKey ${apiKey}` } : {};

  let priors: Map<string, { rev: Reversibility; count: number }>;
  try {
    const res = await fetch(
      `${base}/concepts/search?shape=obsidian_action_effect&limit=500`,
      { headers: authHeaders, signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!res.ok) throw new Error(`concept-db ${res.status}`);
    const json = (await res.json()) as { concepts?: ConceptRow[] };
    priors = parsePriors(json.concepts ?? []);
  } catch (err) {
    return {
      shape: "obsidianCommandGateVerdict",
      body: {
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
        mode,
        learned_count: 0,
        allowed: [],
        generated_at: generatedAt,
      },
    };
  }

  const learnedAllow = [...priors.entries()]
    .filter(([, v]) => v.rev === "reversible")
    .map(([cmd]) => cmd)
    .sort();

  // No candidates → report the learned allow-set (commands cleared for dispatch).
  if (!candidates) {
    return {
      shape: "obsidianCommandGateVerdict",
      body: {
        mode,
        learned_count: priors.size,
        allowed: learnedAllow,
        note:
          "allowed = commands learned-reversible and cleared for autonomous dispatch; " +
          "any command not in this set is denied by default in operate mode",
        generated_at: generatedAt,
      },
    };
  }

  const verdicts: CommandVerdict[] = candidates.map((command_id) => {
    const prior = priors.get(command_id);
    const observed = !!prior;
    const rev = prior?.rev ?? null;
    const d = decide(rev, observed, mode);
    return {
      command_id,
      reversibility_class: rev,
      observed,
      observation_count: prior?.count ?? 0,
      verdict: d.verdict,
      reason: d.reason,
    };
  });

  const allowed = verdicts.filter((v) => v.verdict === "allow").map((v) => v.command_id);
  const escalate = verdicts.filter((v) => v.verdict === "escalate").map((v) => v.command_id);
  const denied = verdicts.filter((v) => v.verdict === "deny").map((v) => v.command_id);
  // Anything not auto-allowed should not auto-dispatch → feed as extra_deny_globs.
  const extraDenyGlobs = verdicts
    .filter((v) => v.verdict !== "allow")
    .map((v) => v.command_id);

  return {
    shape: "obsidianCommandGateVerdict",
    body: {
      mode,
      learned_count: priors.size,
      candidates: candidates.length,
      command_verdicts: verdicts,
      allowed,
      escalate,
      denied,
      extra_deny_globs: extraDenyGlobs,
      generated_at: generatedAt,
    },
  };
}
