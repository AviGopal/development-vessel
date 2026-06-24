import type { ResolverResult } from "./types.js";

/**
 * obsidian_deliver_assist (2026-06-15) — the DELIVERY primitive for autonomous
 * obsidian functionality.
 *
 * The substrate can AUTHOR assist activities, but the engine does not interpolate
 * a prior task's output into an http_fetch body, so an authored
 * fetch→llm→write_note pipeline cannot get the llm suggestion to write_note.
 * This primitive closes that gap atomically: it reads the operator's
 * obsidian:workspace_state, asks the LLM (via the llm-resolver-vessel — the
 * substrate's llm tier, not an inline call) for a short non-intrusive suggestion,
 * and writes it to Substrate/Assists/ via obsidian:write_note (which the plugin
 * hard-restricts to that namespace — never the operator's own notes).
 *
 * The substrate authors a THIN activity that dispatches this primitive (the
 * concept-prime precedent: operator bootstraps the primitive once, substrate
 * composes it). Reads only + one Substrate/ write. Graceful idle if obsidian or
 * the llm vessel is unreachable.
 */

const DEFAULT_OBSIDIAN_ENDPOINT =
  process.env["OBSIDIAN_LEARN_ENDPOINT"] ?? process.env["OBSIDIAN_PLUGIN_ENDPOINT"] ?? "http://host.docker.internal:27183";
const DEFAULT_LLM_ENDPOINT = process.env["LLM_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8220/resolve";
const API_KEY = process.env["METABOB_API_KEY"] ?? process.env["DEV_VESSEL_API_KEY"];

export interface ObsidianDeliverAssistPointer {
  type: "obsidian_deliver_assist";
  obsidianEndpoint?: string;
  llmEndpoint?: string;
  /** Vault path for the assist; MUST be under Substrate/ (plugin-enforced). */
  assistPath?: string;
  /** Steers the assist toward a class (e.g. "next actions", "linking"); enables comparable variants. */
  promptFocus?: string;
  /** LLM model; defaults to a current Haiku (the llm-vessel DEFAULT model is deprecated/404). */
  model?: string;
  apiKey?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export async function resolveObsidianDeliverAssist(
  pointer: ObsidianDeliverAssistPointer,
): Promise<ResolverResult> {
  const obsidian = (pointer.obsidianEndpoint ?? DEFAULT_OBSIDIAN_ENDPOINT).replace(/\/+$/, "");
  const llmEndpoint = pointer.llmEndpoint ?? DEFAULT_LLM_ENDPOINT;
  const assistPath = pointer.assistPath ?? "Substrate/Assists/active-note.md";
  const promptFocus = typeof pointer.promptFocus === "string" ? pointer.promptFocus.trim() : "";
  const model = pointer.model ?? process.env["OBSIDIAN_ASSIST_MODEL"] ?? "claude-haiku-4-5-20251001";
  const apiKey = pointer.apiKey ?? API_KEY;
  const maxTokens = pointer.maxTokens ?? 500;
  const timeoutMs = pointer.timeoutMs ?? 30_000;
  const generatedAt = new Date().toISOString();
  const auth: Record<string, string> = { "Content-Type": "application/json", ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}) };

  if (!apiKey) return { shape: "obsidianAssistDelivered", body: { delivered: false, error: "missing_api_key" } };
  if (!assistPath.startsWith("Substrate/")) {
    return { shape: "obsidianAssistDelivered", body: { delivered: false, error: "assistPath must be under Substrate/", assistPath } };
  }

  // 1. Read the operator's current context (reads only).
  let workspace = "";
  try {
    const res = await fetch(`${obsidian}/resolve`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ type: "obsidian:workspace_state", pointer: { type: "obsidian:workspace_state" } }),
      signal: AbortSignal.timeout(Math.min(timeoutMs, 8000)),
    });
    const json = (await res.json()) as { content?: string; error?: string };
    if (json.error || !json.content) {
      return { shape: "obsidianAssistDelivered", body: { delivered: false, unreachable: true, stage: "workspace", detail: json.error ?? "no content", generated_at: generatedAt } };
    }
    workspace = json.content;
  } catch (err) {
    return { shape: "obsidianAssistDelivered", body: { delivered: false, unreachable: true, stage: "workspace", detail: err instanceof Error ? err.message.slice(0, 120) : "err", generated_at: generatedAt } };
  }

  // 2. Ask the llm tier for a short, non-intrusive suggestion.
  let suggestion = "";
  try {
    const prompt =
      "You are a non-intrusive Obsidian assistant. Given the operator's current workspace state below, " +
      "write a SHORT markdown note (<=120 words) with 2-3 concrete, actionable suggestions" +
      (promptFocus ? `, FOCUSED ON: ${promptFocus}` : ": related notes to link, a missing backlink, or a one-line summary of the open note") +
      ". If there is no active note, suggest a useful next action. Output ONLY the markdown body — no preamble, no fences.\n\nWorkspace state:\n" + workspace;
    const res = await fetch(llmEndpoint, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ type: "llm_completion", prompt, model, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as { content?: string; error?: string };
    suggestion = (json.content ?? "").trim();
    if (!suggestion) {
      return { shape: "obsidianAssistDelivered", body: { delivered: false, stage: "llm", detail: json.error ?? "empty completion", generated_at: generatedAt } };
    }
  } catch (err) {
    return { shape: "obsidianAssistDelivered", body: { delivered: false, stage: "llm", detail: err instanceof Error ? err.message.slice(0, 120) : "err", generated_at: generatedAt } };
  }

  // 3. Deliver to the operator's working vault (Substrate/ only).
  const noteBody =
    `---\nsubstrate_assist: active-note\ngenerated_at: ${generatedAt}\n---\n\n# Substrate suggestion\n\n_Non-intrusive. [[Workflow]]_\n\n${suggestion}\n`;
  try {
    const res = await fetch(`${obsidian}/resolve`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ type: "obsidian:write_note", pointer: { type: "obsidian:write_note", path: assistPath, content: noteBody } }),
      signal: AbortSignal.timeout(Math.min(timeoutMs, 8000)),
    });
    const json = (await res.json()) as { content?: string };
    let wrote = false;
    try { wrote = JSON.parse(json.content ?? "{}").wrote === true; } catch { /* keep false */ }
    return {
      shape: "obsidianAssistDelivered",
      body: { delivered: wrote, assist_path: assistPath, suggestion_chars: suggestion.length, generated_at: generatedAt },
    };
  } catch (err) {
    return { shape: "obsidianAssistDelivered", body: { delivered: false, stage: "write", detail: err instanceof Error ? err.message.slice(0, 120) : "err", generated_at: generatedAt } };
  }
}
