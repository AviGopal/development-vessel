/**
 * goal_file_extract — lift a file path out of goal text (2026-06-24).
 *
 * The generative-root fix for validate↔mint parity in author_producer
 * (openspec/changes/2026-06-24-author-producer-validate-mint-parity). File-
 * consuming resolvers (analysis-vessel problem_detection / code_quality /
 * source_code, …) need a `filePaths` input, but a goal only NAMES the file in
 * prose ("examine repos/discovery-vessel/src/index.ts"). Nothing previously
 * lifted that prose reference into a structured impulse, so the analysis chain
 * starved at the entry. This deterministic resolver closes that gap.
 *
 * Contract:
 *   pointer: { type: "goal_file_extract", goal?: string, text?: string, ... }
 *   output : { shape: "filePaths", body: <primary path as a bare STRING> }
 *
 * Why a bare string, not an array: the goal-host discovery-proxy binds
 * downstream task config via `{{impulse:<slot>}}` and JSON.stringify's any
 * non-string content (see goal-host interpolateProxyValue). A minted 2-task
 * bridge therefore wraps this value: `filePaths: ["{{impulse:goal_files}}"]`,
 * yielding a real ["/path"] array at the producer. Emitting the array here
 * would stringify to '["/path"]' and break the consumer.
 *
 * Robust by construction: scans `goal`, `text`, and every other string field on
 * the pointer for path-like tokens (so the goal surviving under an unexpected
 * key is still caught), ranks them (directory-separated paths first, longest
 * next), and returns the best. No match → empty string (the consumer then
 * produces nothing, which the reach-gate correctly judges hollow).
 */

import type { ResolverResult } from "./types.js";

export interface GoalFileExtractPointer {
  type: "goal_file_extract";
  goal?: string;
  text?: string;
  [key: string]: unknown;
}

// A path-like token: an optional dir prefix then `name.ext`. Matches
// "repos/discovery-vessel/src/index.ts", "src/index.ts", "index.ts".
const PATH_RE = /[A-Za-z0-9_@.\-/]*[A-Za-z0-9_@\-]\.[A-Za-z0-9]{1,6}\b/g;

// Extensions we treat as real files (avoids matching version strings like
// "1.20.9" or sentence-ending "etc.").
const FILE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "txt", "yaml", "yml",
  "toml", "sh", "bash", "py", "go", "rs", "sql", "html", "css", "scss", "vue",
  "svelte", "ini", "cfg", "conf", "env", "lock", "xml", "proto", "graphql",
]);

/** Collect every string value on the pointer (goal/text first) into one blob. */
function collectText(pointer: GoalFileExtractPointer): string {
  const parts: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) for (const e of v) push(e);
  };
  push(pointer.goal);
  push(pointer.text);
  for (const [k, v] of Object.entries(pointer)) {
    if (k === "goal" || k === "text" || k === "type") continue;
    push(v);
  }
  return parts.join("\n");
}

function isFilePath(token: string): boolean {
  const ext = token.split(".").pop()?.toLowerCase() ?? "";
  if (!FILE_EXT.has(ext)) return false;
  // Reject an unresolved placeholder fragment.
  if (token.includes("{{") || token.includes("}}")) return false;
  return true;
}

/** Higher = more likely the intended path: dir-separated, then longer. */
function score(token: string): number {
  const depth = (token.match(/\//g) ?? []).length;
  return depth * 1000 + token.length;
}

export function extractFilePaths(pointer: GoalFileExtractPointer): string[] {
  const text = collectText(pointer);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(PATH_RE)) {
    const tok = m[0];
    if (!isFilePath(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  out.sort((a, b) => score(b) - score(a));
  return out;
}

export async function resolveGoalFileExtract(
  pointer: GoalFileExtractPointer,
): Promise<ResolverResult> {
  const paths = extractFilePaths(pointer);
  const primary = paths[0] ?? "";
  // body is the PRIMARY path as a bare string (see header). filePaths/count are
  // attached for any structured consumer / observability, but the slot binding
  // reads the bare-string body.
  return {
    shape: "filePaths",
    body: primary,
  };
}
