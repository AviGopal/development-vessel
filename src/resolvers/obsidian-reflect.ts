import { promises as fs } from "node:fs";
import path from "node:path";
import type { ResolverResult } from "./types.js";

/**
 * obsidian_reflect (2026-06-15) — the RESPOND half of the obsidian interaction loop.
 *
 * Closes observe → respond → observe-reaction: the substrate has been OBSERVING
 * the operator (obsidian_behavior_scan builds P(next-action|current); catalog
 * learning builds the command surface). This resolver MESSAGES the operator back:
 * it reads the learned priors from concept-db and renders a "Workflow" page onto
 * the substrate vault-render board (/workspace/vault-render — the operator-viewable
 * substrate surface, NOT the operator's own notes, so it is non-intrusive and the
 * provenance filter already excludes it from learning). The operator reading/acting
 * on the board is the reaction the next behavior scan can observe.
 *
 * Reads only concept-db + writes one board file. No execution against the live
 * vault. Side-loop, graceful idle if concept-db is unreachable.
 */

const DEFAULT_CONCEPT_DB = process.env["CONCEPT_DB_ENDPOINT"] ?? "http://127.0.0.1:8260";
const DEFAULT_RENDER_PATH = process.env["OBSIDIAN_RENDER_BOARD"] ?? "/workspace/vault-render/Workflow.md";
const DEFAULT_OBSIDIAN_ENDPOINT =
  process.env["OBSIDIAN_LEARN_ENDPOINT"] ?? process.env["OBSIDIAN_PLUGIN_ENDPOINT"] ?? "http://host.docker.internal:27183";
const API_KEY = process.env["METABOB_API_KEY"] ?? process.env["DEV_VESSEL_API_KEY"];

export interface ObsidianReflectPointer {
  type: "obsidian_reflect";
  conceptDbBase?: string;
  renderPath?: string;
  /** Proactive respond: ALSO write the reflection into the operator's WORKING vault. */
  writeToVault?: boolean;
  /** Working-vault note path (must be under the plugin's Substrate/ namespace). */
  vaultNotePath?: string;
  obsidianEndpoint?: string;
  apiKey?: string;
  timeoutMs?: number;
}

interface BehaviorModel {
  current_kind?: string;
  expected_next_kind?: string;
  consistency?: number;
  samples?: number;
}

async function searchConcepts(
  base: string,
  shape: string,
  auth: Record<string, string>,
  timeoutMs: number,
): Promise<Array<{ content?: string; summary?: string }>> {
  try {
    const res = await fetch(`${base}/concepts/search?shape=${shape}&limit=200`, {
      headers: auth,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { concepts?: Array<{ content?: string; summary?: string }> };
    return Array.isArray(json.concepts) ? json.concepts : [];
  } catch {
    return [];
  }
}

export async function resolveObsidianReflect(
  pointer: ObsidianReflectPointer,
): Promise<ResolverResult> {
  const base = (pointer.conceptDbBase ?? DEFAULT_CONCEPT_DB).replace(/\/+$/, "");
  const renderPath = pointer.renderPath ?? DEFAULT_RENDER_PATH;
  const writeToVault = pointer.writeToVault ?? true;
  const vaultNotePath = pointer.vaultNotePath ?? "Substrate/Workflow.md";
  const obsidianEndpoint = (pointer.obsidianEndpoint ?? DEFAULT_OBSIDIAN_ENDPOINT).replace(/\/+$/, "");
  const apiKey = pointer.apiKey ?? API_KEY;
  const timeoutMs = pointer.timeoutMs ?? 10_000;
  const generatedAt = new Date().toISOString();
  const auth: Record<string, string> = apiKey ? { Authorization: `ApiKey ${apiKey}` } : {};

  const behaviorConcepts = await searchConcepts(base, "obsidian_behavior", auth, timeoutMs);
  const surfaceConcepts = await searchConcepts(base, "obsidian_action_effect", auth, timeoutMs);

  // Parse the operator forward model, strongest (most consistent, best-sampled) first.
  // Exclude file-create/file-delete: these are dominated by the substrate's OWN
  // concept-sync writes (the kind the behavior scan's provenance filter targets),
  // not operator interaction — surfacing them would tell the operator "I expect
  // you to file-create" which is the substrate watching itself. Stale priors from
  // pre-provenance-filter runs persist in concept-db, so filter at render too.
  const SUBSTRATE_DOMINATED_KINDS = new Set(["file-create", "file-delete"]);
  const models: BehaviorModel[] = [];
  for (const c of behaviorConcepts) {
    try {
      const m = JSON.parse(c.content ?? "{}") as BehaviorModel;
      if (!m.current_kind || !m.expected_next_kind) continue;
      if (SUBSTRATE_DOMINATED_KINDS.has(m.current_kind)) continue;
      models.push(m);
    } catch { /* skip */ }
  }
  models.sort((a, b) => (b.consistency ?? 0) * (b.samples ?? 0) - (a.consistency ?? 0) * (a.samples ?? 0));

  // DEDUP by current_kind, keeping the strongest. The behavior scan writes a
  // fresh obsidian_behavior concept each ~30-min run (concept_create_write has no
  // upsert), so the same transition accumulates many priors over time; without
  // this the board would show duplicate rows. Sorted strongest-first, so the
  // first occurrence per current_kind is the one to keep.
  const seenKinds = new Set<string>();
  const dedupedModels = models.filter((m) => {
    if (seenKinds.has(m.current_kind!)) return false;
    seenKinds.add(m.current_kind!);
    return true;
  });

  const lines: string[] = [];
  lines.push("---");
  lines.push("substrate_board: workflow");
  lines.push(`generated_at: ${generatedAt}`);
  lines.push("---");
  lines.push("");
  lines.push("# What I've learned about your workflow");
  lines.push("");
  lines.push("_The substrate has been observing your Obsidian session (non-intrusively) and learning how you work. [[Index]] · [[Now]]_");
  lines.push("");
  lines.push(`- **Controllable command surface learned:** ${surfaceConcepts.length} commands classified (safe/navigate cleared for autonomous assist).`);
  lines.push(`- **Behavioural transitions modelled:** ${dedupedModels.length}.`);
  lines.push("");
  if (dedupedModels.length) {
    lines.push("## My expectations of your next action");
    lines.push("");
    lines.push("| After you… | I most expect… | confidence | observations |");
    lines.push("|---|---|---|---|");
    for (const m of dedupedModels.slice(0, 10)) {
      const conf = m.consistency != null ? `${(m.consistency * 100).toFixed(0)}%` : "—";
      lines.push(`| \`${m.current_kind}\` | \`${m.expected_next_kind}\` | ${conf} | ${m.samples ?? 0} |`);
    }
    lines.push("");
    lines.push("_When you do something I didn't expect, that surprise is what I learn from next._");
  } else {
    lines.push("_Not enough operator-interaction signal yet — still watching._");
  }
  lines.push("");
  const content = lines.join("\n");

  let boardWrote = true;
  try {
    await fs.mkdir(path.dirname(renderPath), { recursive: true });
    await fs.writeFile(renderPath, content, "utf8");
  } catch {
    boardWrote = false;
  }

  // PROACTIVE RESPOND: also write the reflection into the operator's WORKING vault
  // via the plugin's `obsidian:write_note` (hard-restricted to the Substrate/
  // namespace — it cannot touch the operator's own notes). Graceful: if the
  // plugin/endpoint is unreachable or the resolver isn't present yet (pre-reload),
  // this is a no-op, not a failure.
  let vaultWrite: { wrote: boolean; refused?: boolean; reason?: string } | null = null;
  if (writeToVault) {
    try {
      const res = await fetch(`${obsidianEndpoint}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}) },
        body: JSON.stringify({ type: "obsidian:write_note", pointer: { type: "obsidian:write_note", path: vaultNotePath, content } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const json = (await res.json()) as { content?: string };
        try { vaultWrite = JSON.parse(json.content ?? "{}"); } catch { vaultWrite = { wrote: false, reason: "unparseable" }; }
      } else {
        vaultWrite = { wrote: false, reason: `http ${res.status} (plugin may need reload to expose write_note)` };
      }
    } catch (err) {
      vaultWrite = { wrote: false, reason: err instanceof Error ? err.message.slice(0, 120) : "unreachable" };
    }
  }

  return {
    shape: "obsidianReflection",
    body: {
      render_path: renderPath,
      wrote: boardWrote,
      vault_note_path: writeToVault ? vaultNotePath : null,
      vault_write: vaultWrite,
      behavioural_models: dedupedModels.length,
      command_surface: surfaceConcepts.length,
      top_expectation: dedupedModels[0] ? `${dedupedModels[0].current_kind}→${dedupedModels[0].expected_next_kind}` : null,
      generated_at: generatedAt,
    },
  };
}
