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
import { DISCOVERY_ENDPOINT, METABOB_API_KEY } from "../config.js";
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
  /** Max author→validate→refine attempts before giving up. Defaults to 3. */
  max_attempts?: number;
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

function buildPrompt(
  p: AuthorProducerPointer,
  resolverSource: string,
  prior?: { task_config: Record<string, unknown>; error: string },
): string {
  return (
    `You are authoring an activity that INVOKES an existing resolver to produce a target output shape.\n\n` +
    `TARGET OUTPUT SHAPE (X): ${p.shape}\n` +
    (p.goal ? `GOAL CONTEXT: ${p.goal}\n` : "") +
    (p.available_shapes && p.available_shapes.length
      ? `AVAILABLE POOL SHAPES (the binding layer can fill task config from these): ${p.available_shapes.join(", ")}\n`
      : "") +
    (prior
      ? `\nPREVIOUS ATTEMPT FAILED. The previous task_config was:\n` +
        "```json\n" +
        JSON.stringify(prior.task_config, null, 2) +
        "\n```\n" +
        `Invoking the resolver with it failed with this error:\n` +
        "```\n" +
        prior.error.slice(0, 800) +
        "\n```\n" +
        `Correct the config: fix field names and add any required fields the error indicates. ` +
        `Do not repeat the same mistake.\n`
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

/**
 * Resolve, via discovery, a base URL + resolve route for the vessel that owns
 * shape X. Discovery body is `{ shape }` per the validation contract. Returns a
 * fully-qualified resolve endpoint (base + route) or null if discovery yields
 * nothing usable.
 */
async function findValidationEndpoint(shape: string): Promise<string | null> {
  try {
    const res = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `ApiKey ${METABOB_API_KEY}`,
      },
      body: JSON.stringify({ shape }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      content?: { vessels?: Array<{ endpoint?: string; resolve_endpoint?: string; health_score?: number; confidence?: number }>; found?: boolean };
      vessels?: Array<{ endpoint?: string; resolve_endpoint?: string; health_score?: number; confidence?: number }>;
    };
    const vessels = data.content?.vessels ?? data.vessels ?? [];
    if (vessels.length === 0) return null;
    const best = vessels
      .slice()
      .sort((a, b) => (b.health_score ?? b.confidence ?? 0) - (a.health_score ?? a.confidence ?? 0))[0]!;
    const base = (best.endpoint ?? "").replace(/\/$/, "");
    const route = best.resolve_endpoint ?? "/resolve";
    if (route.startsWith("http://") || route.startsWith("https://")) return route;
    if (!base) return null;
    return `${base}${route.startsWith("/") ? route : `/${route}`}`;
  } catch {
    return null;
  }
}

/** Fallback base+route pairs to try when discovery returns nothing usable. */
const FALLBACK_VALIDATION_ENDPOINTS = [
  "http://127.0.0.1:8250/resolve", // analysis-vessel
  "http://127.0.0.1:8260/v2/impulses/resolve", // concept-db
  "http://127.0.0.1:8230/resolve", // local-tools
  "http://127.0.0.1:8090/v2/impulses/resolve", // dev-vessel
  "http://127.0.0.1:8220/resolve", // llm-resolver
];

/**
 * Resolve `{{...}}` placeholders in the authored task_config to concrete test
 * values so the resolver can be invoked for real. Placeholders are filled from
 * the goal text (for file-path-shaped fields) or a known-real default; the
 * mapping back to {{...}} for genuine bind fields is preserved separately for
 * minting. Returns the concrete pointer used for the test invocation.
 */
function buildTestPointer(
  config: Record<string, unknown>,
  shape: string,
  pointer: AuthorProducerPointer,
): Record<string, unknown> {
  const KNOWN_REAL_FILE = "/vessels/discovery-vessel/src/registry.ts";
  const fileFromGoal = (() => {
    const g = pointer.goal ?? "";
    const m = g.match(/[\w./-]+\.[a-z]{1,4}/i);
    return m ? m[0] : null;
  })();
  const out: Record<string, unknown> = { ...config, type: shape };
  for (const [key, val] of Object.entries(out)) {
    if (key === "type") continue;
    if (typeof val === "string" && val.includes("{{")) {
      const isFileField = /^(filePaths?|paths?|path|filePath|file)$/i.test(key);
      if (key.toLowerCase() === "filepaths" || key.toLowerCase() === "paths") {
        out[key] = [fileFromGoal ?? KNOWN_REAL_FILE];
      } else if (isFileField) {
        out[key] = fileFromGoal ?? KNOWN_REAL_FILE;
      } else {
        // Generic placeholder: substitute a benign concrete value drawn from
        // the goal, else a token, so the resolver sees a non-template string.
        out[key] = fileFromGoal ?? pointer.goal ?? "test";
      }
    }
  }
  return out;
}

interface ValidationOutcome {
  ok: boolean;
  /** Error text captured for refinement when ok=false. */
  error: string;
}

/**
 * VALIDATE: invoke resolver X against its owning vessel with a concrete test
 * pointer. Success = HTTP ok AND the response genuinely produces shape X (not a
 * structuredError / `.error`). On failure, captures the error text so the next
 * author attempt can refine the config.
 */
async function validateProducesShape(
  shape: string,
  testPointer: Record<string, unknown>,
): Promise<ValidationOutcome> {
  const endpoints: string[] = [];
  const discovered = await findValidationEndpoint(shape);
  if (discovered) endpoints.push(discovered);
  for (const fb of FALLBACK_VALIDATION_ENDPOINTS) {
    if (!endpoints.includes(fb)) endpoints.push(fb);
  }

  let lastError = "no validation endpoint produced a response";
  for (const ep of endpoints) {
    let res: Response;
    try {
      res = await fetch(ep, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `ApiKey ${METABOB_API_KEY}`,
        },
        body: JSON.stringify({ impulse: { type: shape, pointer: testPointer } }),
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (res.status === 404) {
      lastError = `endpoint ${ep} returned 404`;
      continue; // try the next base+route
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      const txt = await res.text().catch(() => "");
      lastError = `non-JSON response from ${ep}: ${txt.slice(0, 200)}`;
      continue;
    }
    const b = body as
      | { shape?: string; error?: unknown; content?: { shape?: string; error?: unknown }; resolved?: boolean }
      | undefined;
    const respShape = b?.shape ?? b?.content?.shape;
    const respError = b?.error ?? b?.content?.error;
    if (!res.ok) {
      // Transport-style failure (5xx/503): this endpoint can't serve the shape,
      // advance to the next base+route rather than treating it as a verdict.
      lastError = `HTTP ${res.status}: ${JSON.stringify(respError ?? body).slice(0, 400)}`;
      continue;
    }
    // The vessel genuinely responded (HTTP 2xx). This is the authoritative
    // validation verdict for the shape — return it (success or failure) instead
    // of letting later fallback transport failures clobber the refinement signal.
    if (b?.resolved === false || respShape === "structuredError" || respError) {
      return {
        ok: false,
        error: `resolver returned error: ${JSON.stringify(respError ?? body).slice(0, 400)}`,
      };
    }
    if (respShape === shape) {
      return { ok: true, error: "" };
    }
    // 2xx, no error, but wrong/absent shape → did not genuinely produce X.
    return {
      ok: false,
      error: `response did not carry shape "${shape}" (got ${JSON.stringify(respShape) ?? "none"})`,
    };
  }
  return { ok: false, error: lastError };
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

  const maxAttempts = Math.max(1, pointer.max_attempts ?? 3);

  // 2-3. AUTHOR → VALIDATE → REFINE loop. Each attempt authors a candidate
  //       task_config via the LLM (feeding the prior failure's error text on
  //       attempts ≥2), then VALIDATES it by invoking resolver X for real. Only
  //       a config that genuinely produces X is minted. Network / LLM failures
  //       are treated as a failed attempt and we continue.
  let spec: AuthoredSpec | null = null;
  let prior: { task_config: Record<string, unknown>; error: string } | undefined;
  let lastError = "no attempt produced a validated config";
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;

    // AUTHOR via the canonical llm_completion_dispatch path (no inline LLM).
    const llmResult = await resolveLlmCompletionDispatch({
      type: "llm_completion_dispatch",
      prompt: buildPrompt(pointer, located.source, prior),
      max_tokens: 1500,
    });
    if (llmResult.shape !== "llm_completion_result") {
      const b = llmResult.body as { detail?: string; failure_mode?: string } | undefined;
      lastError = `LLM authoring failed: ${b?.detail ?? "no completion"}`;
      continue;
    }
    const text = String((llmResult.body as { text?: unknown })?.text ?? "");
    const parsed = extractJsonObject(text);
    if (!parsed) {
      lastError = "LLM did not return parseable JSON authoring spec";
      continue;
    }
    const candidate = coerceSpec(parsed, shape);
    if (!candidate) {
      lastError = "LLM authoring spec missing a valid task_config object";
      continue;
    }

    // VALIDATE: invoke resolver X for real with a concrete test pointer.
    const testPointer = buildTestPointer(candidate.task_config, shape, pointer);
    const outcome = await validateProducesShape(shape, testPointer);
    if (outcome.ok) {
      spec = candidate;
      break;
    }
    // Refine on the next attempt using the resolver's own error text.
    lastError = outcome.error;
    prior = { task_config: candidate.task_config, error: outcome.error };
  }

  if (!spec) {
    // EXHAUSTION: do NOT mint a non-working config.
    return structuredError(
      `author_producer: could not author a genuinely-producing invocation of ${shape}`,
      { last_error: lastError, attempts, output_shape: shape },
    );
  }

  // 3. Build the bridge activity template (validated task_config preserves the
  //    LLM's {{...}} placeholders for fields that bind from input shapes).
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
      validated: true,
      attempts,
      located_in: located.located_in,
      resolver_fn: located.resolver_fn,
    },
  };
}
