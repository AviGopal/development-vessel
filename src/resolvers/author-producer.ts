/**
 * author_producer — BRIDGE-AUTHOR (2026-06-24).
 *
 * Given a target output shape X that a LIVE resolver already produces but that
 * NO activity currently wraps, this resolver authors (mints) an activity whose
 * single task correctly INVOKES that resolver — declaring the input shapes the
 * resolver needs and binding its pointer fields from those inputs.
 *
 * This is the recursive mint-as-you-go primitive: it lets the substrate mint a
 * chain of REAL-resolver producers toward a goal. Each minted bridge wraps an
 * already-working resolver in a discoverable, Thompson-selectable activity, so
 * the producer becomes reachable through normal composition instead of being a
 * resolver only the engine knows about.
 *
 * How it works:
 *   1. Validate pointer.shape (X). Missing → structuredError.
 *   2. LOCATE the resolver source for X. We read each candidate vessel's
 *      src/routes/impulses.ts (the dispatch), grep for `case "X"` to find the
 *      resolver function it dispatches to, then read that resolver file from
 *      src/resolvers/*.ts. All reads are best-effort (Bun.file().text() wrapped
 *      in try/catch) — a missing tree is tolerated; the LLM still tries from the
 *      shape name and goal alone.
 *   3. AUTHOR via the LLM: we reuse the vessel's own llm_completion_dispatch
 *      resolver (the canonical, audit-able LLM path — no inline LLM call) and
 *      ask for STRICT JSON { input_shapes, task_config, binds_from }.
 *   4. BUILD an activity template that invokes resolver X with that task_config.
 *   5. MINT it by calling resolveActivityCreateVariant directly (no self-HTTP).
 *   6. RETURN { minted_activity_id, output_shape, input_shapes, task_config }.
 *
 * Robust by construction: missing source, LLM failure, malformed LLM JSON, and
 * a failed mint all degrade to a structuredError rather than throwing.
 */

import { resolveLlmCompletionDispatch } from "./llm-completion-dispatch.js";
import { resolveActivityCreateVariant } from "./activity-create-variant.js";
import type { ResolverResult } from "./types.js";

export interface AuthorProducerPointer {
  type: "author_producer";
  /** X — the output shape the minted activity must produce by invoking its resolver. */
  shape: string;
  /** Optional goal context to steer the LLM's input-shape / binding choices. */
  goal?: string;
  /** Optional pool of shapes already available (the binding layer can fill from these). */
  available_shapes?: string[];
  /** Override the vessels to search for the resolver source (tests / non-default layouts). */
  vessels?: string[];
  /** Override the root under which vessel trees live. Defaults to /vessels. */
  vessels_root?: string;
}

/** Vessels whose resolver source we search for the shape's implementation. */
const DEFAULT_VESSELS = [
  "activity-api",
  "analysis-vessel",
  "concept-db",
  "local-tools-vessel",
  "llm-resolver-vessel",
  "development-vessel",
];

function structuredError(detail: string, extra?: Record<string, unknown>): ResolverResult {
  return { shape: "structuredError", body: { resolver: "author_producer", error: detail, ...(extra ?? {}) } };
}

/** Best-effort file read via Bun; returns null on any failure (missing tree etc). */
async function readFileSafe(path: string): Promise<string | null> {
  try {
    const text = await Bun.file(path).text();
    return text;
  } catch {
    return null;
  }
}

/**
 * Locate the resolver source file that handles shape X.
 *
 * For each candidate vessel, read its src/routes/impulses.ts, find the
 * `case "X":` dispatch line, read the resolver function name it returns, map
 * that function to its import path's file, and read that file. Returns the
 * located source (with a small provenance header) or an empty string if not
 * found anywhere.
 */
export async function locateResolverSource(
  shape: string,
  vessels: string[],
  vesselsRoot: string,
): Promise<{ source: string; located_in: string | null; resolver_fn: string | null }> {
  const caseRe = new RegExp(`case\\s+["']${escapeRegExp(shape)}["']\\s*:\\s*\\n?\\s*return\\s+(\\w+)`);
  for (const vessel of vessels) {
    const impulsesPath = `${vesselsRoot}/${vessel}/src/routes/impulses.ts`;
    const impulsesSrc = await readFileSafe(impulsesPath);
    if (!impulsesSrc) continue;
    const m = caseRe.exec(impulsesSrc);
    if (!m) continue;
    const resolverFn = m[1]!;
    // Find the import line for that function to learn its file path.
    const importRe = new RegExp(`import\\s*\\{[^}]*\\b${escapeRegExp(resolverFn)}\\b[^}]*\\}\\s*from\\s*["']([^"']+)["']`);
    const im = importRe.exec(impulsesSrc);
    let resolverSrc: string | null = null;
    let resolverPath: string | null = null;
    if (im) {
      // import path like "../resolvers/foo.js" → src/resolvers/foo.ts
      const rel = im[1]!.replace(/^\.\.\//, "").replace(/\.js$/, ".ts");
      resolverPath = `${vesselsRoot}/${vessel}/src/${rel}`;
      resolverSrc = await readFileSafe(resolverPath);
    }
    return {
      source:
        `// ${vessel} dispatch for shape "${shape}" → ${resolverFn}\n` +
        (resolverSrc
          ? `// resolver source: ${resolverPath}\n${resolverSrc}`
          : `// (resolver function ${resolverFn} found in dispatch; source file not readable)`),
      located_in: vessel,
      resolver_fn: resolverFn,
    };
  }
  return { source: "", located_in: null, resolver_fn: null };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract the first balanced JSON object from a possibly fenced / prose-wrapped
 * LLM completion. Mirrors the brace-depth walker in activity-create-variant.
 */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const raw = text.replace(/^```(?:json)?\n?/i, "").trimStart();
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, i + 1)) as Record<string, unknown>; }
        catch { return null; }
      }
    }
  }
  return null;
}

function buildPrompt(p: AuthorProducerPointer, resolverSource: string): string {
  return (
    `You are authoring an activity that INVOKES an existing resolver to produce a target output shape.\n\n` +
    `TARGET OUTPUT SHAPE (X): ${p.shape}\n` +
    (p.goal ? `GOAL CONTEXT: ${p.goal}\n` : "") +
    (p.available_shapes && p.available_shapes.length
      ? `AVAILABLE POOL SHAPES (the binding layer can fill task config from these): ${p.available_shapes.join(", ")}\n`
      : "") +
    `\nRESOLVER SOURCE for shape "${p.shape}" (may be empty if not located):\n` +
    "```\n" +
    (resolverSource || "(no source located — infer from the shape name)") +
    "\n```\n\n" +
    `Determine which INPUT shapes the resolver needs (e.g. a shape that handles a file needs a ` +
    `source_code / fileContent input or a filePaths field) and how to fill the resolver's pointer ` +
    `fields from those inputs.\n\n` +
    `Return STRICT JSON with EXACTLY these three top-level keys and no others:\n` +
    `{\n` +
    `  "input_shapes": ["<shape>", ...],\n` +
    `  "task_config": { "type": "${p.shape}", "<pointer_field>": "<value or {{placeholder}}>" },\n` +
    `  "binds_from": { "<config_field>": "<input_shape_it_is_filled_from>" }\n` +
    `}\n\n` +
    `CONSTRAINTS:\n` +
    `- task_config.type MUST be exactly "${p.shape}" (the resolver dispatched).\n` +
    `- Bind pointer fields from inputs using {{...}} placeholders where the value comes from an input shape.\n` +
    `- input_shapes may be empty if the resolver needs no input.\n` +
    `- Output ONLY the JSON object. No prose, no markdown fences.`
  );
}

interface AuthoredSpec {
  input_shapes: string[];
  task_config: Record<string, unknown>;
  binds_from: Record<string, unknown>;
}

function coerceSpec(obj: Record<string, unknown>, shape: string): AuthoredSpec | null {
  const inputShapes = Array.isArray(obj["input_shapes"])
    ? (obj["input_shapes"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  const taskConfig =
    obj["task_config"] && typeof obj["task_config"] === "object"
      ? (obj["task_config"] as Record<string, unknown>)
      : null;
  if (!taskConfig) return null;
  // Guarantee the config dispatches the right resolver shape, regardless of LLM.
  taskConfig["type"] = shape;
  const bindsFrom =
    obj["binds_from"] && typeof obj["binds_from"] === "object"
      ? (obj["binds_from"] as Record<string, unknown>)
      : {};
  return { input_shapes: inputShapes, task_config: taskConfig, binds_from: bindsFrom };
}

export async function resolveAuthorProducer(pointer: AuthorProducerPointer): Promise<ResolverResult> {
  const shape = pointer.shape;
  if (!shape || typeof shape !== "string") {
    return structuredError("author_producer requires pointer.shape");
  }

  const vessels = pointer.vessels ?? DEFAULT_VESSELS;
  const vesselsRoot = pointer.vessels_root ?? "/vessels";

  // 1. Locate the resolver source (best-effort; empty source is tolerated).
  const located = await locateResolverSource(shape, vessels, vesselsRoot);

  // 2. Ask the LLM to design input shapes + task config via the canonical
  //    llm_completion_dispatch path (no inline LLM call — preserves layering).
  const llmResult = await resolveLlmCompletionDispatch({
    type: "llm_completion_dispatch",
    prompt: buildPrompt(pointer, located.source),
    max_tokens: 1500,
  });
  if (llmResult.shape !== "llm_completion_result") {
    const b = llmResult.body as { detail?: string; failure_mode?: string } | undefined;
    return structuredError(`LLM authoring failed: ${b?.detail ?? "no completion"}`, {
      llm_failure_mode: b?.failure_mode,
      output_shape: shape,
    });
  }
  const text = String((llmResult.body as { text?: unknown })?.text ?? "");
  const parsed = extractJsonObject(text);
  if (!parsed) {
    return structuredError("LLM did not return parseable JSON authoring spec", { output_shape: shape });
  }
  const spec = coerceSpec(parsed, shape);
  if (!spec) {
    return structuredError("LLM authoring spec missing a valid task_config object", { output_shape: shape });
  }

  // 3. Build the bridge activity template.
  const template = {
    id: `auto-bridge-${shape}`,
    name: `auto-bridge:${shape}`,
    description:
      `Auto-authored bridge activity that invokes the live ${shape} resolver` +
      (located.located_in ? ` (located in ${located.located_in})` : "") +
      ` to produce the ${shape} shape. Authored by author_producer for recursive mint-as-you-go.`,
    input_shapes: spec.input_shapes,
    inputShapes: spec.input_shapes,
    output_shapes: [shape],
    outputShapes: [shape],
    tags: ["auto_bridged", "improvise", "horizon:walk"],
    variables: [],
    tasks: [
      {
        id: "produce",
        description: `Invoke the ${shape} resolver to produce the ${shape} output shape, binding pointer fields from the declared input shapes.`,
        resolver: shape,
        config: spec.task_config,
        input_shapes: spec.input_shapes,
        inputShapes: spec.input_shapes,
        output_shapes: [shape],
        outputShapes: [shape],
      },
    ],
    proposed: false,
    org_id: "organizations:substrate",
  };

  // 4. Mint via the local activity_create_variant resolver (direct call, no self-HTTP).
  const mintResult = await resolveActivityCreateVariant({
    type: "activity_create_variant",
    template,
  });
  if (mintResult.shape !== "activityRegistryChange") {
    const b = mintResult.body as { detail?: string; failure_mode?: string } | undefined;
    return structuredError(`mint failed: ${b?.detail ?? "activity_create_variant rejected the template"}`, {
      mint_failure_mode: b?.failure_mode,
      output_shape: shape,
    });
  }
  const variantId = String((mintResult.body as { variantId?: unknown })?.variantId ?? "");

  return {
    shape: "author_producer",
    body: {
      minted_activity_id: variantId,
      output_shape: shape,
      input_shapes: spec.input_shapes,
      task_config: spec.task_config,
      binds_from: spec.binds_from,
      located_in: located.located_in,
      resolver_fn: located.resolver_fn,
    },
  };
}
