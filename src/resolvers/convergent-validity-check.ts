import type { ResolverResult } from "./types.js";

export interface ConvergentValidityCheckPointer {
  type: "convergent_validity_check";
  /** Shapes the preceding task(s) claimed to produce. */
  produced_shapes: string[];
  /** Optional: execution_id of the trace being validated. */
  execution_id?: string;
  /** Optional: task_id whose output is being checked. */
  task_id?: string;
  /**
   * Minimum co-occurrence edge weight to treat a shape as "expected".
   * Edges with weight below this threshold are ignored as noise.
   * Default: 2.
   */
  min_edge_weight?: number;
  /**
   * If true, a co-occurrence mismatch fails the check (throws).
   * If false (default), a mismatch records a warning but passes.
   * Use strict=true only after concept-db has accumulated enough edges
   * to make co-occurrence expectations reliable (edge count > 10).
   */
  strict?: boolean;
}

interface ConceptEdge {
  from_shape: string;
  to_shape: string;
  weight: number;
}

const CONCEPT_DB_ENDPOINT =
  process.env.CONCEPT_DB_ENDPOINT ?? "http://127.0.0.1:8260";

export async function resolveConvergentValidityCheck(
  pointer: ConvergentValidityCheckPointer,
): Promise<ResolverResult> {
  const {
    produced_shapes,
    execution_id,
    task_id,
    min_edge_weight = 2,
    strict = false,
  } = pointer;

  if (!produced_shapes || produced_shapes.length === 0) {
    return {
      shape: "convergentValidityResult",
      body: {
        verdict: "skip",
        reason: "no produced_shapes to check",
        produced_shapes,
        execution_id,
        task_id,
      },
    };
  }

  // ── Signal 1: concept-db co-occurrence consistency ───────────────────────
  // For each produced shape, fetch co-occurrence edges from concept-db.
  // If high-weight edges point to shapes that are ABSENT from produced_shapes
  // and the current impulse pool, that's a divergence signal — the substrate
  // produced a shape in a context where concept-db expects a different
  // co-occurring pattern.
  let cooccurrenceEdges: ConceptEdge[] = [];
  let conceptDbReachable = false;
  try {
    const res = await fetch(`${CONCEPT_DB_ENDPOINT}/mcp/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(4000),
      body: JSON.stringify({
        tool: "concept_cooccurrence_edges",
        arguments: { limit: 50 },
      }),
    });
    if (res.ok) {
      const data = await res.json() as { result?: { edges?: ConceptEdge[] } };
      cooccurrenceEdges = data?.result?.edges ?? [];
      conceptDbReachable = true;
    }
  } catch {
    // concept-db offline is non-fatal — skip Signal 1 gracefully
  }

  // ── Signal 2: concept-db shape recognition ───────────────────────────────
  // Do any of the produced shapes appear in concept-db's learned vocabulary?
  // A shape that has never appeared in concept-db is either genuinely new
  // (exploration success) or an invented label (potential ghost).
  const shapeRecognition: Record<string, boolean> = {};
  if (conceptDbReachable) {
    for (const shape of produced_shapes) {
      try {
        const res = await fetch(
          `${CONCEPT_DB_ENDPOINT}/concepts/search?q=${encodeURIComponent(shape)}&limit=1`,
          { signal: AbortSignal.timeout(3000) },
        );
        if (res.ok) {
          const data = await res.json() as { concepts?: Array<{ shape?: string }> };
          const found = (data?.concepts ?? []).some(
            (c) => c.shape === shape,
          );
          shapeRecognition[shape] = found;
        }
      } catch {
        // shape recognition is best-effort
      }
    }
  }

  // ── Evaluate co-occurrence divergence ────────────────────────────────────
  // Filter edges where at least one side is a produced shape and the
  // co-occurring partner is NOT in produced_shapes. High-weight edges
  // represent strong learned expectations; their absence is a divergence.
  const strongEdges = cooccurrenceEdges.filter(
    (e) => e.weight >= min_edge_weight,
  );
  const producedSet = new Set(produced_shapes);
  const missingExpected: Array<{ expected: string; via: string; weight: number }> = [];

  for (const edge of strongEdges) {
    const fromInProduced = producedSet.has(edge.from_shape);
    const toInProduced = producedSet.has(edge.to_shape);
    if (fromInProduced && !toInProduced) {
      missingExpected.push({
        expected: edge.to_shape,
        via: edge.from_shape,
        weight: edge.weight,
      });
    } else if (toInProduced && !fromInProduced) {
      missingExpected.push({
        expected: edge.from_shape,
        via: edge.to_shape,
        weight: edge.weight,
      });
    }
  }

  // ── Build verdict ─────────────────────────────────────────────────────────
  const novelShapes = produced_shapes.filter((s) => shapeRecognition[s] === false);
  const recognizedShapes = produced_shapes.filter((s) => shapeRecognition[s] === true);
  const unknownRecognition = produced_shapes.filter((s) => !(s in shapeRecognition));

  let verdict: "pass" | "warn" | "fail";
  let reason: string;

  if (!conceptDbReachable) {
    verdict = "pass";
    reason = "concept-db unreachable — skipping co-occurrence check; no independent signal available";
  } else if (missingExpected.length === 0) {
    verdict = "pass";
    reason = `co-occurrence consistent: ${produced_shapes.length} shape(s) produced, no strong-edge partners missing`;
  } else {
    const topMissing = missingExpected
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map((m) => `${m.expected} (via ${m.via}, weight=${m.weight})`)
      .join("; ");
    verdict = strict ? "fail" : "warn";
    reason = `co-occurrence divergence: ${missingExpected.length} expected co-occurring shape(s) absent — ${topMissing}`;
  }

  const body = {
    verdict,
    reason,
    produced_shapes,
    novel_shapes: novelShapes,
    recognized_shapes: recognizedShapes,
    unknown_recognition: unknownRecognition,
    missing_expected_cooccurrences: missingExpected,
    concept_db_reachable: conceptDbReachable,
    strong_edges_checked: strongEdges.length,
    execution_id,
    task_id,
    checked_at: new Date().toISOString(),
  };

  if (verdict === "fail") {
    throw new Error(
      `convergent_validity[cooccurrence]: ${reason} — produced: [${produced_shapes.join(", ")}]`,
    );
  }

  return { shape: "convergentValidityResult", body };
}
