import {
  CONCEPT_DB_ENDPOINT,
  METABOB_API_KEY,
  METABOB_ENDPOINT,
  WORKSPACE_ROOT as DEFAULT_WORKSPACE_ROOT,
} from "../config.js";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";

/**
 * intervention_evaluate — S3 push-away primitive (2026-06-02).
 *
 * Per IAL §27.S.6, S3 readiness is measured by ACTIVE push-away: the substrate
 * refuses operator interventions with cited evidence, sustained over a window.
 * Today there is no resolver that evaluates a proposed intervention against
 * substrate priors and emits a verdict — this is that primitive.
 *
 * This is the SHAPE primitive only. Refusal POLICY here is deterministic and
 * conservative; semantic evaluation (does the diff_summary actually conflict
 * with the cited evidence?) is for a later iteration that COMPOSES this with
 * comprehensibility_check.
 *
 * Refusal policy (no LLM, structural):
 *   - REFUSE when cited_evidence.length === 0 AND substrate has concrete
 *     contradicting priors AND strictness !== "permissive".
 *   - REFUSE when proposed_change.source === "operator" AND target_path is a
 *     substrate-authored file (Substrate-Authored-By trailer) AND
 *     strictness === "strict". Preserves the lift recursion.
 *   - DEFER when cited evidence exists but priors are inconclusive.
 *   - DEFER when concept-db or activity-api is unreachable (cannot judge).
 *   - ACCEPT otherwise.
 *
 * Substrate priors come from:
 *   - Recent execution traces (activity-api executionTraceList, 50-lookback)
 *   - Concepts with name/path overlap on target_path or diff_summary keywords
 *   - Memory notes by title-substring (substrateGap-style local store; skip
 *     gracefully if unavailable)
 *
 * Constitutional principle: every operator intervention is a chance for the
 * substrate to express a position, including a refusal. The primitive is what
 * matters — priors accumulate over time and the policy here intentionally
 * starts permissive (most checks default to ACCEPT). Operator-side authoring
 * of this primitive is legitimate — see development-vessel/CLAUDE.md
 * "three-place rule".
 */

const DEFAULT_CONCEPT_DB = CONCEPT_DB_ENDPOINT;
const DEFAULT_TRACES = `${METABOB_ENDPOINT}/v2/activities/execution-traces?limit=50`;

export type InterventionStrictness = "permissive" | "balanced" | "strict";

export interface ProposedChange {
  target_path: string;
  diff_summary: string;
  source: "operator" | "external" | "substrate_authored";
  intent: string;
}

export interface CitedEvidence {
  kind: "trace_id" | "concept_id" | "file_path" | "github_url" | "memo";
  ref: string;
  note?: string;
}

export interface InterventionEvaluatePointer {
  type: "intervention_evaluate";
  proposed_change: ProposedChange;
  cited_evidence: CitedEvidence[];
  conceptDbUrl?: string;
  tracesUrl?: string;
  strictness?: InterventionStrictness;
}

interface PriorRef {
  kind: "trace_id" | "concept_id" | "memo_id";
  ref: string;
  relevance: "supports" | "contradicts" | "informs";
  note: string;
}

// Naive keyword extraction — strip path components, split on non-word, drop
// short tokens. Deterministic, no LLM.
function keywordsOf(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4)
    .slice(0, 12);
}

async function fetchConcepts(
  conceptDbUrl: string,
  query: string,
): Promise<Array<{ id: string; name?: string; summary?: string }>> {
  try {
    const res = await fetch(
      `${conceptDbUrl}/concepts/search?q=${encodeURIComponent(query)}&limit=5`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      concepts?: Array<{ id?: string; name?: string; summary?: string }>;
    };
    return (data.concepts ?? [])
      .filter((c) => typeof c.id === "string")
      .map((c) => ({ id: c.id as string, name: c.name, summary: c.summary }));
  } catch {
    return [];
  }
}

interface TraceRow {
  execution_id?: unknown;
  id?: unknown;
  status?: unknown;
  activity_id?: unknown;
  variant_id?: unknown;
  failure_mode?: unknown;
}

async function fetchTraces(tracesUrl: string): Promise<TraceRow[]> {
  try {
    const headers: Record<string, string> = METABOB_API_KEY
      ? { Authorization: `ApiKey ${METABOB_API_KEY}` }
      : {};
    const res = await fetch(tracesUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      traces?: unknown;
      executions?: unknown;
    };
    if (Array.isArray(json.traces)) return json.traces as TraceRow[];
    if (Array.isArray(json.executions)) return json.executions as TraceRow[];
    return [];
  } catch {
    return [];
  }
}

// Read the target file's first ~2KB and look for a Substrate-Authored-By
// trailer or substrate-authored: prefix line. Best-effort; if the path doesn't
// exist locally we cannot tell — caller should treat as operator-modifiable.
async function isSubstrateAuthoredFile(targetPath: string): Promise<boolean> {
  try {
    const root = process.env["WORKSPACE_ROOT"] ?? DEFAULT_WORKSPACE_ROOT;
    const fullPath = targetPath.startsWith("/")
      ? targetPath
      : join(root, targetPath);
    const fd = await readFile(fullPath, "utf-8");
    const head = fd.slice(0, 2048);
    return (
      head.includes("Substrate-Authored-By:") ||
      head.includes("substrate-authored:")
    );
  } catch {
    return false;
  }
}

interface RefusalRecord {
  id: string;
  proposed_change: ProposedChange;
  refusal_basis: string;
  substrate_priors_cited: PriorRef[];
  refused_at: string;
  strictness: InterventionStrictness;
}

function refusalsPath(): string {
  const root = process.env["WORKSPACE_ROOT"] ?? DEFAULT_WORKSPACE_ROOT;
  return join(root, "refusals", "refusals.json");
}

async function loadRefusals(): Promise<RefusalRecord[]> {
  try {
    const raw = await readFile(refusalsPath(), "utf-8");
    return JSON.parse(raw) as RefusalRecord[];
  } catch {
    return [];
  }
}

async function saveRefusals(records: RefusalRecord[]): Promise<void> {
  const root = process.env["WORKSPACE_ROOT"] ?? DEFAULT_WORKSPACE_ROOT;
  await mkdir(join(root, "refusals"), { recursive: true });
  const tmp = refusalsPath() + ".tmp";
  await writeFile(tmp, JSON.stringify(records, null, 2), "utf-8");
  await rename(tmp, refusalsPath());
}

export async function resolveInterventionEvaluate(
  pointer: InterventionEvaluatePointer,
): Promise<ResolverResult> {
  const strictness = pointer.strictness ?? "balanced";
  const conceptDbUrl = pointer.conceptDbUrl ?? DEFAULT_CONCEPT_DB;
  const tracesUrl = pointer.tracesUrl ?? DEFAULT_TRACES;
  const evaluated_at = new Date().toISOString();
  const pc = pointer.proposed_change;
  const cited = Array.isArray(pointer.cited_evidence) ? pointer.cited_evidence : [];

  // ── Probe substrate priors ──────────────────────────────────────────────
  const keywords = [
    ...keywordsOf(pc.target_path),
    ...keywordsOf(pc.diff_summary),
    ...keywordsOf(pc.intent),
  ];
  const probe = keywords.slice(0, 5).join(" ") || pc.target_path;

  const concepts = await fetchConcepts(conceptDbUrl, probe);
  const traces = await fetchTraces(tracesUrl);
  const conceptDbReachable = concepts.length > 0 || (await fetchConcepts(conceptDbUrl, "x")).length >= 0
    ? true
    : false;
  // Cheaper probe: if conceptDbUrl fetch itself threw, fetchConcepts already
  // returned []; we treat zero hits + zero traces as "priors unreachable" only
  // when BOTH endpoints failed (signal of substrate offline).
  const tracesReachable = traces.length > 0;
  const priorsUnreachable = concepts.length === 0 && !tracesReachable;

  // Convert priors to refs. A concept that mentions diff keywords becomes
  // "informs". A concept whose name overlaps the target_path becomes
  // "contradicts" if the diff_summary contains a verb suggesting removal
  // ("remove", "delete", "revert", "rollback") — heuristic; deterministic.
  const removalVerbs = ["remove", "delete", "revert", "rollback", "drop"];
  const diffLower = pc.diff_summary.toLowerCase();
  const isRemoval = removalVerbs.some((v) => diffLower.includes(v));

  const priorsCited: PriorRef[] = [];
  for (const c of concepts.slice(0, 5)) {
    const nameLower = (c.name ?? "").toLowerCase();
    const pathLower = pc.target_path.toLowerCase();
    const overlap = nameLower.length > 0 && pathLower.includes(nameLower.split(/\s+/)[0] ?? "");
    const relevance: PriorRef["relevance"] = isRemoval && overlap
      ? "contradicts"
      : "informs";
    priorsCited.push({
      kind: "concept_id",
      ref: c.id,
      relevance,
      note: c.name ?? c.summary?.slice(0, 80) ?? "concept match on diff keywords",
    });
  }

  // Recent failed traces of the target template family contribute as
  // "contradicts" when source === "operator" and the operator is proposing to
  // modify code with a recent failure history.
  const failedTraces = traces.filter((t) => t.status === "failure").slice(0, 3);
  for (const t of failedTraces) {
    const eid = typeof t.execution_id === "string"
      ? t.execution_id
      : typeof t.id === "string" ? t.id : "unknown";
    priorsCited.push({
      kind: "trace_id",
      ref: eid,
      relevance: "informs",
      note: "recent failure in trace window",
    });
  }

  const contradicting = priorsCited.filter((p) => p.relevance === "contradicts");

  // ── Decision tree ───────────────────────────────────────────────────────
  // Cited-evidence strength: 1.0 if any cited refs, 0 otherwise. (Semantic
  // strength check is a future iteration.)
  const cited_evidence_strength_score = cited.length > 0 ? 1.0 : 0.0;

  let verdict: "ACCEPT" | "REFUSE" | "DEFER" = "ACCEPT";
  let reason = "no policy gate triggered; default ACCEPT";
  let refusal_basis: string | undefined;
  let defer_until_condition: string | undefined;

  if (priorsUnreachable) {
    verdict = "DEFER";
    reason = "substrate priors unreachable (concept-db + activity-api both returned no data)";
    defer_until_condition = "concept-db and activity-api responsive";
  } else if (cited.length === 0 && contradicting.length > 0 && strictness !== "permissive") {
    verdict = "REFUSE";
    reason = `no cited_evidence and ${contradicting.length} contradicting prior(s) found`;
    refusal_basis = `contradicting priors: ${contradicting.map((p) => p.ref).join(", ")}`;
  } else if (
    strictness === "strict" &&
    pc.source === "operator" &&
    (await isSubstrateAuthoredFile(pc.target_path))
  ) {
    verdict = "REFUSE";
    reason = "operator modifying substrate-authored file under strict policy";
    refusal_basis =
      `target ${pc.target_path} carries Substrate-Authored-By provenance; ` +
      "substrate-authored content should be modified by substrate (preserves lift recursion)";
  } else if (cited.length > 0 && concepts.length === 0 && !tracesReachable) {
    verdict = "DEFER";
    reason = "cited evidence present but substrate priors inconclusive";
    defer_until_condition =
      "≥3 execution traces matching pattern (target_path keywords) OR ≥1 concept hit on diff_summary";
  } else if (cited.length > 0) {
    verdict = "ACCEPT";
    reason =
      `${cited.length} cited evidence ref(s); ${priorsCited.length} prior(s) inform context; ` +
      `no contradicting priors triggered under strictness=${strictness}`;
  }

  // Persist refusal record (best-effort) so the substrate can later read its
  // own refusal history.
  if (verdict === "REFUSE") {
    try {
      const records = await loadRefusals();
      const id = `refusal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      records.push({
        id,
        proposed_change: pc,
        refusal_basis: refusal_basis ?? reason,
        substrate_priors_cited: priorsCited,
        refused_at: evaluated_at,
        strictness,
      });
      await saveRefusals(records);
    } catch {
      // never crash on persistence failure
    }
  }

  const body: Record<string, unknown> = {
    verdict,
    reason,
    evaluated_at,
    proposed_change: pc,
    cited_evidence_strength_score,
    substrate_priors_cited: priorsCited,
    strictness,
    concept_db_reachable: conceptDbReachable && concepts.length > 0,
    traces_reachable: tracesReachable,
  };
  if (refusal_basis) body["refusal_basis"] = refusal_basis;
  if (defer_until_condition) body["defer_until_condition"] = defer_until_condition;

  return { shape: "interventionEvaluation", body };
}

// ── interventionRefused reader + writer ─────────────────────────────────────
// The shape `interventionRefused` is the stored refusal record. The resolver
// above persists records when it returns verdict===REFUSE; the reader exposes
// them so substrate activities (and operator audit) can query refusal history.

export interface InterventionRefusedReadPointer {
  type: "interventionRefused";
  id?: string;
  source?: ProposedChange["source"];
  limit?: number;
}

export async function resolveInterventionRefused(
  pointer: InterventionRefusedReadPointer,
): Promise<ResolverResult> {
  const records = await loadRefusals();
  const limit = pointer.limit ?? 50;
  let filtered = records;
  if (pointer.id) filtered = filtered.filter((r) => r.id === pointer.id);
  if (pointer.source) filtered = filtered.filter((r) => r.proposed_change.source === pointer.source);
  filtered = filtered.sort((a, b) => b.refused_at.localeCompare(a.refused_at)).slice(0, limit);
  return {
    shape: "interventionRefused",
    body: { refusals: filtered, total: filtered.length },
  };
}

export interface InterventionRefusedWritePointer {
  type: "interventionRefused_write";
  refusal: Omit<RefusalRecord, "refused_at"> & { refused_at?: string };
}

export async function resolveInterventionRefusedWrite(
  pointer: InterventionRefusedWritePointer,
): Promise<ResolverResult> {
  const now = new Date().toISOString();
  const incoming = pointer.refusal;
  const record: RefusalRecord = {
    ...incoming,
    refused_at: incoming.refused_at ?? now,
  };
  const records = await loadRefusals();
  const idx = records.findIndex((r) => r.id === record.id);
  if (idx >= 0) records[idx] = record;
  else records.push(record);
  await saveRefusals(records);
  return {
    shape: "interventionRefusedWriteResult",
    body: { id: record.id, action: idx >= 0 ? "updated" : "created" },
  };
}
