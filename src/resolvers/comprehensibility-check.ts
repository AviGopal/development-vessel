import { DISCOVERY_ENDPOINT, METABOB_API_KEY, METABOB_ENDPOINT } from "../config.js";
import type { ResolverResult } from "./types.js";

/**
 * comprehensibility_check resolver — Phase 2 of obsidian meta-skill prototype.
 *
 * Validates that a substrate-authored template remains readable: a second-provider
 * LLM is given the template body WITHOUT its self-description and asked three
 * questions; the answers are compared semantically against the template's own
 * description / task descriptions to compute a 0..1 score.
 *
 * Below the floor (default 0.6) the template is refused promotion and a
 * `verifier_negative.comprehensibility_below_floor` impulse is emitted.
 *
 * NOTE on similarity: the substrate ships `all-MiniLM-L6-v2` ONNX inside
 * `metabob-activity-api`, not inside development-vessel. Loading 22MB of ONNX
 * inside every dev-vessel restart is heavier than this check needs. We use a
 * deterministic token-overlap (Jaccard) score over normalised lowercase
 * alphanumeric tokens with English stop-words removed. The semantic-quality
 * trade-off is acceptable because (a) the same prompt structure produces
 * roughly aligned vocabulary on both sides and (b) the Phase 2.5 re-check
 * runs against a different provider, which is the more important
 * cross-checks. The score function is injectable via the `_similarityFn`
 * hook for testing and future swap to ONNX cosine.
 */

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5-20251001";
const DEFAULT_FLOOR = 0.6;

const COMPREHENSIBILITY_PROMPT_PREFIX =
  "You are reading an activity template you have not seen before. " +
  "Without referring to any other context, answer: " +
  "(1) What does this activity do? " +
  "(2) Why might it have been authored? " +
  "(3) What would have to be true about the trace store and substrate state for it to be useful? " +
  "Give terse answers. Format the response as JSON: " +
  "{\"what\": \"...\", \"why\": \"...\", \"when_useful\": \"...\"}.";

export interface ComprehensibilityCheckPointer {
  type: "comprehensibility_check";
  /** Either `template_id` (fetched from activity-api) or `template_json` must be present. */
  template_id?: string;
  /** Inline template object — same shape as ActivityTemplate. */
  template_json?: Record<string, unknown>;
  /** Evaluator model. Defaults to anthropic/claude-haiku-4-5-20251001. */
  model?: string;
  /** Comprehensibility floor; below this the template is refused promotion. */
  floor?: number;
  /** Test hook: replace the similarity function. */
  _similarityFn?: (a: string, b: string) => number;
  /** Test hook: replace the LLM dispatch. */
  _llmFn?: (prompt: string, model: string) => Promise<string>;
}

interface ComprehensibilityScoreBody {
  shape: "comprehensibilityScore";
  template_id: string | null;
  overall_score: number;
  floor: number;
  passed: boolean;
  per_field: { what: number; why: number; when_useful: number };
  evaluator_model_id: string;
  evaluated_at: string;
  raw_answers: { what: string; why: string; when_useful: string };
  reasoning_diff: string;
}

interface FailureModeBody {
  shape: "structuredError";
  failure_mode: "comprehensibility_below_floor" | "input_error" | "cascading";
  detail: string;
  score?: number;
  floor?: number;
  evaluator_model_id?: string;
}

const STOP_WORDS = new Set([
  "the","a","an","and","or","but","is","are","was","were","be","been","being",
  "of","in","to","for","on","with","at","by","from","as","that","this","these",
  "those","it","its","they","them","their","there","then","than","so","such",
  "if","not","no","do","does","did","done","has","have","had","will","would",
  "shall","should","can","could","may","might","must","into","onto","over","under",
  "out","up","down","off","about","against","between","through","during","before",
  "after","above","below","because","when","while","where","what","which","who",
  "whom","whose","why","how","all","any","both","each","few","more","most","other",
  "some","such","only","own","same","s","t","also","etc",
]);

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

/** Default similarity: Jaccard over normalised tokens. */
export function jaccardSimilarity(a: string, b: string): number {
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const t of sa) if (sb.has(t)) intersection += 1;
  const union = sa.size + sb.size - intersection;
  return intersection / union;
}

function buildBodyWithoutDescription(template: Record<string, unknown>): string {
  // Render the template as inspectable text WITHOUT the self-description and
  // WITHOUT per-task descriptions — these are the fields we'll compare against.
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(template)) {
    if (k === "description" || k === "name") continue;
    if (k === "tasks" && Array.isArray(v)) {
      filtered[k] = (v as Array<Record<string, unknown>>).map((task) => {
        const t: Record<string, unknown> = {};
        for (const [tk, tv] of Object.entries(task)) {
          if (tk === "description") continue;
          t[tk] = tv;
        }
        return t;
      });
      continue;
    }
    filtered[k] = v;
  }
  return JSON.stringify(filtered, null, 2);
}

function buildSelfDescription(template: Record<string, unknown>): {
  what: string;
  why: string;
  when_useful: string;
} {
  // The template's own self-description is its description plus the joined
  // task descriptions. We split it across the three comparison fields by
  // using the description as `what`, tags + ids as `why` (intent surface),
  // and task descriptions + outputShapes as `when_useful` (what state must
  // hold for the activity to produce its outputs).
  const description = String(template["description"] ?? "");
  const name = String(template["name"] ?? template["id"] ?? "");
  const tags = Array.isArray(template["tags"]) ? (template["tags"] as string[]).join(" ") : "";
  const id = String(template["id"] ?? "");
  const taskDescs = Array.isArray(template["tasks"])
    ? (template["tasks"] as Array<Record<string, unknown>>)
        .map((t) => String(t["description"] ?? ""))
        .filter((s) => s.length > 0)
        .join(" ")
    : "";
  const inputShapes = Array.isArray(template["inputShapes"]) ? (template["inputShapes"] as string[]).join(" ") : "";
  const outputShapes = Array.isArray(template["outputShapes"]) ? (template["outputShapes"] as string[]).join(" ") : "";

  return {
    what: `${name} ${description}`.trim(),
    why: `${id} ${tags} ${description}`.trim(),
    when_useful: `${inputShapes} ${outputShapes} ${taskDescs}`.trim(),
  };
}

async function fetchTemplate(templateId: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${METABOB_ENDPOINT}/v2/activities/templates/${encodeURIComponent(templateId)}`, {
      headers: { Authorization: `ApiKey ${METABOB_API_KEY}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function defaultLlmDispatch(prompt: string, model: string): Promise<string> {
  // Mirror llm-completion-dispatch's discovery path. Kept inline rather than
  // importing the other resolver so this stays a pure leaf module.
  let vessels: Array<{ endpoint: string; resolve_endpoint?: string; health_score?: number; confidence?: number }> = [];
  for (const shapeName of ["llmCompletion", "llm_completion"]) {
    const res = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape: shapeName } }),
    });
    if (!res.ok) continue;
    const data = (await res.json()) as { content?: { vessels?: typeof vessels } };
    vessels = data.content?.vessels ?? [];
    if (vessels.length > 0) break;
  }
  if (vessels.length === 0) throw new Error("no llm_completion vessel found in discovery");
  const best = vessels.sort((a, b) => (b.health_score ?? b.confidence ?? 0) - (a.health_score ?? a.confidence ?? 0))[0]!;
  const resolveEp = best.resolve_endpoint ?? "/resolve";
  const endpoint = resolveEp.startsWith("http")
    ? resolveEp
    : `${best.endpoint.replace(/\/$/, "")}${resolveEp.startsWith("/") ? resolveEp : `/${resolveEp}`}`;
  const llmRes = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "llm_completion", prompt, model, max_tokens: 800 }),
  });
  if (!llmRes.ok) throw new Error(`llm vessel ${llmRes.status}: ${await llmRes.text().catch(() => "")}`);
  const result = (await llmRes.json()) as { content?: string; data?: string; error?: string };
  if (result.error) throw new Error(result.error);
  return result.content ?? result.data ?? "";
}

function tryParseJson(text: string): { what?: string; why?: string; when_useful?: string } {
  // LLMs occasionally wrap in markdown fences or add prose. Strip and extract
  // the outermost JSON object.
  const stripped = text
    .replace(/^```(?:json)?\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1) return {};
  try {
    return JSON.parse(stripped.slice(start, end + 1)) as { what?: string; why?: string; when_useful?: string };
  } catch {
    return {};
  }
}

export async function resolveComprehensibilityCheck(
  pointer: ComprehensibilityCheckPointer,
): Promise<ResolverResult> {
  let template = pointer.template_json ?? null;
  let templateIdForReport: string | null = pointer.template_id ?? null;

  if (!template && pointer.template_id) {
    template = await fetchTemplate(pointer.template_id);
    if (!template) {
      const body: FailureModeBody = {
        shape: "structuredError",
        failure_mode: "input_error",
        detail: `template_id '${pointer.template_id}' not found in activity-api`,
      };
      return { shape: body.shape, body };
    }
  }

  if (!template) {
    const body: FailureModeBody = {
      shape: "structuredError",
      failure_mode: "input_error",
      detail: "one of template_id or template_json must be provided",
    };
    return { shape: body.shape, body };
  }

  if (!templateIdForReport && typeof template["id"] === "string") {
    templateIdForReport = String(template["id"]);
  }

  const model = pointer.model ?? DEFAULT_MODEL;
  const floor = pointer.floor ?? DEFAULT_FLOOR;
  const similarity = pointer._similarityFn ?? jaccardSimilarity;
  const llmFn = pointer._llmFn ?? defaultLlmDispatch;

  const stripped = buildBodyWithoutDescription(template);
  const selfDesc = buildSelfDescription(template);

  const prompt = `${COMPREHENSIBILITY_PROMPT_PREFIX}\n\nTemplate:\n${stripped}`;

  let rawAnswer: string;
  try {
    rawAnswer = await llmFn(prompt, model);
  } catch (err) {
    const body: FailureModeBody = {
      shape: "structuredError",
      failure_mode: "cascading",
      detail: err instanceof Error ? err.message : String(err),
      evaluator_model_id: model,
    };
    return { shape: body.shape, body };
  }

  const parsed = tryParseJson(rawAnswer);
  const llmWhat = String(parsed.what ?? "");
  const llmWhy = String(parsed.why ?? "");
  const llmWhenUseful = String(parsed.when_useful ?? "");

  const perField = {
    what: similarity(llmWhat, selfDesc.what),
    why: similarity(llmWhy, selfDesc.why),
    when_useful: similarity(llmWhenUseful, selfDesc.when_useful),
  };
  const overall = (perField.what + perField.why + perField.when_useful) / 3;
  const passed = overall >= floor;

  const reasoningDiff =
    `what[Δ=${(perField.what).toFixed(2)}]: llm="${llmWhat.slice(0, 80)}" vs self="${selfDesc.what.slice(0, 80)}"; ` +
    `why[Δ=${(perField.why).toFixed(2)}]: llm="${llmWhy.slice(0, 80)}" vs self="${selfDesc.why.slice(0, 80)}"; ` +
    `when[Δ=${(perField.when_useful).toFixed(2)}]: llm="${llmWhenUseful.slice(0, 80)}" vs self="${selfDesc.when_useful.slice(0, 80)}"`;

  const scoreBody: ComprehensibilityScoreBody = {
    shape: "comprehensibilityScore",
    template_id: templateIdForReport,
    overall_score: overall,
    floor,
    passed,
    per_field: perField,
    evaluator_model_id: model,
    evaluated_at: new Date().toISOString(),
    raw_answers: { what: llmWhat, why: llmWhy, when_useful: llmWhenUseful },
    reasoning_diff: reasoningDiff,
  };

  if (!passed) {
    // Emit verifier_negative.comprehensibility_below_floor — packaged as a
    // structuredError so existing failure_mode plumbing routes it correctly.
    // The score itself is still surfaced on the body for forensics.
    const body: FailureModeBody & { score_payload?: ComprehensibilityScoreBody } = {
      shape: "structuredError",
      failure_mode: "comprehensibility_below_floor",
      detail: `comprehensibility score ${overall.toFixed(3)} below floor ${floor}`,
      score: overall,
      floor,
      evaluator_model_id: model,
      score_payload: scoreBody,
    };
    return { shape: body.shape, body };
  }

  return { shape: scoreBody.shape, body: scoreBody };
}
