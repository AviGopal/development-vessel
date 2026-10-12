// THE COMPOSE ADMISSION CORE (closed): the decision whether a feature_compose that names a gap may start drafting.
//
// feature-compose.ts gathers the evidence (the stored gap row, its operator hold, the eligibility predicate, the check
// supply's ledger verdict, the edit site) and hands it here as one record in the ONE admission schema (the capture's
// composeAdmission keys, src/judge/routing-capture.ts, with this decision's fields required). This
// module:
//   - applies the FLOOR: today's admission, verbatim (store unreadable, check-supply gap missing, operator hold,
//     ineligible unless the check supply's ledger admits it). The floor is closed; nothing open can loosen it;
//   - asks the open rules (src/judge-rules/routing-admission.ts admitCompose) and clamps their answer. The rules may
//     only ADD a refusal the floor did not make, and only one this module can render from the input (scope_excluded,
//     naming an entry the recorded scope port returned). Anything else is refused by the clamp and the floor stands;
//   - renders every refusal's log line and report body from its stage, so an open rule cannot write text.
// The routing corpus (test/routing-corpus/) replays composeAdmission records through composeAdmission() here, the same
// function production calls.
import { admitCompose } from "../judge-rules/routing-admission.js";

export const COMPOSE_ADMISSION_SCHEMA = 1;

/** Every refusal stage the core can render. A new stage is a closed change. */
export const ADMISSION_STAGES = ["check_supply_ledger_unreadable", "check_supply_gap_missing", "hold_state_unreadable", "operator_hold", "ineligible", "scope_excluded"] as const;
export type AdmissionStage = (typeof ADMISSION_STAGES)[number];

export type ComposeAdmissionInput = {
  schema: 1;
  entry: "composeAdmission";
  gap_id: string;
  lane: "directed" | "undirected";
  /** pointer.land !== false: the compose would land. */
  land: boolean;
  /** The pointer carries the check supply's structured marker. */
  supply_marker: boolean;
  /** The gap store's answer for gap_id: unreadable (failed/timed out), absent (no row), present. */
  stored: "unreadable" | "absent" | "present";
  /** The stored row is under operator_hold. */
  operator_hold: boolean;
  /** composeEligibilitySkipReason on the stored row (after any check-supply re-read), when it was asked; else null. */
  why: string | null;
  /** The check supply's ledger verdict, when the unarmed exception was evaluated; else null. */
  supply_verdict: { admit: boolean; why: string | null } | null;
  /** The compose's edit site (the stored row's, else the pointer's), when one is named. */
  edit_site: string | null;
  /**
   * The autonomy scope port for the edit site: {path -> excluding entry | null} (an unreadable or absent scope record
   * excludes every path, naming why), or null when it was not read, with scope_reason saying why.
   */
  scope: Record<string, string | null> | null;
  scope_reason: string | null;
  // The rest of the one admission schema (src/judge/routing-capture.ts composeAdmission): informational here, never read
  // by the floor or the rules.
  falsifier_class?: string | null;
  armed?: boolean;
  supply_exception?: { admitted: boolean; why: string } | null;
  /**
   * The gap's localizationRecord (gap.localization, shape `localizationRecord`; schema
   * test/routing-corpus/localization-record.schema.json), as recorded. Additive: a record without the field reads null,
   * and the core hands the rules a record only when validLocalizationRecord passes.
   */
  localization?: unknown;
};

/**
 * A shaped admission event the core emits beside its decision. `excludedSiteCompose`: a DIRECTED compose (exempt from
 * the autonomous scope refusal) admitted on an edit site the scope excludes. Never silent: the core logs it and
 * traces it. Version 1 emits none (the scope is not read at admission yet).
 */
export type AdmissionEvent = { shape: "excludedSiteCompose"; gap_id: string; lane: "directed"; edit_site: string; excluded_by: string };

const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const LOC_KEYS = new Set(["gap_id", "dispatch_id", "file", "evidence", "method", "created_at"]);
/** The localizationRecord run-time check (the same rule as goal-host's src/routing-core/localization.ts). */
export function validLocalizationRecord(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (Object.keys(r).some((k) => !LOC_KEYS.has(k))) return false;
  if (!str(r.gap_id) && !str(r.dispatch_id)) return false;
  if (r.gap_id !== undefined && !str(r.gap_id)) return false;
  if (r.dispatch_id !== undefined && !str(r.dispatch_id)) return false;
  if (!str(r.file) || !/^repos\/[\w.-]+\/[\w.\/-]+\.\w+$/.test(r.file)) return false;
  if (!str(r.method) || !str(r.created_at) || Number.isNaN(Date.parse(r.created_at))) return false;
  if (!Array.isArray(r.evidence) || r.evidence.length === 0) return false;
  return r.evidence.every((e) => !!e && typeof e === "object" && !Array.isArray(e) && Object.keys(e).every((k) => k === "read" || k === "why") && str((e as { read?: unknown }).read) && str((e as { why?: unknown }).why));
}

export type AdmissionRefusal = { stage: AdmissionStage; verdict: "REFUSED" | "BUSY"; excluded_by: string | null };
export type AdmissionDecision = { admit: boolean; refusal: AdmissionRefusal | null };

const refuse = (stage: AdmissionStage, verdict: "REFUSED" | "BUSY", excluded_by: string | null = null): AdmissionDecision => ({ admit: false, refusal: { stage, verdict, excluded_by } });

/** THE FLOOR: today's admission block, verbatim. */
export function floorAdmission(i: ComposeAdmissionInput): AdmissionDecision {
  if (i.stored === "unreadable") return i.supply_marker ? refuse("check_supply_ledger_unreadable", "REFUSED") : refuse("hold_state_unreadable", "BUSY");
  if (i.stored === "absent" && i.supply_marker) return refuse("check_supply_gap_missing", "REFUSED");
  if (i.stored === "present" && i.operator_hold) return refuse("operator_hold", "BUSY");
  if (i.stored === "present" && i.land) {
    if (i.supply_verdict) return i.supply_verdict.admit ? { admit: true, refusal: null } : refuse("ineligible", "REFUSED");
    if (i.why) return refuse("ineligible", "REFUSED");
  }
  return { admit: true, refusal: null };
}

/** Fall-backs to the floor since process start (the open rules answered out of schema). */
export const admissionFellBack = { count: 0 };

const keysAre = (o: unknown, keys: readonly string[]): o is Record<string, unknown> =>
  !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));

/**
 * The clamp on the rules' answer, given the floor admitted. Admit is always acceptable; a refusal is acceptable only
 * as scope_excluded (REFUSED) naming an entry the input's scope port returned for one of its paths.
 */
export function clampAdmission(i: ComposeAdmissionInput, out: unknown): AdmissionDecision | null {
  if (!keysAre(out, ["admit", "refusal"]) || typeof out.admit !== "boolean") return null;
  if (out.admit) return out.refusal === null ? { admit: true, refusal: null } : null;
  const r = out.refusal;
  if (!keysAre(r, ["stage", "verdict", "excluded_by"])) return null;
  if (r.stage !== "scope_excluded" || r.verdict !== "REFUSED" || typeof r.excluded_by !== "string") return null;
  const offered = Object.values(i.scope ?? {}).filter((e): e is string => typeof e === "string");
  if (!offered.includes(r.excluded_by)) return null;
  return refuse("scope_excluded", "REFUSED", r.excluded_by);
}

/** THE ENTRY (composeAdmission): the floor, then the clamped rules. production and the corpus both call this. */
export function composeAdmission(raw: ComposeAdmissionInput): AdmissionDecision & { fell_back: boolean; events: AdmissionEvent[] } {
  const i: ComposeAdmissionInput = { ...raw, localization: validLocalizationRecord(raw.localization) ? raw.localization : null };
  const events: AdmissionEvent[] = [];
  const floor = floorAdmission(i);
  if (!floor.admit) return { ...floor, fell_back: false, events };
  let out: unknown;
  try { out = admitCompose(i); } catch { out = undefined; }
  const ok = clampAdmission(i, out);
  if (ok) return { ...ok, fell_back: false, events };
  admissionFellBack.count++;
  console.warn(`[fc-admission] rules answer refused by the clamp — the floor stands (fell_back=${admissionFellBack.count})`);
  return { ...floor, fell_back: true, events };
}

/** The log line and featureComposeReport body for a refusal: exactly today's text for every floor stage. */
export function renderAdmissionRefusal(i: ComposeAdmissionInput, r: AdmissionRefusal): { log: string; body: Record<string, unknown> } {
  const g = i.gap_id;
  const lane = i.lane;
  const pre = `[feature-compose] ${lane} compose NOT started: gap ${g}`;
  switch (r.stage) {
    case "check_supply_ledger_unreadable":
      return { log: `${pre} check_supply_ledger_unreadable (gap store unreadable or timed out; failing closed)`, body: { ok: false, verdict: "REFUSED", stage: "check_supply_ledger_unreadable", error: `gap ${g}: its check_supply ledger could not be read, so the supply's dispatch cannot be verified (${lane} compose not started)` } };
    case "check_supply_gap_missing":
      return { log: `${pre} check_supply_gap_missing (a check_supply compose names a gap the store does not hold)`, body: { ok: false, verdict: "REFUSED", stage: "check_supply_gap_missing", error: `gap ${g}: a check_supply compose names a gap the store does not hold (${lane} compose not started)` } };
    case "hold_state_unreadable":
      return { log: `${pre} hold_state_unreadable (gap store unreadable; failing closed)`, body: { ok: false, verdict: "BUSY", stage: "hold_state_unreadable", error: `gap ${g}: the gap store could not be read, so its operator_hold state is unknown (${lane} compose not started)` } };
    case "operator_hold":
      return { log: `${pre} is under operator_hold`, body: { ok: false, verdict: "BUSY", stage: "operator_hold", error: `gap ${g} is under operator_hold (${lane} compose not started)` } };
    case "ineligible":
      if (i.supply_verdict && !i.supply_verdict.admit) {
        const why = i.why ?? "check_supply_state_changed";
        return { log: `${pre} is ineligible (${why}; check_supply ${i.supply_verdict.why})`, body: { ok: false, verdict: "REFUSED", stage: "ineligible", check_supply_refusal: i.supply_verdict.why, error: `gap ${g} is not compose work: ${why} (${lane} compose not started)` } };
      }
      return { log: `${pre} is ineligible (${i.why})`, body: { ok: false, verdict: "REFUSED", stage: "ineligible", error: `gap ${g} is not compose work: ${i.why} (${lane} compose not started)` } };
    case "scope_excluded":
      return { log: `${pre} scope_excluded (edit site ${i.edit_site ?? "(none)"} is excluded by ${r.excluded_by})`, body: { ok: false, verdict: "REFUSED", stage: "scope_excluded", excluded_by: r.excluded_by, error: `gap ${g}: its edit site ${i.edit_site ?? "(none)"} is excluded from autonomous work by scope entry ${r.excluded_by} (${lane} compose not started)` } };
  }
}
