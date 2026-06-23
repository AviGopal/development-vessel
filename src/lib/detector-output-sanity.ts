/**
 * Nth-order detector self-check (value sanity).
 *
 * `detector-meta-scan` watches whether detectors RUN (dormancy). It cannot see
 * a detector's emitted numbers, so it never catches a detector whose VALUES are
 * insane (e.g. a coverage "fraction" of 1.65, a `*_passing` flag set true over a
 * dimension that was never measured, a NaN ratio). Those make the substrate
 * believe false things about itself - and some feed the lift gate.
 *
 * This module runs on EVERY resolver output the moment it is produced (wrapped
 * around resolveDispatch), validates the body against generic, conservative
 * invariants, and - on violation - logs and best-effort emits a
 * substrateGap_write meta-gap. No re-resolution, covers all detectors, cheap.
 *
 * Invariants are deliberately conservative to avoid false-positive gap spam:
 *   - any `*_fraction` numeric must be in [0,1]
 *   - any `*_ratio` numeric must be >= 0 (ratios may legitimately exceed 1)
 *   - any numeric must be finite (no NaN / Infinity)
 *   - any `<x>_passing === true` while a sibling `<x>_measured === false`
 *     (a passing verdict over an explicitly-unmeasured dimension)
 */

const DEV_VESSEL_URL =
  process.env["DEV_VESSEL_IMPULSES_URL"] ?? "http://127.0.0.1:8090/v2/impulses/resolve";
const API_KEY = process.env["METABOB_API_KEY"] ?? "";

export interface SanityViolation {
  path: string;
  kind: string;
  value: unknown;
  detail: string;
}

// Shapes that are themselves gap / error / passthrough emissions - auditing them
// would be pointless and (for gap writes) risks a meta-gap feedback loop.
const SKIP_SHAPE_RE = /gap|error|memo|ack|passthrough|noop/i;

export function checkValueSanity(body: unknown, maxDepth = 6): SanityViolation[] {
  const out: SanityViolation[] = [];
  const visit = (val: unknown, path: string, depth: number) => {
    if (depth > maxDepth || val === null || val === undefined) return;
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length && i < 200; i++) visit(val[i], `${path}[${i}]`, depth + 1);
      return;
    }
    if (typeof val === "object") {
      const obj = val as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        const here = `${path}.${k}`;
        if (k.endsWith("_passing") && v === true) {
          const base = k.slice(0, -"_passing".length);
          if (obj[`${base}_measured`] === false) {
            out.push({ path: here, kind: "passing_while_unmeasured", value: v, detail: `${k}=true but ${base}_measured=false` });
          }
        }
        if (typeof v === "number") {
          if (!Number.isFinite(v)) {
            out.push({ path: here, kind: "non_finite", value: v, detail: `${k} is ${String(v)}` });
          } else if (k.endsWith("_fraction") && (v < -1e-6 || v > 1 + 1e-6)) {
            out.push({ path: here, kind: "fraction_out_of_range", value: v, detail: `${k}=${v} not in [0,1]` });
          } else if (k.endsWith("_ratio") && v < -1e-6) {
            out.push({ path: here, kind: "negative_ratio", value: v, detail: `${k}=${v} < 0` });
          }
        }
        visit(v, here, depth + 1);
      }
    }
  };
  visit(body, "body", 0);
  return out;
}

/** Categories that are high-value stale and should be aggressively audited */
const UNACTIONABLE_AUTO_DRAFT_SUBTYPES = new Set([
  'auto_draft_fallback_recommend',
  'auto_draft_triggered',
]);

export interface GapEmission {
  gap_id?: string;
  category?: string;
  gap_subtype?: string;
  context?: unknown;
  [key: string]: unknown;
}

export interface GapAuditFinding {
  audit_type: string;
  reason: string;
  gap_id?: string;
  category?: string;
  gap_subtype?: string;
  rejected_at: string;
}

export interface ValidationResult {
  valid: boolean;
  findings: GapAuditFinding[];
}

/**
 * Additional sanity gate: reject emissions that are structurally un-actionable.
 * Returns a GapAuditFinding if the emission should be rejected, or null if it passes.
 */
export function auditGapEmissionActionability(
  gap: GapEmission
): GapAuditFinding | null {
  // (1) auto_draft_fallback_recommend gaps without sufficient context
  if (
    UNACTIONABLE_AUTO_DRAFT_SUBTYPES.has(gap.gap_subtype ?? gap.category ?? '')
  ) {
    const hasContext =
      gap.context != null &&
      typeof gap.context === 'object' &&
      Object.keys(gap.context).length > 0 &&
      (gap.context as Record<string, unknown>)['resolver'] != null;
    if (!hasContext) {
      return {
        audit_type: 'unactionable_emission_rejected',
        reason: `gap_subtype '${gap.gap_subtype ?? gap.category}' lacks sufficient context for action (missing resolver or empty context)`,
        gap_id: gap.gap_id,
        category: gap.category,
        gap_subtype: gap.gap_subtype,
        rejected_at: new Date().toISOString(),
      };
    }
  }

  // (2) novel_failure_mode_detected gaps without reproducibility evidence
  if (
    (gap.gap_subtype ?? gap.category ?? '') === 'novel_failure_mode_detected'
  ) {
    const hasReproEvidence =
      gap.context != null &&
      typeof gap.context === 'object' &&
      (
        (gap.context as Record<string, unknown>)['reproducibility'] != null ||
        (gap.context as Record<string, unknown>)['occurrences'] != null
      );
    if (!hasReproEvidence) {
      return {
        audit_type: 'unactionable_emission_rejected',
        reason: `novel_failure_mode_detected gap lacks reproducibility evidence (missing 'reproducibility' or 'occurrences' in context)`,
        gap_id: gap.gap_id,
        category: gap.category,
        gap_subtype: gap.gap_subtype,
        rejected_at: new Date().toISOString(),
      };
    }
  }

  // (3) activity_lifecycle gaps missing state transitions
  if ((gap.gap_subtype ?? gap.category ?? '') === 'activity_lifecycle') {
    const hasStateTransition =
      gap.context != null &&
      typeof gap.context === 'object' &&
      (
        (gap.context as Record<string, unknown>)['from_state'] != null ||
        (gap.context as Record<string, unknown>)['to_state'] != null ||
        (gap.context as Record<string, unknown>)['state_transition'] != null
      );
    if (!hasStateTransition) {
      return {
        audit_type: 'unactionable_emission_rejected',
        reason: `activity_lifecycle gap missing state transition (need from_state/to_state or state_transition in context)`,
        gap_id: gap.gap_id,
        category: gap.category,
        gap_subtype: gap.gap_subtype,
        rejected_at: new Date().toISOString(),
      };
    }
  }

  return null;
}

export function validateGapEmission(gap: GapEmission): ValidationResult {
  // Run actionability audit and reject un-actionable gaps
  const auditFinding = auditGapEmissionActionability(gap);
  if (auditFinding != null) {
    return {
      valid: false,
      findings: [
        {
          type: 'unactionable_emission',
          message: auditFinding.reason,
          audit_finding: auditFinding,
        } as unknown as GapAuditFinding,
      ],
    };
  }

  return { valid: true, findings: [] };
}

export async function auditDetectorOutputSanity(result: { shape?: string; body?: unknown }): Promise<void> {
  const shape = String(result?.shape ?? "");
  if (!shape || SKIP_SHAPE_RE.test(shape)) return;
  const violations = checkValueSanity(result?.body);
  if (violations.length === 0) return;

  console.warn(
    `[detector-sanity] shape '${shape}' produced ${violations.length} value-invariant violation(s): ` +
      JSON.stringify(violations.slice(0, 5)),
  );

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (API_KEY) headers["Authorization"] = `ApiKey ${API_KEY}`;
    await fetch(DEV_VESSEL_URL, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        impulse: {
          pointer: {
            type: "substrateGap_write",
            gap: {
              id: `detector-value-sanity-${shape}-${violations[0]!.kind}`,
              category: "detector_value_sanity_violation",
              source: "substrate_detected",
              summary:
                `Detector output shape '${shape}' violated ${violations.length} value invariant(s): ` +
                `${violations.slice(0, 3).map((v) => v.detail).join("; ")}. ` +
                `The detector's numbers do not match reality (e.g. a fraction outside [0,1] or a ` +
                `passing flag over an unmeasured dimension) - its verdict cannot be trusted, ` +
                `including by the lift gate.`,
              detected_at: new Date().toISOString(),
              status: "open",
              classification_metadata: {
                detector: "detector_output_sanity",
                emitting_shape: shape,
                violations: violations.slice(0, 10),
                cite_principle: "detectors_must_match_reality",
              },
            },
          },
        },
      }),
    });
  } catch {
    /* swallow - the Nth-order check must never throw into the dispatch path */
  }
}
