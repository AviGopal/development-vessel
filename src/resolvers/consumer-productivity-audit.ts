import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

/**
 * consumer_productivity_audit (2026-06-14) — the ANTI-SELF-DECEPTION check on
 * frontier expansion.
 *
 * `discover-by-shapes` (backward) flips a shape to "has a consumer" the moment
 * ANY template DECLARES it in input_shapes — regardless of whether that template
 * does anything with it. So a scaffold-clone (read_scenario → analyze → write a
 * *Proposal) that lists `obsidian:note` as an input makes the substrate believe
 * the shape is integrated, when in fact NO activity turns an obsidian note into
 * a real downstream impulse. The frontier reports coverage that does not exist —
 * the system lying to itself.
 *
 * Real instance (caught 2026-06-14): `diagnose-obsidian-note-comprehensibility`
 * declares input_shapes [obsidian:note, obsidian:graph_query], output_shapes
 * [noteComprehensibilityReport, vaultHealthReport, activityTemplateProposal];
 * its tasks are read_scenario → read one hardcoded note → analyze → write a
 * template *proposal*. It never consumes obsidian:note via the vessel and emits
 * only proposal-grade outputs. Yet it made both shapes read "covered".
 *
 * This resolver classifies every candidate consumer of a target shape:
 *   - productive       — has a SUCCESS trace consuming the shape and emitting a
 *                        genuine (non-proposal) downstream impulse  [PROVEN]
 *   - declared_unproven— statically plausible (declares the shape, references it,
 *                        emits a genuine output shape) but no trace proves it ran
 *   - scaffold_clone   — read→analyse→write-a-Proposal; all/only meta outputs
 *   - phantom          — declares the shape but no genuine output and never
 *                        references/consumes it
 *
 * Shape verdict: productively_consumed (≥1 productive) | falsely_covered
 * (candidates exist but none productive — THE LIE) | uncovered (no candidates).
 *
 * The discipline: NEVER call a consumer productive without trace evidence. The
 * cure for `declared_unproven` is to RUN it, not to assume it. This is the
 * signal that should gate vessel_arrival_scan's "integrated" verdict so the
 * frontier never flips on a declaration.
 */

const DEFAULT_TIMEOUT = 8000;

/**
 * A PROPOSAL output is the tell of a scaffold-clone: it proposes work (a new
 * template, a patch) rather than doing it. Emitting one while writing no durable
 * state is the drafter signature, not a consumer.
 */
const PROPOSAL_OUTPUT_RE = /proposal$/i;
const PROPOSAL_OUTPUT_SET = new Set<string>([
  "patch_proposal",
  "activityTemplateProposal",
  "draftProposal",
  "code_modification_proposal",
]);

/** Meta = doesn't advance the informational state on its own (proposal/review/audit/draft). */
const META_OUTPUT_RE = /(proposal|review|gapanalysis|gap_analysis|audit|draft)$/i;
const META_OUTPUT_SET = new Set<string>([
  ...PROPOSAL_OUTPUT_SET,
  "activityReview",
  "templateAuditReport",
  "vesselArrivalReport",
]);

function isProposal(shape: string): boolean {
  return PROPOSAL_OUTPUT_SET.has(shape) || PROPOSAL_OUTPUT_RE.test(shape);
}

/** A genuine state-advancing write impulse (concept_create_write, *_write, …). */
function isStateWrite(shape: string): boolean {
  return /_write$/i.test(shape);
}

export interface ConsumerProductivityAuditPointer {
  type: "consumer_productivity_audit";
  /** A single target shape, or use `shapes`. */
  shape?: string;
  shapes?: string[];
  metabobEndpoint?: string;
  apiKey?: string;
  timeoutMs?: number;
  /** When true (default) a consumer is `productive` only with trace evidence. */
  requireTraceEvidence?: boolean;
}

type Verdict = "productive" | "declared_unproven" | "scaffold_clone" | "phantom";

interface TemplateTask {
  id?: string;
  resolver?: string;
  input_shapes?: string[];
  inputShapes?: string[];
  output_shapes?: string[];
  outputShapes?: string[];
  config?: Record<string, unknown>;
}

interface Template {
  id?: string;
  template_id?: string;
  input_shapes?: string[];
  inputShapes?: string[];
  output_shapes?: string[];
  outputShapes?: string[];
  tasks?: TemplateTask[];
}

interface CandidateClassification {
  template_id: string;
  verdict: Verdict;
  declares_input: boolean;
  references_shape: boolean;
  genuine_output_shapes: string[];
  meta_output_shapes: string[];
  has_success_trace: boolean;
  reason: string;
}

interface ShapeReport {
  shape: string;
  candidate_count: number;
  verdict: "productively_consumed" | "falsely_covered" | "uncovered";
  productive: string[];
  declared_unproven: string[];
  scaffold_clones: string[];
  phantoms: string[];
  candidates: CandidateClassification[];
}

function isMeta(shape: string): boolean {
  return META_OUTPUT_SET.has(shape) || META_OUTPUT_RE.test(shape);
}

/** discover-by-shapes returns ids wrapped as `activity:⟨<inner>⟩`; unwrap. */
function unwrapId(id: string): string {
  const m = id.match(/^activity:⟨(.+)⟩$/);
  return m ? m[1]! : id;
}

function inShapes(t: Template | TemplateTask): string[] {
  return t.input_shapes ?? t.inputShapes ?? [];
}
function outShapes(t: Template | TemplateTask): string[] {
  return t.output_shapes ?? t.outputShapes ?? [];
}

/** A discover-by-shapes candidate. The endpoint already carries the template
 * structure (task_steps / input_schema / output_schema), so we can classify
 * without a second fetch — and id lives under activity_id/variant_id. */
interface DiscoverCandidate {
  id?: string;
  template_id?: string;
  activity_id?: string;
  variant_id?: string;
  input_shapes?: string[];
  inputShapes?: string[];
  input_schema?: { required_shapes?: string[] };
  output_shapes?: string[];
  outputShapes?: string[];
  output_schema?: { produces_shapes?: string[] };
  tasks?: TemplateTask[];
  task_steps?: TemplateTask[];
}

function candidateId(c: DiscoverCandidate): string {
  return unwrapId(c.activity_id ?? c.variant_id ?? c.id ?? c.template_id ?? "");
}

async function discoverConsumers(
  metabob: string,
  apiKey: string,
  shape: string,
  timeoutMs: number,
): Promise<DiscoverCandidate[]> {
  try {
    const res = await fetch(`${metabob.replace(/\/+$/, "")}/v2/activities/discover-by-shapes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${apiKey}` },
      body: JSON.stringify({ required_shapes: [shape], mode: "backward", limit: 25 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      activities?: DiscoverCandidate[];
      candidates?: DiscoverCandidate[];
      templates?: DiscoverCandidate[];
    };
    return (json.activities ?? json.candidates ?? json.templates ?? []).filter((c) => candidateId(c));
  } catch {
    return [];
  }
}

/** Normalise a discover candidate into a Template, mapping the nested schema
 * field names the discover endpoint uses (input_schema.required_shapes etc). */
function candidateToTemplate(c: DiscoverCandidate): Template {
  return {
    id: candidateId(c),
    input_shapes: c.input_shapes ?? c.inputShapes ?? c.input_schema?.required_shapes,
    output_shapes: c.output_shapes ?? c.outputShapes ?? c.output_schema?.produces_shapes,
    tasks: c.tasks ?? c.task_steps,
  };
}

async function fetchTemplate(
  metabob: string,
  apiKey: string,
  id: string,
  timeoutMs: number,
): Promise<Template | null> {
  try {
    const res = await fetch(
      `${metabob.replace(/\/+$/, "")}/v2/activities/templates/${encodeURIComponent(id)}`,
      { headers: { Authorization: `ApiKey ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { template?: Template } & Template;
    return json.template ?? json;
  } catch {
    return null;
  }
}

/** Normalise an id for comparison: unwrap `activity:⟨…⟩` and strip a leading
 * `activity:` so a trace's activity_id matches the candidate id regardless of
 * which wrapped form either side carries. */
function normId(id: string): string {
  return unwrapId(id).replace(/^activity:/, "");
}

/**
 * A success trace that genuinely belongs to `id` AND emitted one of the
 * candidate's expected genuine output shapes.
 *
 * CRITICAL HONESTY FIX (2026-06-14): the activity-api execution-traces endpoint
 * does NOT filter by the `activity_template_id` / `activity_id` query param — it
 * returns recent traces regardless. Trusting the param made this check match an
 * unrelated trace and falsely report a never-run consumer as `productive` (the
 * exact self-deception this resolver exists to catch). We now filter
 * CLIENT-SIDE: a trace counts only if its own activity_id/variant_id matches the
 * candidate AND its output shapes include a genuine output the candidate declares.
 */
async function hasProductiveTrace(
  metabob: string,
  apiKey: string,
  id: string,
  genuineOutputs: string[],
  timeoutMs: number,
): Promise<boolean> {
  if (genuineOutputs.length === 0) return false;
  const target = normId(id);
  const wanted = new Set(genuineOutputs);
  try {
    const res = await fetch(
      `${metabob.replace(/\/+$/, "")}/v2/activities/execution-traces?limit=100`,
      { headers: { Authorization: `ApiKey ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!res.ok) return false;
    const json = (await res.json()) as {
      executions?: Array<{
        status?: string;
        success?: boolean;
        output_impulse_shapes?: string[];
        activity_id?: string;
        variant_id?: string;
        activity_template_id?: string;
      }>;
    };
    for (const r of json.executions ?? []) {
      const belongsToThis = [r.activity_id, r.variant_id, r.activity_template_id]
        .filter(Boolean)
        .some((tid) => normId(tid!) === target);
      if (!belongsToThis) continue;
      const ok = r.success === true || r.status === "success";
      const emittedWanted = (r.output_impulse_shapes ?? []).some((s) => wanted.has(s));
      if (ok && emittedWanted) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function referencesShape(t: Template, shape: string): boolean {
  const namespace = shape.includes(":") ? shape.split(":")[0]! : shape;
  for (const task of t.tasks ?? []) {
    if (inShapes(task).includes(shape)) return true;
    const cfg = JSON.stringify(task.config ?? {});
    if (cfg.includes(shape) || (namespace.length > 3 && cfg.includes(namespace))) return true;
  }
  return false;
}

async function classifyCandidate(
  metabob: string,
  apiKey: string,
  shape: string,
  candidate: DiscoverCandidate,
  requireTrace: boolean,
  timeoutMs: number,
): Promise<CandidateClassification> {
  const id = candidateId(candidate);
  // Per-id fetch is authoritative (flat input_shapes/output_shapes/tasks); fall
  // back to the inline discover candidate (nested schema) if the fetch fails.
  const tpl = (await fetchTemplate(metabob, apiKey, id, timeoutMs)) ?? candidateToTemplate(candidate);
  const declaresInput = inShapes(tpl).includes(shape);
  const refs = referencesShape(tpl, shape);
  const outs = outShapes(tpl);
  const genuine = outs.filter((s) => !isMeta(s) && s !== shape);
  const meta = outs.filter((s) => isMeta(s));
  const proposalOuts = outs.filter(isProposal);
  const stateWriteOuts = outs.filter(isStateWrite);
  // Scaffold signature: PROPOSES work (emits a *Proposal) but writes no durable
  // state. This catches the drafter-clone even when it co-emits a *Report — a
  // report-to-proposals-dir is not consumption. Checked FIRST, before the
  // report would otherwise read as a "genuine" output.
  const scaffold = proposalOuts.length > 0 && stateWriteOuts.length === 0;
  // Productive evidence requires a real downstream impulse: a state-write, or a
  // non-meta domain output the consumer is proven (by trace) to emit.
  const hasGenuineOutput = stateWriteOuts.length > 0 || genuine.length > 0;
  // Trace must emit one of THIS candidate's genuine outputs — not just any
  // non-meta shape from an unrelated trace.
  const genuineOutputSet = [...new Set([...stateWriteOuts, ...genuine])];
  const hasTrace = scaffold ? false : await hasProductiveTrace(metabob, apiKey, id, genuineOutputSet, timeoutMs);

  let verdict: Verdict;
  let reason: string;
  if (scaffold) {
    verdict = "scaffold_clone";
    reason = `emits proposal output(s) [${proposalOuts.join(", ")}] and writes no durable state — proposes work, does not consume ${shape}`;
  } else if (!hasGenuineOutput) {
    verdict = "phantom";
    reason = `declares ${shape} but produces no genuine downstream impulse (outputs: [${outs.join(", ")}])`;
  } else if (hasTrace) {
    verdict = "productive";
    reason = `success trace emits a genuine downstream shape while consuming ${shape}`;
  } else if (declaresInput && refs && !requireTrace) {
    verdict = "productive";
    reason = `statically genuine (declares+references ${shape}, emits [${[...stateWriteOuts, ...genuine].join(", ")}]); trace evidence not required`;
  } else {
    verdict = "declared_unproven";
    reason = refs
      ? `plausible (declares+references ${shape}, emits [${[...stateWriteOuts, ...genuine].join(", ")}]) but no success trace proves it ran`
      : `declares ${shape} but no task references/consumes it and no success trace`;
  }
  return {
    template_id: id,
    verdict,
    declares_input: declaresInput,
    references_shape: refs,
    genuine_output_shapes: genuine,
    meta_output_shapes: meta,
    has_success_trace: hasTrace,
    reason,
  };
}

async function auditShape(
  metabob: string,
  apiKey: string,
  shape: string,
  requireTrace: boolean,
  timeoutMs: number,
): Promise<ShapeReport> {
  const discovered = await discoverConsumers(metabob, apiKey, shape, timeoutMs);
  // Dedup by id (a variant family can appear multiple times).
  const seen = new Set<string>();
  const candidates: CandidateClassification[] = [];
  for (const cand of discovered) {
    const id = candidateId(cand);
    if (seen.has(id)) continue;
    seen.add(id);
    candidates.push(await classifyCandidate(metabob, apiKey, shape, cand, requireTrace, timeoutMs));
  }
  const by = (v: Verdict) => candidates.filter((c) => c.verdict === v).map((c) => c.template_id);
  const productive = by("productive");
  const verdict: ShapeReport["verdict"] =
    productive.length > 0
      ? "productively_consumed"
      : candidates.length > 0
        ? "falsely_covered"
        : "uncovered";
  return {
    shape,
    candidate_count: candidates.length,
    verdict,
    productive,
    declared_unproven: by("declared_unproven"),
    scaffold_clones: by("scaffold_clone"),
    phantoms: by("phantom"),
    candidates,
  };
}

export async function resolveConsumerProductivityAudit(
  pointer: ConsumerProductivityAuditPointer,
): Promise<ResolverResult> {
  const metabob = pointer.metabobEndpoint ?? METABOB_ENDPOINT;
  const apiKey = pointer.apiKey ?? METABOB_API_KEY;
  const timeoutMs = pointer.timeoutMs ?? DEFAULT_TIMEOUT;
  const requireTrace = pointer.requireTraceEvidence ?? true;
  const generatedAt = new Date().toISOString();

  const shapes = (pointer.shapes ?? (pointer.shape ? [pointer.shape] : [])).filter(Boolean);
  if (shapes.length === 0) {
    return {
      shape: "consumerProductivityReport",
      body: { error: "no_shape_specified", generated_at: generatedAt },
    };
  }
  if (!apiKey) {
    return {
      shape: "consumerProductivityReport",
      body: { error: "missing_api_key", generated_at: generatedAt },
    };
  }

  const reports: ShapeReport[] = [];
  for (const shape of shapes) {
    reports.push(await auditShape(metabob, apiKey, shape, requireTrace, timeoutMs));
  }

  const claimedCovered = reports.filter((r) => r.candidate_count > 0).length;
  const trulyCovered = reports.filter((r) => r.verdict === "productively_consumed").length;
  const falselyCovered = reports.filter((r) => r.verdict === "falsely_covered").map((r) => r.shape);

  return {
    shape: "consumerProductivityReport",
    body: {
      generated_at: generatedAt,
      require_trace_evidence: requireTrace,
      shape_count: shapes.length,
      // The punchline: declared coverage vs proven coverage. The gap is the lie.
      honest_frontier: {
        claimed_covered: claimedCovered,
        truly_covered: trulyCovered,
        coverage_overstated_by: claimedCovered - trulyCovered,
      },
      falsely_covered: falselyCovered,
      shapes: reports,
    },
  };
}
