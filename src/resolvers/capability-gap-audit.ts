/**
 * capability_gap_audit — detect missing-resolver gaps from recent failure traces.
 *
 * Walks recent failure traces from activity-api. For each, examines the trace's
 * tasks for failure signals that indicate "missing capability":
 *   - task resolver name resolves to no registered handler ("unknown shape" errors)
 *   - task tried to dispatch to a shape that no vessel advertises
 *   - LLM error indicates "X not supported" / "no resolver for type Y"
 *   - HTTP fetch hit a 404 on substrate-internal paths
 *   - task expected an output_shape that no current resolver produces
 *
 * Aggregates by failure signature into capability gaps. Each gap describes:
 *   - wanted_capability: short name of the missing capability
 *   - failure_examples: trace ids citing this gap
 *   - closest_existing_resolver: nearest match by name + shape similarity
 *   - proposed_resolver_name: snake_case name suggestion
 *   - proposed_pointer_shape: rough TypeScript interface
 *   - output_shape: what new shape this would emit
 *
 * Emits substrateGap (category=missing_capability) citing examples. The
 * resolver_author seed template consumes those gaps to author the new resolver.
 *
 * Constitutional principle (concept_9ldsmRgqSTd5): every observed bug class is
 * an opportunity to author a detection. Here we author the meta-detector that
 * makes capability gaps observable so the substrate can extend its OWN
 * capability surface autonomously.
 */

import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";
const DEFAULT_DISCOVERY_URL = "http://127.0.0.1:8100";

export interface CapabilityGapAuditPointer {
  type: "capability_gap_audit";
  window_hours?: number;
  trace_limit?: number;
  emit_gap?: boolean;
  metabobEndpoint?: string;
  devVesselImpulsesUrl?: string;
  discoveryEndpoint?: string;
}

interface TraceTask {
  task_id?: string;
  resolver?: string;
  resolver_id?: string;
  success?: boolean;
  error?: string;
  stderr?: string;
  output_shapes?: string[];
  config?: { type?: string; url?: string };
}

interface ExecutionTrace {
  id?: string;
  activity_id?: string;
  status?: string;
  tasks?: TraceTask[];
  failure_mode?: { type?: string; reason?: string; context?: Record<string, unknown> } | null;
  executed_at?: string;
}

interface CapabilityGap {
  wanted_capability: string;
  signature: string;
  failure_examples: string[];
  closest_existing_resolver: string | null;
  proposed_resolver_name: string;
  proposed_pointer_shape: string;
  output_shape: string;
  occurrence_count: number;
  evidence_snippets: string[];
}

// Patterns that indicate "missing capability" in error text.
const MISSING_CAPABILITY_PATTERNS: Array<{ re: RegExp; capture: number; kind: string }> = [
  { re: /unknown shape:?\s*['"]?([a-zA-Z_][a-zA-Z0-9_]*)['"]?/i, capture: 1, kind: "unknown_shape" },
  { re: /no resolver (?:found )?for (?:type|shape) ['"]?([a-zA-Z_][a-zA-Z0-9_]*)['"]?/i, capture: 1, kind: "no_resolver" },
  { re: /resolver ['"]?([a-zA-Z_][a-zA-Z0-9_]*)['"]? not (?:found|registered|supported)/i, capture: 1, kind: "not_registered" },
  { re: /(?:404|not found).*?(\/v2\/[a-z\-/]+|\/[a-z\-]+\/[a-z\-]+)/i, capture: 1, kind: "endpoint_404" },
  { re: /no producer for (?:output[_ ])?shape ['"]?([a-zA-Z_][a-zA-Z0-9_]*)['"]?/i, capture: 1, kind: "no_producer" },
];

function snakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase()
    .replace(/^_+|_+$/g, "");
}

function similarity(a: string, b: string): number {
  // Simple token-overlap similarity for finding closest existing resolver.
  const ta = new Set(a.toLowerCase().split(/[_\-]+/).filter(Boolean));
  const tb = new Set(b.toLowerCase().split(/[_\-]+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
}

function extractMissingCapability(task: TraceTask, tr: ExecutionTrace): { capability: string; kind: string; snippet: string } | null {
  const text = [task.error, task.stderr, tr.failure_mode?.reason, JSON.stringify(tr.failure_mode?.context ?? {})]
    .filter(Boolean)
    .join(" ");
  for (const p of MISSING_CAPABILITY_PATTERNS) {
    const m = text.match(p.re);
    if (m && m[p.capture]) {
      return { capability: m[p.capture]!, kind: p.kind, snippet: m[0].slice(0, 160) };
    }
  }
  return null;
}

async function fetchDiscoveryShapes(discoveryUrl: string): Promise<Set<string>> {
  try {
    const r = await fetch(`${discoveryUrl}/shapes`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return new Set();
    const j = await r.json() as { shapes?: string[] };
    return new Set(j.shapes ?? []);
  } catch { return new Set(); }
}

async function emitGap(emitUrl: string, apiKey: string, gap: CapabilityGap): Promise<boolean> {
  const body = {
    impulse: {
      pointer: {
        type: "substrateGap_write",
        gap: {
          id: `capability-gap-${gap.signature}`,
          category: "missing_capability",
          source: "substrate_detected",
          summary: `Substrate observed ${gap.occurrence_count}× failures requesting missing capability "${gap.wanted_capability}". Closest existing resolver: ${gap.closest_existing_resolver ?? "none"}. Propose: ${gap.proposed_resolver_name} → ${gap.output_shape}.`,
          detected_at: new Date().toISOString(),
          status: "open",
          classification_metadata: {
            detector: "capability_gap_audit",
            cite_principle: "substrate_extends_its_own_capability_surface_when_gaps_exist",
            wanted_capability: gap.wanted_capability,
            closest_existing_resolver: gap.closest_existing_resolver,
            proposed_resolver_name: gap.proposed_resolver_name,
            proposed_pointer_shape: gap.proposed_pointer_shape,
            output_shape: gap.output_shape,
            failure_examples: gap.failure_examples.slice(0, 5),
            evidence_snippets: gap.evidence_snippets.slice(0, 3),
            suggested_remediation: "Dispatch resolver_author seed template against this gap to draft a 4-file resolver patch following the three-place rule.",
          },
        },
      },
    },
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const r = await fetch(emitUrl, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    return r.ok;
  } catch { return false; }
}

export async function resolveCapabilityGapAudit(
  pointer: CapabilityGapAuditPointer,
): Promise<ResolverResult> {
  const endpoint = pointer.metabobEndpoint ?? METABOB_ENDPOINT;
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const discoveryUrl = pointer.discoveryEndpoint ?? DEFAULT_DISCOVERY_URL;
  const windowHours = pointer.window_hours ?? 24;
  const traceLimit = pointer.trace_limit ?? 200;
  const emit = pointer.emit_gap !== false;
  const apiKey = process.env["METABOB_API_KEY"] ?? METABOB_API_KEY;

  // Fetch recent traces + advertised shapes in parallel.
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  let traces: ExecutionTrace[] = [];
  try {
    const r = await fetch(`${endpoint}/v2/activities/execution-traces?limit=${traceLimit}`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    if (r.ok) {
      const j = await r.json() as { executions?: ExecutionTrace[] };
      traces = j.executions ?? [];
    }
  } catch { /* tolerant — empty traces list */ }
  const advertisedShapes = await fetchDiscoveryShapes(discoveryUrl);

  // Filter to recent failures.
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  const failures = traces.filter((tr) => {
    if (tr.status !== "failure" && tr.status !== "failed") return false;
    if (tr.executed_at) {
      const t = Date.parse(tr.executed_at);
      if (!isNaN(t) && t < cutoff) return false;
    }
    return true;
  });

  // Aggregate by capability signature.
  const groups = new Map<string, CapabilityGap>();
  for (const tr of failures) {
    for (const task of tr.tasks ?? []) {
      if (task.success === true) continue;
      const extracted = extractMissingCapability(task, tr);
      if (!extracted) continue;
      const sig = snakeCase(extracted.capability);
      if (!sig) continue;
      const existing = groups.get(sig);
      if (existing) {
        existing.occurrence_count += 1;
        if (existing.failure_examples.length < 10 && tr.id && !existing.failure_examples.includes(tr.id)) {
          existing.failure_examples.push(tr.id);
        }
        if (existing.evidence_snippets.length < 5 && !existing.evidence_snippets.includes(extracted.snippet)) {
          existing.evidence_snippets.push(extracted.snippet);
        }
      } else {
        // Find closest existing advertised shape by similarity.
        let closest: string | null = null;
        let bestScore = 0;
        for (const shape of advertisedShapes) {
          const score = similarity(sig, shape);
          if (score > bestScore && score >= 0.3) {
            closest = shape;
            bestScore = score;
          }
        }
        groups.set(sig, {
          wanted_capability: extracted.capability,
          signature: sig,
          failure_examples: tr.id ? [tr.id] : [],
          closest_existing_resolver: closest,
          proposed_resolver_name: sig,
          proposed_pointer_shape: `interface ${extracted.capability.replace(/_./g, (s) => s[1]!.toUpperCase()).replace(/^./, (s) => s.toUpperCase())}Pointer { type: "${sig}"; /* TODO: declare inputs from failure trace evidence */ }`,
          output_shape: sig.endsWith("_result") || sig.endsWith("_report") ? sig : `${sig}Result`,
          occurrence_count: 1,
          evidence_snippets: [extracted.snippet],
        });
      }
    }
  }

  const gaps = Array.from(groups.values()).sort((a, b) => b.occurrence_count - a.occurrence_count);

  let gaps_emitted = 0;
  if (emit && gaps.length > 0) {
    for (const g of gaps) {
      const ok = await emitGap(emitUrl, apiKey, g);
      if (ok) gaps_emitted += 1;
    }
  }

  return {
    shape: "capabilityGapReport",
    body: {
      window_hours: windowHours,
      traces_examined: traces.length,
      failures_examined: failures.length,
      gaps,
      gaps_emitted,
      completed_at: new Date().toISOString(),
    },
  };
}
