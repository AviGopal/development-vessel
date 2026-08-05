import type { ResolverResult } from "./types.js";

/**
 * Resolver for the `resolver_schema` shape — this vessel's answer to "what pointer args does
 * shape X need, and in what structure?".
 *
 * WHY THIS EXISTS
 * goal-host's `llmExtractPointerArgs` already asks the OWNING vessel for a payload contract
 * before it synthesizes pointer args (`pointer:{type:"resolver_schema", shape}`), and builds an
 * AUTHORITATIVE PAYLOAD CONTRACT block from the answer. concept-db answers it. This vessel —
 * which owns the large majority of the fleet's write shapes — did not, so every shape it owns
 * reached synthesis with no contract at all. The documented fallback is a concept-db how-to
 * lookup, and that wire is severed, so in practice the walk was synthesizing write payloads from
 * the goal text alone.
 *
 * Measured 2026-08-05: the goal "File a substrate gap with id ladder-rung-9-probe recording …"
 * failed on FOUR separate minted arms in one dispatch, every one with
 * `structuredError missing_required_field`. The arms are not the defect — they carry
 * `config:{type:"substrateGap_write"}` and `inputShapes:[]`, i.e. no gap data whatsoever, because
 * nothing told the synthesizer that `substrateGap_write` takes its fields under a `gap` envelope.
 * The walk then confabulated a CLI `substrate gap write` (exit 127). This is an
 * information-availability failure, not a capability failure: the contract exists in the
 * resolver, it was simply not readable at the moment of use.
 *
 * Serving it here is the general fix rather than a per-shape one — one resolver, parameterized by
 * the `shape` threaded into the impulse, covering every shape in the map. Adding a shape to
 * CONTRACTS makes it synthesizable by every activity that routes to it, with no new arm minted.
 *
 * INVARIANT (enforced by test/resolvers/resolver-schema.test.ts): a payload built from a
 * contract's own `required` list must be ACCEPTED by that shape's resolver. A contract that
 * drifts from the resolver it describes is worse than none — it would send every caller
 * confidently to the wrong structure.
 */

export interface ResolverSchemaResult {
  shape: string;
  known: boolean;
  /** Key the args nest under, e.g. "gap". Absent/empty ⇒ the resolver takes a FLAT pointer. */
  envelope?: string;
  fields?: Array<{ name: string; required: boolean; type: string }>;
  required?: string[];
  invocation?: string;
}

interface Contract {
  /** Omit for shapes whose resolver reads a flat pointer. */
  envelope?: string;
  fields: Array<{ name: string; required: boolean; type: string }>;
  /** Notes the synthesizer benefits from that a field list cannot express. */
  notes?: string;
}

const CONTRACTS: Record<string, Contract> = {
  // The shape whose absence was measured. resolveSubstrateGapWrite reads pointer.gap; the
  // description gate additionally rejects an empty summary or an uninterpolated {{placeholder}},
  // so `summary` must be real prose bound from the goal, not a template slot.
  substrateGap_write: {
    envelope: "gap",
    fields: [
      { name: "id", required: true, type: "string" },
      { name: "category", required: true, type: "string" },
      { name: "source", required: true, type: "string" },
      { name: "status", required: true, type: "string" },
      { name: "detected_at", required: true, type: "string" },
      { name: "summary", required: true, type: "string" },
      { name: "route", required: false, type: "string" },
      { name: "remedy", required: false, type: "object" },
      { name: "classification_metadata", required: false, type: "object" },
    ],
    notes:
      'id is a stable kebab-case slug; status is one of open|closed|rejected; detected_at is an ISO-8601 timestamp; summary must be real prose describing the gap (an empty summary or an uninterpolated {{placeholder}} is rejected).',
  },
  // Tolerant by construction: reads a `note` envelope OR a flat pointer, and aliases content→body.
  // Declared anyway so the synthesizer emits the fields rather than inferring them, and so the
  // conformance test pins the tolerance instead of leaving it to be rediscovered.
  memoryNote_write: {
    fields: [
      { name: "title", required: true, type: "string" },
      { name: "body", required: true, type: "string" },
      { name: "note_type", required: false, type: "string" },
      { name: "id", required: false, type: "string" },
    ],
    notes: "Flat pointer. `content` is accepted as an alias for `body`. title or body suffices.",
  },
  // Post-landing suite verification. Flat pointer; `vessel` is the only hard requirement.
  test_suite: {
    fields: [
      { name: "vessel", required: true, type: "string" },
      { name: "landed_sha", required: false, type: "string" },
      { name: "gap_id", required: false, type: "string" },
      { name: "proposal_id", required: false, type: "string" },
      { name: "timeout_ms", required: false, type: "number" },
    ],
    notes:
      'vessel is "repos/<vessel>" or a bare vessel name. landed_sha is the commit the outcome attributes to — supply it whenever the run follows a landing, or the report is an unattributable snapshot.',
  },
};

/** The shapes this vessel publishes a contract for. Exported for the conformance test. */
export const CONTRACT_SHAPES = Object.keys(CONTRACTS);

export function resolveResolverSchema(pointer: Record<string, unknown>): ResolverResult {
  const shape = typeof pointer.shape === "string" ? pointer.shape : "";
  if (!shape) {
    return {
      shape: "structuredError",
      body: { resolver: "resolver_schema", error: "missing_required_field", field: "shape", message: "resolver_schema requires a 'shape' to describe" },
    };
  }
  const c = CONTRACTS[shape];
  // known:false is a real answer, not a failure — it tells the synthesizer to fall back to
  // goal-text extraction rather than trust a contract that does not exist.
  if (!c) return { shape: "resolver_schema", body: { shape, known: false } };

  const required = c.fields.filter((f) => f.required).map((f) => f.name);
  const result: ResolverSchemaResult = {
    shape,
    known: true,
    ...(c.envelope ? { envelope: c.envelope } : {}),
    fields: c.fields,
    required,
    invocation: c.envelope
      ? `pointer:{type:"${shape}", ${c.envelope}:{${required.join(", ")}}}`
      : `pointer:{type:"${shape}", ${required.join(", ")}}`,
    ...(c.notes ? { notes: c.notes } : {}),
  } as ResolverSchemaResult;
  return { shape: "resolver_schema", body: result as unknown as Record<string, unknown> };
}
