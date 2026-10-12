/**
 * ROUTING CAPTURE (closed by the src/judge/ directory entry). A recorder, not a judge: it decides nothing and no gate,
 * verdict, credit or floor reads what it writes.
 *
 * feature_compose's admission decides whether a compose of a store gap may draft (resolveFeatureCompose, the
 * "ADMISSION ON EVERY ROUTE" block). The routing corpus replays that decision from its recorded inputs, so each
 * decision is written once as a `composeAdmission` record of family `routing_input`:
 *   { schema, entry, gap_id, lane, edit_site, falsifier_class, armed, why, supply_exception, scope, scope_reason, decision,
 *     drafting_started } (required), plus the ADDITIVE OPTIONAL fields of the one admission schema (shared with the
 *     admission core's input): stage, land, supply_marker, stored, operator_hold, supply_verdict, localization. A
 *     reader treats an absent optional field as unknown, never as false;
 *   - lane: "directed" | "undirected" (goal-host's directed flag; the scope check differs by lane);
 *   - stage: the refusal stage of a refused decision (ADMISSION_REFUSAL_STAGES), null for an admission;
 *   - stored: the gap store's answer for gap_id (unreadable / absent / present); land: the compose would land;
 *     supply_marker: the pointer carries the check supply's marker; operator_hold: the stored row is held;
 *     supply_verdict: the check supply's ledger verdict { admit, why } when the unarmed exception was evaluated;
 *     localization: the gap's localization record as recorded (written by callers that read one);
 *   - why: the eligibility predicate's skip reason BEFORE any check-supply exception (null = eligible);
 *   - supply_exception: null when no check-supply exception was considered, else { admitted, why }: the supply verdict
 *     ("ledger_match" when admitted, its refusal reason otherwise, or the ledger re-read failure);
 *   - scope: { <path> -> excluded_by | null } for the gap's edit site (and its suspected real location), computed by
 *     the caller's scope port (the lane's own autonomyScopeExcludes over a scope record already in hand), with
 *     scope_reason null; or scope null with scope_reason saying why it was not read. Admission holds no scope record
 *     today and must not fetch one for a recorder (that would add a read to every route), so the call site passes no
 *     port and the record says scope null, scope_reason SCOPE_NOT_CONSULTED: the decision was taken without a scope read.
 *   - edit_site: the stored row's edit site; with no stored row, the caller's gap copy's (pointer) edit site;
 *   - drafting_started: whether this compose was released into the compose pipeline past admission, the spend
 *     envelope, the landing lease and the slot claim (false for a refusal and for an admitted compose stopped at one of
 *     those). It does not say a draft ran: the pipeline's own pre-draft refusals (isolation, grounding, scope) come
 *     later and are not distinguished here.
 *   Recorded set: every refusal from the stored-row read on (the first check-supply ledger read: unreadable or gap
 *   missing; hold_state_unreadable; operator_hold, which applies to non-landing composes too), the four admission-block
 *   returns, and the admitted path. A compose naming no gap, and a non-landing compose past the hold check, record
 *   nothing: no admission decision is taken for them.
 *
 * The record is written as one `[fc-admission] {json}` journal line. It is not written onto the compose's attempt
 * record: that record (retry-evidence.ts AttemptRecord) is built and written only inside the frozen post-assembly
 * region of feature-compose.ts, and only for a failed draft.
 *
 * NO BEHAVIOUR CHANGE: recordComposeAdmission is synchronous and never throws. Any failure (building, serialising or
 * writing) is counted (composeAdmissionCaptureErrors) and logged as a capture_error; the caller's decision is untouched.
 * The line is capped at ROUTING_CAPTURE_MAX_BYTES. No environment reads.
 */
import { gapEditSite } from "./gap-eligibility.js";

export const ROUTING_INPUT_FAMILY = "routing_input";
export const COMPOSE_ADMISSION_SCHEMA = 1;
export const COMPOSE_ADMISSION_ENTRY = "composeAdmission";
export const COMPOSE_ADMISSION_LINE_TAG = "[fc-admission]";
export const ROUTING_CAPTURE_MAX_BYTES = 16 * 1024;
/** The scope_reason of a record whose decision was taken with no scope record in hand (scope is null). */
export const SCOPE_NOT_CONSULTED = "not_consulted_at_admission: admission holds no scope record and a recorder adds no read";

/** Every refusal stage a record can carry (the admission core's stages; scope_excluded is rendered only there). */
export const ADMISSION_REFUSAL_STAGES = ["check_supply_ledger_unreadable", "check_supply_gap_missing", "hold_state_unreadable", "operator_hold", "ineligible", "scope_excluded"] as const;
export type AdmissionRefusalStage = (typeof ADMISSION_REFUSAL_STAGES)[number];
export type ScopePort = ((path: string) => string | null) | null;
export type SupplyException = { admitted: boolean; why: string };
export type ComposeAdmissionRecord = {
  schema: typeof COMPOSE_ADMISSION_SCHEMA;
  entry: typeof COMPOSE_ADMISSION_ENTRY;
  gap_id: string;
  lane: "directed" | "undirected";
  edit_site: string | null;
  falsifier_class: string | null;
  armed: boolean;
  why: string | null;
  supply_exception: SupplyException | null;
  scope: Record<string, string | null> | null;
  scope_reason: string | null;
  decision: "admitted" | "refused";
  drafting_started: boolean;
  // ADDITIVE OPTIONAL (one admission schema).
  stage?: AdmissionRefusalStage | null;
  land?: boolean;
  supply_marker?: boolean;
  stored?: "unreadable" | "absent" | "present";
  operator_hold?: boolean;
  supply_verdict?: { admit: boolean; why: string | null } | null;
  localization?: unknown;
  truncated?: true;
};
export const COMPOSE_ADMISSION_REQUIRED_KEYS = ["schema", "entry", "gap_id", "lane", "edit_site", "falsifier_class", "armed", "why", "supply_exception", "scope", "scope_reason", "decision", "drafting_started"] as const;
export const COMPOSE_ADMISSION_OPTIONAL_KEYS = ["stage", "land", "supply_marker", "stored", "operator_hold", "supply_verdict", "localization", "truncated"] as const;
export type ComposeAdmissionInput = {
  gapId: string;
  lane: "directed" | "undirected";
  /** The STORED gap row admission read (never the caller's copy), or null when there is none (unreadable / absent). */
  row: Record<string, unknown> | null;
  /** The caller's gap copy (pointer.gap): read only for the edit site, and only when there is no stored row. */
  pointerGap?: unknown;
  /** composeEligibilitySkipReason on that row, before any check-supply exception. */
  why: string | null;
  supply: SupplyException | null;
  decision: "admitted" | "refused";
  draftingStarted: boolean;
  scope: ScopePort;
  stage?: AdmissionRefusalStage | null;
  land?: boolean;
  supplyMarker?: boolean;
  stored?: "unreadable" | "absent" | "present";
  operatorHold?: boolean;
  supplyVerdict?: { admit: boolean; why: string | null } | null;
  localization?: unknown;
};

const metaOf = (row: Record<string, unknown> | null | undefined): Record<string, unknown> => {
  const raw = row?.["classification_metadata"] ?? row?.["metadata"];
  return (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
};

/** The falsifier class exactly as composeEligibilitySkipReason reads it (object `.class` or a string, lowercased). */
export function falsifierClassOf(row: Record<string, unknown> | null): string | null {
  const raw = metaOf(row)["falsifier"];
  const c = String((raw && typeof raw === "object" ? (raw as { class?: unknown }).class : raw) ?? "").toLowerCase();
  return c ? c : null;
}

/** The record for one admission decision. Pure. */
export function buildComposeAdmissionRecord(input: ComposeAdmissionInput): ComposeAdmissionRecord {
  const meta = metaOf(input.row);
  const pg = (input.pointerGap && typeof input.pointerGap === "object" ? input.pointerGap : null) as Record<string, unknown> | null;
  const editSite = (input.row ? gapEditSite(input.row, meta) : pg ? gapEditSite(pg, metaOf(pg)) : undefined) ?? null;
  const falsifierClass = falsifierClassOf(input.row);
  const paths: string[] = [];
  if (editSite) paths.push(editSite);
  const suspected = meta["suspected_real_location"];
  if (typeof suspected === "string" && suspected.trim() && !paths.includes(suspected.trim())) paths.push(suspected.trim());
  let scope: Record<string, string | null> | null = null;
  if (input.scope) {
    scope = {};
    for (const p of paths) scope[p] = input.scope(p);
  }
  return {
    schema: COMPOSE_ADMISSION_SCHEMA,
    entry: COMPOSE_ADMISSION_ENTRY,
    gap_id: input.gapId,
    lane: input.lane,
    edit_site: editSite,
    falsifier_class: falsifierClass,
    armed: falsifierClass === "class1" || falsifierClass === "class2",
    why: input.why,
    supply_exception: input.supply,
    scope,
    scope_reason: scope ? null : SCOPE_NOT_CONSULTED,
    decision: input.decision,
    drafting_started: input.draftingStarted,
    ...(input.stage !== undefined ? { stage: input.stage } : {}),
    ...(input.land !== undefined ? { land: input.land } : {}),
    ...(input.supplyMarker !== undefined ? { supply_marker: input.supplyMarker } : {}),
    ...(input.stored !== undefined ? { stored: input.stored } : {}),
    ...(input.operatorHold !== undefined ? { operator_hold: input.operatorHold } : {}),
    ...(input.supplyVerdict !== undefined ? { supply_verdict: input.supplyVerdict } : {}),
    ...(input.localization !== undefined ? { localization: input.localization } : {}),
  };
}

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
const clip = (v: string | null, n: number): string | null => (v === null || v.length <= n ? v : v.slice(0, n) + "…");

/** The journal line for a record, at most ROUTING_CAPTURE_MAX_BYTES. An oversized record keeps every key (a recorded
 *  localization becomes null); its free strings are clipped, then scope entries are dropped from the end, and it is marked truncated. */
export function composeAdmissionLine(rec: ComposeAdmissionRecord): string {
  const line = (r: ComposeAdmissionRecord): string => `${COMPOSE_ADMISSION_LINE_TAG} ${JSON.stringify(r)}`;
  let out = line(rec);
  if (bytes(out) <= ROUTING_CAPTURE_MAX_BYTES) return out;
  const n = 512;
  let scope: Record<string, string | null> | null = null;
  if (rec.scope) {
    scope = {};
    for (const [k, v] of Object.entries(rec.scope)) scope[clip(k, n)!] = clip(v, n);
  }
  const small: ComposeAdmissionRecord = {
    ...rec,
    gap_id: clip(rec.gap_id, n)!,
    edit_site: clip(rec.edit_site, n),
    falsifier_class: clip(rec.falsifier_class, 64),
    why: clip(rec.why, n),
    supply_exception: rec.supply_exception ? { admitted: rec.supply_exception.admitted, why: clip(rec.supply_exception.why, n)! } : null,
    scope,
    scope_reason: clip(rec.scope_reason, n),
    ...(rec.supply_verdict ? { supply_verdict: { admit: rec.supply_verdict.admit, why: clip(rec.supply_verdict.why, n) } } : {}),
    ...(rec.localization !== undefined ? { localization: null } : {}),
    truncated: true,
  };
  out = line(small);
  while (bytes(out) > ROUTING_CAPTURE_MAX_BYTES && small.scope && Object.keys(small.scope).length > 0) {
    const keys = Object.keys(small.scope);
    delete small.scope[keys[keys.length - 1]!];
    out = line(small);
  }
  return out;
}

let captureErrors = 0;
/** How many admission captures failed since process start (each one left the decision unchanged). */
export function composeAdmissionCaptureErrors(): number { return captureErrors; }

const defaultSink = (line: string): void => { console.log(line); };
let sink: (line: string) => void = defaultSink;
/** Test seam: replace the line writer (null restores the journal). */
export function __setComposeAdmissionSinkForTests(fn: ((line: string) => void) | null): void { sink = fn ?? defaultSink; }
/** Test seam: zero the capture_error counter. */
export function __resetComposeAdmissionCaptureErrorsForTests(): void { captureErrors = 0; }

/** Record one admission decision. Synchronous; never throws; a failure is a counted capture_error. */
export function recordComposeAdmission(input: ComposeAdmissionInput): void {
  try {
    sink(composeAdmissionLine(buildComposeAdmissionRecord(input)));
  } catch (err) {
    captureErrors++;
    try {
      console.warn(`${COMPOSE_ADMISSION_LINE_TAG} capture_error n=${captureErrors} gap=${String(input?.gapId ?? "?").slice(0, 200)}: ${String((err as Error)?.message ?? err).slice(0, 300)} (admission unchanged)`);
    } catch { /* the capture must never change admission */ }
  }
}
