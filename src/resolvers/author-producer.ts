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
        `Correct the config. CRITICAL rules learned from the resolver's own feedback:\n` +
        `- The error names the EXACT pointer fields the resolver reads. If it says "path must …", ` +
        `the field is literally \`path\` — use that verbatim. Do NOT invent compound variants ` +
        `(\`vault_path\`, \`notePath\`, \`note_content\`); the resolver does not read them, so they ` +
        `arrive empty and it refuses.\n` +
        `- Prefer the simplest canonical field names (path, content, text, body, query, title).\n` +
        `- Satisfy every value constraint the error states (e.g. a required path prefix / extension).\n` +
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
      // Discovery's /resolve expects an impulse pointer, not a bare {shape}. The
      // bare form always errored → findValidationEndpoint always returned null →
      // validation silently fell through to the hardcoded FALLBACK list (which
      // happens to contain analysis-vessel, so file-reader shapes validated, but
      // NOT obsidian / any vessel outside the list). Using the vesselCapability
      // pointer lets validation reach ANY registered vessel by discovery — the
      // prerequisite for closing orphans on surfaces like obsidian. (2026-06-25)
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape } }),
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
      const isContentField = /^(content|body|text|note|noteBody|message|markdown|md|value)$/i.test(key);
      if (key.toLowerCase() === "filepaths" || key.toLowerCase() === "paths") {
        out[key] = [fileFromGoal ?? KNOWN_REAL_FILE];
      } else if (isFileField) {
        out[key] = fileFromGoal ?? KNOWN_REAL_FILE;
      } else if (isContentField) {
        // A real non-empty body so a content-writer's contract validates (it is
        // synthesized at runtime by the content-synthesis bridge task).
        out[key] = "author_producer validation probe content.";
      } else {
        // Generic placeholder: substitute a benign concrete value drawn from
        // the goal, else a token, so the resolver sees a non-template string.
        out[key] = fileFromGoal ?? pointer.goal ?? "test";
      }
    }
  }
  return out;
}

// ── Validate↔mint parity (2026-06-24) ───────────────────────────────────────
// A file-consuming resolver (problem_detection, code_quality, source_code, …)
// needs a filePaths/path field. The LLM binds it from a phantom input shape
// (e.g. {{source_code}}) that is never in the pool, so the minted bridge can't
// run even though validation passed (validation extracts the path from the goal
// via buildTestPointer). Fix: when the validated config has a file-shaped
// placeholder field, mint a 2-task bridge — task1 `goal_file_extract` lifts the
// path from the goal, task2 binds the file field from task1's output slot. This
// makes the minted execute-path match the validated path.
const FILE_FIELD_RE = /^(filePaths?|paths?|path|filePath|file)$/i;
const PLURAL_FILE_FIELD_RE = /^(filePaths|paths)$/i;
// Content-shaped fields hold SYNTHESIZED free text (a note body, a message), not
// a value liftable from the goal by extraction. They are provisioned by an
// llm_completion_dispatch task that generates the field from the goal — the
// "content-synthesis" provisioning strategy that lets author_producer close
// content-WRITING orphans (obsidian:write_note, …), not just file-READING ones. (2026-06-25)
const CONTENT_FIELD_RE = /^(content|body|text|note|noteBody|message|markdown|md|value)$/i;
// Must equal the shape that goal_file_extract actually emits (`filePaths`, see the
// extract task's output_shapes below and goal-file-extract.ts). It was "goal_files",
// a slot the extract task never produces — so the produce task's
// {{impulse:goal_files}} binding resolved to nothing and the file field arrived
// empty ("filePath is required"), making every authored bridge a no-op. Aligning the
// slot name to the emitted shape lets the extracted path flow to the producer. (2026-06-24)
const EXTRACT_SLOT = "filePaths";

interface BridgeTasks {
  tasks: Record<string, unknown>[];
  templateInputShapes: string[];
  bindsFrom: Record<string, unknown>;
  twoTask: boolean;
}

/**
 * Decide the bridge's task list from the validated spec. If any file-shaped
 * field binds from a placeholder, return a 2-task bridge (extract-from-goal →
 * produce); otherwise the original single-task bridge.
 */
export function buildBridgeTasks(
  shape: string,
  spec: AuthoredSpec,
  senseBack?: { shape: string; pathField: string } | null,
): BridgeTasks {
  const cfg = spec.task_config;
  // Provisioning-strategy dispatch: classify each placeholder-bearing pointer
  // field by how its value must be PRODUCED, then prepend one provisioning task
  // per class and bind the producer's field to that task's output slot. This is
  // authoring-time backward-chaining — the generalisation of the old single
  // file-extract bridge.
  //   - file/path field   → goal_file_extract  (lift a path from the goal)
  //   - content/body field → llm_completion_dispatch (SYNTHESISE from the goal)
  // Fields that are neither are left as the LLM authored them (bound from a
  // declared input shape). (2026-06-25)
  // Classify by field NAME, not by whether the LLM left a placeholder: a
  // content-writer's path/content MUST be derived from the goal at runtime
  // (extract / synthesise), so even when the LLM froze a concrete value from the
  // authoring goal we OVERRIDE it with a provisioning slot — otherwise the bridge
  // would write the same note for every goal. (2026-06-25)
  const fileFields = Object.keys(cfg).filter(
    (k) => k !== "type" && FILE_FIELD_RE.test(k),
  );
  const contentFields = Object.keys(cfg).filter(
    (k) => k !== "type" && !FILE_FIELD_RE.test(k) && CONTENT_FIELD_RE.test(k),
  );

  if (fileFields.length === 0 && contentFields.length === 0) {
    return {
      tasks: [
        {
          id: "produce",
          description: `Invoke the ${shape} resolver to produce the ${shape} output shape, binding pointer fields from the declared input shapes.`,
          resolver: shape,
          config: cfg,
          input_shapes: spec.input_shapes,
          inputShapes: spec.input_shapes,
          output_shapes: [shape],
          outputShapes: [shape],
        },
      ],
      templateInputShapes: spec.input_shapes,
      bindsFrom: spec.binds_from,
      twoTask: false,
    };
  }

  const produceConfig: Record<string, unknown> = { ...cfg, type: shape };
  const bindsFrom: Record<string, unknown> = { ...spec.binds_from };
  const provisionTasks: Record<string, unknown>[] = [];
  const dependencies: string[] = [];
  // Slots (named outputImpulseKey handles) drive {{impulse:<slot>}} binding;
  // shapes are the pool SHAPES the produce task requires. They DIFFER for the
  // synthesis strategy (slot `synth_content` vs shape `llm_completion_result`),
  // so track them separately — putting a slot name into input_shapes makes the
  // engine require a non-existent shape and fail the produce task. (2026-06-25)
  const produceInputSlots: string[] = [];
  const produceInputShapes: string[] = [];

  // Strategy A — file/path fields: one shared goal_file_extract task.
  if (fileFields.length > 0) {
    provisionTasks.push({
      id: "extract",
      description:
        "Lift the target file path out of the goal text so the producer has a real filePaths entry.",
      resolver: "goal_file_extract",
      config: { type: "goal_file_extract", goal: "{{goal}}" },
      input_shapes: ["goal"],
      inputShapes: ["goal"],
      output_shapes: ["filePaths"],
      outputShapes: ["filePaths"],
      outputImpulses: [EXTRACT_SLOT],
    });
    dependencies.push("extract");
    produceInputSlots.push(EXTRACT_SLOT);
    produceInputShapes.push("filePaths");
    for (const k of fileFields) {
      produceConfig[k] = PLURAL_FILE_FIELD_RE.test(k)
        ? [`{{impulse:${EXTRACT_SLOT}}}`]
        : `{{impulse:${EXTRACT_SLOT}}}`;
      bindsFrom[k] = `task:extract(${EXTRACT_SLOT})`;
    }
  }

  // Strategy B — content fields: one llm_completion_dispatch SYNTHESIS task per
  // field, each producing its own slot. The prompt asks the LLM to emit exactly
  // the field value the goal calls for, so the writer receives synthesised
  // content rather than an unfillable placeholder.
  for (const k of contentFields) {
    const taskId = `synthesize_${k}`;
    const slot = `synth_${k}`;
    provisionTasks.push({
      id: taskId,
      description: `Synthesise the "${k}" value the goal asks ${shape} to write.`,
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt:
          `You are producing the "${k}" field for a "${shape}" action the substrate is performing. ` +
          `Read the goal below and output ONLY the exact ${k} to use — no preamble, no explanation, ` +
          `no markdown fences. If the goal implies a document/note, write its full body.\n\nGOAL:\n{{goal}}`,
        max_tokens: 1500,
      },
      input_shapes: ["goal"],
      inputShapes: ["goal"],
      output_shapes: ["llm_completion_result"],
      outputShapes: ["llm_completion_result"],
      outputImpulses: [slot],
    });
    dependencies.push(taskId);
    produceInputSlots.push(slot);
    produceInputShapes.push("llm_completion_result");
    produceConfig[k] = `{{impulse:${slot}}}`;
    bindsFrom[k] = `task:${taskId}(${slot})`;
  }

  const produceTask: Record<string, unknown> = {
    id: "produce",
    description: `Invoke the ${shape} resolver to produce ${shape}, binding its fields from the provisioning tasks (path-extract and/or content-synthesis).`,
    resolver: shape,
    dependencies,
    config: produceConfig,
    input_shapes: produceInputShapes,
    inputShapes: produceInputShapes,
    inputImpulses: produceInputSlots,
    output_shapes: [shape],
    outputShapes: [shape],
  };

  const tasks: Record<string, unknown>[] = [...provisionTasks, produceTask];

  // Sense-back (validation of the SENSED output): when the producer is a WRITER
  // on a surface that also advertises a READER for the same resource, append a
  // task that reads the just-written resource back through that observation
  // resolver. This puts the surface's ACTUAL state into the pool as a shape, so
  // the reach-gate validates the goal against what was genuinely sensed on the
  // surface (the note read from the vault) rather than the writer's self-report
  // or unrelated steps' noise. This is the actuate→sense→verify loop and is what
  // lets the substrate extend topology toward implicit surfaces safely. (2026-06-25)
  if (senseBack && (fileFields.length > 0)) {
    tasks.push({
      id: "sense_back",
      description:
        `Read ${senseBack.shape} back from the surface (the same path just written) so the pool carries the genuinely-sensed state — sensed-output validation of the ${shape} write.`,
      resolver: senseBack.shape,
      dependencies: ["produce"],
      config: { type: senseBack.shape, [senseBack.pathField]: `{{impulse:${EXTRACT_SLOT}}}` },
      input_shapes: ["filePaths"],
      inputShapes: ["filePaths"],
      inputImpulses: [EXTRACT_SLOT],
      output_shapes: [senseBack.shape],
      outputShapes: [senseBack.shape],
      outputImpulses: ["sensed_state"],
    });
  }

  return {
    tasks,
    templateInputShapes: ["goal"],
    bindsFrom,
    twoTask: true,
  };
}

/**
 * For a WRITER shape on a namespaced surface (e.g. obsidian:write_note), find a
 * paired READER the same vessel advertises (obsidian:note / open_note / …) so the
 * write can be sensed back. Returns null when the shape isn't a surface writer or
 * the vessel advertises no reader — sense-back is then simply skipped.
 */
async function findSenseBackReader(
  writerShape: string,
): Promise<{ shape: string; pathField: string } | null> {
  const m = writerShape.match(/^([^:]+):(.+)$/);
  if (!m || !m[1] || !m[2]) return null;
  const ns = m[1];
  const verbNoun = m[2];
  const noun = verbNoun.replace(/^(write_|create_|save_|put_|set_|update_|append_)/i, "");
  if (noun === verbNoun) return null; // not a recognisable write verb → not a surface writer
  const candidates = [`${ns}:${noun}`, `${ns}:open_${noun}`, `${ns}:read_${noun}`, `${ns}:get_${noun}`];
  try {
    const res = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ pointer: { type: "vesselRegistry" } }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: { vessels?: Array<{ shapes?: string[] }> } };
    const vessels = data.content?.vessels ?? [];
    const writerVessel = vessels.find((v) => (v.shapes ?? []).includes(writerShape));
    if (!writerVessel) return null;
    const advertised = new Set(writerVessel.shapes ?? []);
    for (const c of candidates) {
      if (c !== writerShape && advertised.has(c)) return { shape: c, pathField: "path" };
    }
  } catch {
    return null;
  }
  return null;
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
/**
 * Extract an explicit effect signal from a resolver response — the SENSED
 * outcome of an action/write. Looks at the envelope top-level, a stringified or
 * nested `content` body, and `metadata`. Returns `{ok:false,reason}` on a
 * refusal/failed write, `{ok:true}` on a confirmed write, or `null` when no
 * effect flag is present (a pure READER like code_quality — shape-match then
 * suffices). Generic over `wrote`/`written`/`refused`/`success`/`ok` flags so it
 * works for any write/surface vessel, not just obsidian.
 */
function extractEffectSignal(body: unknown): { ok: boolean; reason: string } | null {
  const candidates: Record<string, unknown>[] = [];
  const b = body as Record<string, unknown> | undefined;
  if (b && typeof b === "object") {
    candidates.push(b);
    let c: unknown = b["content"];
    if (typeof c === "string") {
      try { c = JSON.parse(c); } catch { /* not JSON — ignore */ }
    }
    if (c && typeof c === "object") candidates.push(c as Record<string, unknown>);
    const meta = b["metadata"];
    if (meta && typeof meta === "object") candidates.push(meta as Record<string, unknown>);
  }
  for (const o of candidates) {
    const refused = o["refused"] === true;
    const negated =
      o["wrote"] === false || o["written"] === false ||
      o["success"] === false || o["ok"] === false;
    if (refused || negated) {
      return { ok: false, reason: String(o["reason"] ?? o["error"] ?? o["summary"] ?? "the action did not take effect") };
    }
    if (o["wrote"] === true || o["written"] === true) return { ok: true, reason: "" };
  }
  return null;
}

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
      | {
          shape?: string;
          error?: unknown;
          content?: { shape?: string; error?: unknown };
          metadata?: { shape?: string };
          resolved?: boolean;
        }
      | undefined;
    // Vessels wrap the produced shape differently: analysis/dev-vessel put it at
    // top-level `shape`, obsidian-vessel puts it at `metadata.shape` (its body is
    // a stringified payload). Check all positions so a genuinely-producing surface
    // vessel isn't misread as "did not carry shape". (2026-06-25)
    const respShape = b?.shape ?? b?.content?.shape ?? b?.metadata?.shape;
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
      // Validation of the SENSED output (2026-06-25): a writer/surface resolver
      // returns its produced shape EVEN WHEN IT REFUSED the action (e.g. obsidian
      // write_note → {wrote:false, refused:true} but metadata.shape is still
      // obsidian:write_note). Shape-presence alone is not "genuinely producing".
      // Inspect the body for the sensed effect flag and FAIL with the surface's
      // own reason when the effect did not occur — this turns the author→refine
      // loop into a contract-discovery loop: the surface tells the LLM what it got
      // wrong ("path must start with Substrate/"), and the next attempt corrects.
      const effect = extractEffectSignal(body);
      if (effect && effect.ok === false) {
        return { ok: false, error: `resolver returned shape "${shape}" but the SENSED effect failed: ${effect.reason}` };
      }
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

  // 3. Build the bridge activity template. For file-consuming shapes this is a
  //    2-task bridge (extract-from-goal → produce) so the minted execute-path
  //    matches the validated path (validate↔mint parity, 2026-06-24).
  // If the producer is a surface WRITER, discover a paired reader so the bridge
  // can sense its write back into the pool (sensed-output validation).
  const senseBack = await findSenseBackReader(shape);
  const bridge = buildBridgeTasks(shape, spec, senseBack);
  const template = {
    id: `auto-bridge-${shape}`,
    name: `auto-bridge:${shape}`,
    description:
      `Auto-authored bridge activity that invokes the live ${shape} resolver` +
      (located.located_in ? ` (located in ${located.located_in})` : "") +
      ` to produce the ${shape} shape.` +
      (bridge.twoTask
        ? ` Lifts the target file path from the goal first (goal_file_extract) so the producer has a real entry.`
        : ``) +
      ` Authored by author_producer for recursive mint-as-you-go.`,
    input_shapes: bridge.templateInputShapes,
    inputShapes: bridge.templateInputShapes,
    output_shapes: [shape],
    outputShapes: [shape],
    tags: ["auto_bridged", "improvise", "horizon:walk"],
    variables: [],
    tasks: bridge.tasks,
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
      input_shapes: bridge.templateInputShapes,
      task_config: spec.task_config,
      binds_from: bridge.bindsFrom,
      two_task_bridge: bridge.twoTask,
      validated: true,
      attempts,
      located_in: located.located_in,
      resolver_fn: located.resolver_fn,
    },
  };
}
