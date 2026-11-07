/**
 * A GAP'S LOCALIZATION IS A GRADED, PERSISTED DECISION (development-vessel:gap-localization).
 *
 * localizeGap (gap-to-feature.ts) derives a concrete edit site for a gap with none: the metadata's named site, the own
 * check's call path, a unique or dominant grep hit, or an LLM rank; null when nothing is confident. Three callers use
 * it: decomposeGap (a parent with no site; null parks it "needs_information: no readable edit site"), the compose pick
 * (the result becomes that compose's edit target, and only a `localized` flag is written), and the check supply's I1
 * (gap-check-supply.ts localizeForSupply, which already persists the site and the shaped localization record). None
 * traced the decision, so which method sited a row, and which method failed on a parked one, was never measured.
 *   - variant-0 (the control): every caller does exactly what it did; one decision line per call.
 *   - variant-1: decomposeGap and the compose pick persist a non-null result for a row that had no edit_site, in the
 *     check supply's own form (classification_metadata edit_site, localized_by, localization_method, and the
 *     gap.localization record), unless the live autonomy scope is unreadable or excludes the site, or the row's region
 *     is not literal once in it (the write seam's arm-region rule). The check supply keeps its own write. Every
 *     variant-1 decision that localized nothing or sited a row posts a trace (output gapLocalization).
 * A sited decision is graded by its CONSUMER, the gap's next localizeGap read: localizeGap reads the metadata edit site
 * first, so the next read returning the same file as metadata_edit_site -> reached (the persisted site was what the
 * next attempt used); a different file (a relocation hint or the semantic gate's suspected_real_location won) or
 * none -> not reached; no read within 48 h -> ungraded, logged. Variant-0 posts no trace.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VOLUME_ROOT } from "../config.js";
import { autonomyScope, autonomyScopeExcludes, type AutonomyScope } from "../judge/gap-policy.js";
import { regionLiteralVerdict, regionOf } from "../lib/region-literal.js";
import { resolvePoolImpulse } from "./pool-impulse.js";
import { postConsumerTrace, resolveSubstrateGapWrite } from "./substrate-gap.js";

export const GAP_LOCALIZATION_ACTIVITY = "development-vessel:gap-localization";
export const GAP_LOCALIZATION_CREDIT_ACTIVITY = "development-vessel:gap-localization-credit";
export const gapLocalizationVariantId = (variant: number): string => (variant === 0 ? GAP_LOCALIZATION_ACTIVITY : `${GAP_LOCALIZATION_ACTIVITY}-v${variant}`);
const GL_LOG = `[${GAP_LOCALIZATION_ACTIVITY}]`;
const GL_CREDIT_WINDOW_MS = 48 * 3_600_000;

type Row = Record<string, unknown>;
type MaskRow = { id?: string; body?: unknown };
/** The caller that ran the localizer: decomposeGap, the compose pick, or the check supply's I1 (which persists itself). */
export type LocalizationCaller = "decompose" | "compose_pick" | "check_supply";
/** What a localizer answered (gap-to-feature LocalizeResult, or the check supply's own summary-named site). */
export type LocalizationAnswer = { file: string; method: string; description?: string; candidates?: number };
export type GapLocalizationDeps = {
  readMasks?: () => MaskRow[];
  postTrace?: (t: Record<string, unknown>) => Promise<number | null>;
  write?: (w: Record<string, unknown>) => Promise<{ shape: string; body?: unknown }>;
  scope?: () => Promise<AutonomyScope>;
  regionVerdict?: (region: string, editSite: string) => { ok: boolean };
  nowMs?: () => number;
  /** The pending decisions, in place of VOLUME_ROOT/gap-localization.json. */
  stateFile?: string;
};
let deps: GapLocalizationDeps = {};
let seq = 0;
/** Tests only: the seams the decision and its credit use. null restores the real ones. */
export function __setGapLocalizationDepsForTests(d: GapLocalizationDeps | null): void { deps = d ?? {}; }
const nowMs = (): number => deps.nowMs?.() ?? Date.now();
const post = (t: Record<string, unknown>, what: string): void => {
  void (deps.postTrace ?? ((x: Record<string, unknown>) => postConsumerTrace(x, "gap-localization")))(t)
    .then((st) => { if (st === null || st < 200 || st >= 300) console.warn(`${GL_LOG} ${what} not posted (http=${st ?? "none"})`); })
    .catch((err) => console.warn(`${GL_LOG} ${what} not posted: ${String((err as Error)?.message ?? err).slice(0, 160)}`));
};

/** Which variant runs: the first open activityVariantMask row for the activity whose [from, until) holds now.
 *  No row in force, an unknown variant or an unreadable pool: variant-0. Never throws. */
export function gapLocalizationVariant(nowIso: string): { variant: number; why: string } {
  let rows: MaskRow[];
  try {
    rows = (deps.readMasks ?? (() => resolvePoolImpulse({ type: "poolImpulse", shape: "activityVariantMask", status: "open" }).body.impulses as MaskRow[]))();
  } catch (err) {
    return { variant: 0, why: `mask_unread (${String((err as Error)?.message ?? err).slice(0, 160)}): variant-0` };
  }
  const now = Date.parse(nowIso);
  for (const r of rows) {
    const b = (r?.body ?? {}) as Record<string, unknown>;
    if (b["activity_id"] !== GAP_LOCALIZATION_ACTIVITY) continue;
    const from = Date.parse(String(b["from"] ?? "")), until = Date.parse(String(b["until"] ?? ""));
    if (!Number.isFinite(from) || !Number.isFinite(until) || now < from || now >= until) continue;
    const v = b["active_variant"];
    if (v !== 0 && v !== 1) return { variant: 0, why: `mask ${String(r.id)} names unknown variant ${JSON.stringify(v)}: variant-0` };
    return { variant: v, why: `mask ${String(r.id)} [${String(b["from"])}, ${String(b["until"])}) by ${String(b["by"])}: ${String(b["reason"])}` };
  }
  return { variant: 0, why: "no mask in force: variant-0" };
}

type Pending = { traceId: string; gapId: string; file: string; method: string; caller: LocalizationCaller; variant: number; decidedAtMs: number };
const stateFile = (): string => deps.stateFile ?? join(VOLUME_ROOT, "gap-localization.json");
function load(): Pending[] {
  try {
    const j = JSON.parse(readFileSync(stateFile(), "utf8")) as { pending?: unknown };
    return Array.isArray(j.pending) ? j.pending.filter((p): p is Pending => !!p && typeof (p as Pending).traceId === "string" && typeof (p as Pending).gapId === "string" && Number.isFinite((p as Pending).decidedAtMs)) : [];
  } catch { return []; }
}
function save(pending: Pending[]): void {
  try {
    const file = stateFile();
    writeFileSync(`${file}.tmp`, JSON.stringify({ pending }));
    renameSync(`${file}.tmp`, file);
  } catch (err) { console.warn(`${GL_LOG} state not saved: ${String((err as Error)?.message ?? err).slice(0, 160)}`); }
}
function expire(pending: Pending[], now: number): Pending[] {
  return pending.filter((p) => {
    if (now - p.decidedAtMs < GL_CREDIT_WINDOW_MS) return true;
    console.log(`${GL_LOG} ungraded ${p.traceId}: no localizer read of gap ${p.gapId} within 48 h`);
    return false;
  });
}

/** The gap's next localizer read settles its pending decisions (the consumer). */
function settle(gapId: string, answer: LocalizationAnswer | null, now: number): void {
  const all = load();
  const kept = expire(all, now);
  const mine = kept.filter((p) => p.gapId === gapId);
  if (mine.length === 0) { if (kept.length !== all.length) save(kept); return; }
  save(kept.filter((p) => p.gapId !== gapId));
  for (const p of mine) {
    const reached = answer !== null && answer.method === "metadata_edit_site" && answer.file === p.file;
    const impulse = `gapLocalization:${p.traceId}`;
    post({
      execution_id: p.traceId.replace(/^gap-localization-/, "gap-localization-credit-"),
      template_id: GAP_LOCALIZATION_CREDIT_ACTIVITY, activity_id: GAP_LOCALIZATION_CREDIT_ACTIVITY, activity_variant_id: GAP_LOCALIZATION_CREDIT_ACTIVITY,
      status: reached ? "completed" : "failed", success: reached,
      ...(reached ? {} : { failure_mode: { type: "verifier_negative", reason: answer ? `the next read sited ${answer.file} (${answer.method}), not the persisted ${p.file}` : "the next read localized nothing" } }),
      started_at: new Date(now).toISOString(), duration_ms: 0, composition_chain: [p.traceId],
      tasks: [{ id: "next-localizer-read", resolver_id: "deterministic", resolver_tier: "deterministic", success: reached, input_impulse_ids: [impulse], output_impulse_ids: [],
        consumed_provenance: [{ impulse_id: impulse, producer_execution_id: p.traceId, origin: "ancestor" }] }],
      tags: [reached ? "reached:true" : "reached:false", `gap_localization_variant:${p.variant}`],
      metadata: { producer_execution_id: p.traceId, variant: p.variant, gap_id: gapId, persisted_file: p.file, next_file: answer?.file ?? null, next_method: answer?.method ?? null },
    }, `credit of ${p.traceId}`);
    console.log(`${GL_LOG} settled ${p.traceId} reached=${reached} gap=${gapId}`);
  }
}

/** Why a variant-1 site may not be written, or null when it may. Read only for a write. */
async function writeRefusal(meta: Row, file: string): Promise<string | null> {
  let scope: AutonomyScope;
  try { scope = await (deps.scope ?? autonomyScope)(); } catch (err) { return `scope_unreadable (${String((err as Error)?.message ?? err).slice(0, 120)})`; }
  if (!scope.readable) return `scope_unreadable (${scope.reason})`;
  const excluded = autonomyScopeExcludes(scope, file);
  if (excluded !== null) return `excluded by the autonomy scope (${excluded})`;
  const region = regionOf(meta);
  if (region && !(deps.regionVerdict ?? regionLiteralVerdict)(region, file).ok) return `region not literal once in ${file}`;
  return null;
}

export type GapLocalizationDecision = { traceId: string; variant: number; written: boolean; outcome: string };

/**
 * THE DECISION, after the localizer answered. It never changes what the caller does with the answer; under variant-1 it
 * may persist the site (decompose, compose pick). Never throws (a failure is variant-0: nothing written).
 */
export async function noteGapLocalization(a: { caller: LocalizationCaller; gap: Row; answer: LocalizationAnswer | null }): Promise<GapLocalizationDecision> {
  const now = nowMs();
  const nowIso = new Date(now).toISOString();
  const gapId = String(a.gap["id"] ?? "");
  const traceId = `gap-localization-${gapId.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 80)}-${now}-${process.pid}-${++seq}`;
  try {
    settle(gapId, a.answer, now);
    const m = gapLocalizationVariant(nowIso);
    const meta = (a.gap["classification_metadata"] ?? a.gap["metadata"] ?? {}) as Row;
    const hadSite = typeof meta["edit_site"] === "string" && String(meta["edit_site"]).trim().length > 0;
    const ans = a.answer;
    const said = ans ? `method=${ans.method} file=${ans.file}${ans.candidates !== undefined ? ` candidates=${ans.candidates}` : ""}` : "method=none file=none";
    const persists = a.caller !== "check_supply" && !hadSite && ans !== null;
    let written = false, outcome: string;
    if (m.variant !== 1) {
      outcome = ans ? "used once (as before)" : "null (parks as before)";
    } else if (!persists) {
      outcome = !ans ? "null: nothing to persist" : a.caller === "check_supply" ? "persisted by the check supply" : "the row already had an edit_site: not rewritten";
    } else {
      const refused = await writeRefusal(meta, ans!.file);
      if (refused) outcome = `not written: ${refused}`;
      else {
        const by = `gap-localization:${a.caller}`;
        const w = await (deps.write ?? ((x: Record<string, unknown>) => resolveSubstrateGapWrite(x as never)))({
          type: "substrateGap_write",
          gap: { id: a.gap["id"], category: a.gap["category"], source: a.gap["source"], summary: a.gap["summary"], detected_at: a.gap["detected_at"], status: a.gap["status"] ?? "open",
            classification_metadata: { edit_site: ans!.file, localized_by: by, localization_method: ans!.method },
            localization: { gap_id: gapId, file: ans!.file, evidence: [{ read: ans!.method, why: String(ans!.description ?? "").slice(0, 400) }], method: ans!.method, created_at: nowIso } },
        });
        written = w.shape !== "structuredError";
        outcome = written ? `persisted ${ans!.file}` : `not written: the gap write refused it (${JSON.stringify(w.body ?? null).slice(0, 160)})`;
      }
    }
    console.log(`${GL_LOG} decision=${traceId} variant=${m.variant} (${m.why}) caller=${a.caller} gap=${gapId} had_site=${hadSite} ${said} -> ${outcome}`);
    const sited = written || (a.caller === "check_supply" && ans !== null);
    if (m.variant === 1 && (ans === null || sited)) {
      const id = gapLocalizationVariantId(m.variant);
      post({
        execution_id: traceId, template_id: id, activity_id: id, activity_variant_id: id, status: "completed", success: true, started_at: nowIso, duration_ms: 0,
        input_shapes: ["substrateGap"], output_shapes: ["gapLocalization"],
        tasks: [{ id: "localize", resolver_id: "deterministic", resolver_tier: "deterministic", success: true, input_impulse_ids: [], output_impulse_ids: [`gapLocalization:${traceId}`] }],
        tags: [`gap_localization_variant:${m.variant}`, `caller:${a.caller}`, `sited:${sited}`],
        metadata: { gapLocalization: { variant: m.variant, caller: a.caller, gap_id: gapId, had_site: hadSite, method: ans?.method ?? null, file: ans?.file ?? null, candidates: ans?.candidates ?? null, written, outcome: outcome.slice(0, 300), decided_at: nowIso } },
      }, `own trace of ${traceId}`);
      if (sited) save([...expire(load(), now), { traceId, gapId, file: ans!.file, method: ans!.method, caller: a.caller, variant: m.variant, decidedAtMs: now }]);
      else console.log(`${GL_LOG} ungraded ${traceId}: localized nothing`);
    }
    return { traceId, variant: m.variant, written, outcome };
  } catch (err) {
    console.warn(`${GL_LOG} decision failed (${String((err as Error)?.message ?? err).slice(0, 160)}): variant-0, nothing written`);
    return { traceId, variant: 0, written: false, outcome: "used as before (decision failed)" };
  }
}
