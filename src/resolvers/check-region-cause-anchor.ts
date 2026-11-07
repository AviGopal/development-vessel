/**
 * THE CHECK REGION COMES FROM THE ROW'S STATED CAUSE, NOT FROM SUMMARY TOKENS (development-vessel:check-region-cause-anchor).
 *
 * The region the arm step's region gate replaces, the one the check goal tells the drafter to assert on, and the one the
 * compose precheck replaces are all one pick, explainedTextRegion (check-supply-admission.ts): the first text or token
 * anchor of the row's summary, falsifier_spec, must_fail and control that occurs 1 to 5 times in the edit site. A row
 * whose summary mentions an incidental identifier (a row stopped by operator_hold names `operator_hold`) gets that
 * statement as its region, while the cause the row states (classification_metadata.region, or, when that was not
 * literal once, region_prior_text) is read by none of them.
 *   - variant-0 (the control): today's pick, unchanged; the decision is logged "would anchor <cause> at :<line>".
 *   - variant-1: the stated cause's region when it resolves in the site; a summary token never overrides it. A cause that
 *     does not resolve falls back to today's pick, logged cause_unresolved.
 * The cause resolves (causeRegion) as:
 *   - an identifier DECLARED in the site (a function, a const bound to a function, a method): that declaration, the
 *     mutant being every return and throw of its own body replaced together as ONE mutant (nested functions are not
 *     its body); a body with none is replaced by `{}`, an arrow's expression body by `undefined`;
 *   - else a literal occurring exactly once in the site: its smallest enclosing statement (regionStatementMutant);
 *   - else nothing, with why.
 * The pick is a pure function of the row's stated cause, the site and the variant (read per call from the
 * activityVariantMask pool impulse, synchronously), so the goal writer and both gates agree whenever they read the same
 * row and mask.
 * A NEEDS_REGION ROW (substrate-gap.ts flagNonLiteralRegion: region null, its text kept in region_prior_text) is refused
 * at arm before any region gate runs. Under variant-1, one whose stated cause resolves in its edit site is let through
 * to the gates (causeClearsNeedsRegion), so the pick is measured; under variant-0 it is refused as before.
 * Under variant-1 a check goal written on a resolved cause posts this decision's trace (output checkRegionAnchor), and
 * the decision is graded by its CONSUMER, the same gap's next region gate on a landed check: the check's red moved under
 * the cause mutant -> reached; it survived it -> not reached; nothing measured within 48 h -> ungraded, logged.
 * Variant-0 posts no trace.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { VOLUME_ROOT } from "../config.js";
import { countLiteral, regionOf } from "../lib/region-literal.js";
import { resolvePoolImpulse } from "./pool-impulse.js";
import { regionStatementMutant, type Mutant } from "./scope-earn-in.js";
import { postConsumerTrace } from "./substrate-gap.js";

export const CHECK_REGION_CAUSE_ANCHOR_ACTIVITY = "development-vessel:check-region-cause-anchor";
export const CHECK_REGION_CAUSE_ANCHOR_CREDIT_ACTIVITY = "development-vessel:check-region-cause-anchor-credit";
export const checkRegionCauseAnchorVariantId = (variant: number): string => (variant === 0 ? CHECK_REGION_CAUSE_ANCHOR_ACTIVITY : `${CHECK_REGION_CAUSE_ANCHOR_ACTIVITY}-v${variant}`);
const CRCA_LOG = `[${CHECK_REGION_CAUSE_ANCHOR_ACTIVITY}]`;
const CRCA_CREDIT_WINDOW_MS = 48 * 3_600_000;
/** One "would anchor" / cause_unresolved line per site and cause in this window: every goal build and gate run asks. */
const CRCA_LOG_EVERY_MS = 10 * 60_000;

type Row = Record<string, unknown>;
type MaskRow = { id?: string; body?: unknown };
export type CauseRegion = { anchor: string; kind: "cause"; occurrences: number; mutant: Mutant };
export type CheckRegionCauseAnchorDeps = {
  readMasks?: () => MaskRow[];
  postTrace?: (t: Record<string, unknown>) => Promise<number | null>;
  nowMs?: () => number;
  /** The pending decisions, in place of VOLUME_ROOT/check-region-cause-anchor.json. */
  stateFile?: string;
};
let deps: CheckRegionCauseAnchorDeps = {};
let seq = 0;
const lastLogged = new Map<string, number>();
/** Tests only: the seams the decision and its credit use. null restores the real ones (and the log rate limit). */
export function __setCheckRegionCauseAnchorDepsForTests(d: CheckRegionCauseAnchorDeps | null): void { deps = d ?? {}; lastLogged.clear(); }
const nowMs = (): number => deps.nowMs?.() ?? Date.now();
const post = (t: Record<string, unknown>, what: string): void => {
  void (deps.postTrace ?? ((x: Record<string, unknown>) => postConsumerTrace(x, "check-region-cause-anchor")))(t)
    .then((st) => { if (st === null || st < 200 || st >= 300) console.warn(`${CRCA_LOG} ${what} not posted (http=${st ?? "none"})`); })
    .catch((err) => console.warn(`${CRCA_LOG} ${what} not posted: ${String((err as Error)?.message ?? err).slice(0, 160)}`));
};
/** The line is built only when it is printed (the variant-0 one derives today's pick again). */
const logOnce = (key: string, line: () => string): void => {
  const now = nowMs();
  if (now - (lastLogged.get(key) ?? -Infinity) < CRCA_LOG_EVERY_MS) return;
  lastLogged.set(key, now);
  console.log(line());
};

/** Which variant runs: the first open activityVariantMask row for the activity whose [from, until) holds now.
 *  No row in force, an unknown variant or an unreadable pool: variant-0. Never throws. */
export function checkRegionCauseAnchorVariant(nowIso: string): { variant: number; why: string } {
  let rows: MaskRow[];
  try {
    rows = (deps.readMasks ?? (() => resolvePoolImpulse({ type: "poolImpulse", shape: "activityVariantMask", status: "open" }).body.impulses as MaskRow[]))();
  } catch (err) {
    return { variant: 0, why: `mask_unread (${String((err as Error)?.message ?? err).slice(0, 160)}): variant-0` };
  }
  const now = Date.parse(nowIso);
  for (const r of rows) {
    const b = (r?.body ?? {}) as Record<string, unknown>;
    if (b["activity_id"] !== CHECK_REGION_CAUSE_ANCHOR_ACTIVITY) continue;
    const from = Date.parse(String(b["from"] ?? "")), until = Date.parse(String(b["until"] ?? ""));
    if (!Number.isFinite(from) || !Number.isFinite(until) || now < from || now >= until) continue;
    const v = b["active_variant"];
    if (v !== 0 && v !== 1) return { variant: 0, why: `mask ${String(r.id)} names unknown variant ${JSON.stringify(v)}: variant-0` };
    return { variant: v, why: `mask ${String(r.id)} [${String(b["from"])}, ${String(b["until"])}) by ${String(b["by"])}: ${String(b["reason"])}` };
  }
  return { variant: 0, why: "no mask in force: variant-0" };
}

/** The cause the row states: its region, else the text a non-literal region was moved to (region_prior_text). Pure. */
export function statedCauseOf(meta: Row | null | undefined): string | undefined {
  const region = regionOf(meta);
  if (region) return region;
  const prior = (meta ?? {})["region_prior_text"];
  const t = typeof prior === "string" ? prior.trim() : "";
  return t || undefined;
}

type TsModule = typeof import("typescript");
let tsMod: TsModule | null | undefined;
const loadTs = (): TsModule | null => {
  if (tsMod === undefined) { try { tsMod = createRequire(import.meta.url)("typescript") as TsModule; } catch { tsMod = null; } }
  return tsMod;
};

/** The declaration of `name` in the site, with the body whose outputs the mutant replaces, or null. */
function declarationOf(ts: TsModule, sf: import("typescript").SourceFile, name: string): { decl: import("typescript").Node; body: import("typescript").Node } | null {
  let out: { decl: import("typescript").Node; body: import("typescript").Node } | null = null;
  const fnBody = (n: import("typescript").Node | undefined): import("typescript").Node | null =>
    n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) ? n.body : null;
  const visit = (n: import("typescript").Node): void => {
    if (out) return;
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && n.name.getText(sf) === name && n.body) out = { decl: n, body: n.body };
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      const b = fnBody(n.initializer);
      if (b) out = { decl: n, body: b };
    }
    if (!out) ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * The region of `cause` in the site, or null with why. Pure (it reads only its arguments and the TypeScript parser).
 */
export function causeRegion(siteSrc: string, siteRel: string, cause: string): { region: CauseRegion | null; why: string } {
  const c = cause.trim();
  if (!c) return { region: null, why: "no stated cause" };
  const ts = loadTs();
  if (!ts) return { region: null, why: "the TypeScript parser is not loadable" };
  const line = (sf: import("typescript").SourceFile, at: number) => sf.getLineAndCharacterOfPosition(at).line + 1;
  if (/^[A-Za-z_$][\w$]*$/.test(c)) {
    const sf = ts.createSourceFile("m.ts", siteSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const found = declarationOf(ts, sf, c);
    if (found) {
      const { body } = found;
      const outs: import("typescript").Node[] = [];
      const visit = (n: import("typescript").Node): void => {
        if (n !== body && (ts.isFunctionLike(n) || ts.isClassLike(n))) return;
        if (ts.isReturnStatement(n) || ts.isThrowStatement(n)) { outs.push(n); return; }
        ts.forEachChild(n, visit);
      };
      visit(body);
      const tsFile = /\.[cm]?tsx?$/.test(siteRel);
      let mutant: Mutant;
      if (outs.length > 0) {
        const start = outs[0]!.getStart(sf), end = outs[outs.length - 1]!.getEnd();
        let replacement = "", at = start;
        for (const o of outs) {
          const inert = ts.isReturnStatement(o) ? (tsFile ? "return undefined as any;" : "return undefined;") : "void 0;";
          replacement += siteSrc.slice(at, o.getStart(sf)) + inert;
          at = o.getEnd();
        }
        mutant = { operator: "replace_statement", start, end, original: siteSrc.slice(start, end), replacement, line: line(sf, start) };
      } else {
        const start = body.getStart(sf), end = body.getEnd();
        mutant = { operator: "replace_statement", start, end, original: siteSrc.slice(start, end), replacement: ts.isBlock(body) ? "{}" : "undefined", line: line(sf, start) };
      }
      return { region: { anchor: c, kind: "cause", occurrences: Math.max(1, outs.length), mutant }, why: "" };
    }
  }
  const n = countLiteral(siteSrc, c);
  if (n !== 1) return { region: null, why: `cause ${JSON.stringify(c.slice(0, 80))}: not a declaration in ${siteRel}, and ${n} literal occurrence(s)` };
  const at = siteSrc.indexOf(c);
  const m = regionStatementMutant(siteSrc, at, at + c.length, siteRel);
  if (!m) return { region: null, why: `cause ${JSON.stringify(c.slice(0, 80))}: its one occurrence is in a declaration or block` };
  return { region: { anchor: c, kind: "cause", occurrences: 1, mutant: m }, why: "" };
}

type TodaysPick = { region: { anchor: string; kind: string; mutant: Mutant } | null; why: string };
/**
 * THE DECISION, at the head of explainedTextRegion: the region to use in place of today's pick, or null for today's.
 * `today` is today's pick without the cause, computed only for the variant-0 log line. Never throws (a failure is
 * today's pick).
 */
export function causeAnchorRegion(siteSrc: string, siteRel: string, cause: string, today: () => TodaysPick): CauseRegion | null {
  try {
    const m = checkRegionCauseAnchorVariant(new Date(nowMs()).toISOString());
    const c = causeRegion(siteSrc, siteRel, cause);
    const key = `${siteRel}\u0000${cause}\u0000${m.variant}`;
    if (m.variant === 1) {
      if (c.region) return c.region;
      logOnce(key, () => `${CRCA_LOG} variant=1 (${m.why}) site=${siteRel} cause_unresolved: ${c.why}; today's pick`);
      return null;
    }
    const r = c.region;
    if (r) logOnce(key, () => {
      const t = today().region;
      return `${CRCA_LOG} variant=0 (${m.why}) site=${siteRel} would anchor ${JSON.stringify(r.anchor.slice(0, 80))} at :${r.mutant.line} (today: ${t ? `${t.kind} ${JSON.stringify(t.anchor.slice(0, 80))} at :${t.mutant.line}` : "no region"})`;
    });
    return null;
  } catch (err) {
    console.warn(`${CRCA_LOG} decision failed (${String((err as Error)?.message ?? err).slice(0, 160)}): today's pick`);
    return null;
  }
}

/**
 * A NEEDS_REGION ROW REACHES THE GATES UNDER VARIANT-1 when its stated cause resolves in its edit site; under variant-0,
 * or with no site text, it does not (refused at arm as before). Never throws.
 */
export function causeClearsNeedsRegion(meta: Row, siteSrc: string | null, siteRel: string | null): boolean {
  try {
    if (meta["needs_region"] !== true || siteSrc === null || !siteRel) return false;
    const cause = statedCauseOf(meta);
    if (!cause) return false;
    if (checkRegionCauseAnchorVariant(new Date(nowMs()).toISOString()).variant !== 1) return false;
    return causeRegion(siteSrc, siteRel, cause).region !== null;
  } catch { return false; }
}

type Pending = { traceId: string; gapId: string; anchor: string; line: number; variant: number; decidedAtMs: number };
const stateFile = (): string => deps.stateFile ?? join(VOLUME_ROOT, "check-region-cause-anchor.json");
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
  } catch (err) { console.warn(`${CRCA_LOG} state not saved: ${String((err as Error)?.message ?? err).slice(0, 160)}`); }
}
function expire(pending: Pending[], now: number): Pending[] {
  return pending.filter((p) => {
    if (now - p.decidedAtMs < CRCA_CREDIT_WINDOW_MS) return true;
    console.log(`${CRCA_LOG} ungraded ${p.traceId}: no region gate measured gap ${p.gapId} within 48 h`);
    return false;
  });
}

/**
 * THE PRODUCER: a check goal was written for `gapId`. Under variant-1, with a stated cause that resolves, the decision
 * posts its trace and waits for its consumer; otherwise nothing is recorded. Never throws.
 */
export function noteCauseAnchorGoal(a: { gapId: string; meta: Row; siteSrc: string | null; siteRel: string | null }): string | null {
  try {
    const cause = statedCauseOf(a.meta);
    if (!cause || a.siteSrc === null || !a.siteRel) return null;
    const now = nowMs();
    const nowIso = new Date(now).toISOString();
    const m = checkRegionCauseAnchorVariant(nowIso);
    if (m.variant !== 1) return null;
    const c = causeRegion(a.siteSrc, a.siteRel, cause);
    if (!c.region) return null;
    const traceId = `check-region-cause-anchor-${a.gapId.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 80)}-${now}-${process.pid}-${++seq}`;
    const pending = expire(load(), now).filter((p) => p.gapId !== a.gapId);
    pending.push({ traceId, gapId: a.gapId, anchor: c.region.anchor, line: c.region.mutant.line, variant: m.variant, decidedAtMs: now });
    save(pending);
    const id = checkRegionCauseAnchorVariantId(m.variant);
    post({
      execution_id: traceId, template_id: id, activity_id: id, activity_variant_id: id, status: "completed", success: true, started_at: nowIso, duration_ms: 0,
      input_shapes: ["substrateGap"], output_shapes: ["checkRegionAnchor"],
      tasks: [{ id: "anchor-on-cause", resolver_id: "deterministic", resolver_tier: "deterministic", success: true, input_impulse_ids: [], output_impulse_ids: [`checkRegionAnchor:${traceId}`] }],
      tags: [`check_region_cause_anchor_variant:${m.variant}`],
      metadata: { checkRegionAnchor: { variant: m.variant, gap_id: a.gapId, site: a.siteRel, cause: c.region.anchor.slice(0, 200), line: c.region.mutant.line, decided_at: nowIso } },
    }, `own trace of ${traceId}`);
    console.log(`${CRCA_LOG} decision=${traceId} variant=1 (${m.why}) gap=${a.gapId} site=${a.siteRel} anchored ${JSON.stringify(c.region.anchor.slice(0, 80))} at :${c.region.mutant.line}`);
    return traceId;
  } catch (err) {
    console.warn(`${CRCA_LOG} goal not noted: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
    return null;
  }
}

/**
 * THE CONSUMER: the gap's region gate on a landed check settles its pending decision. A measured cause-region run:
 * the red moved (changed > 0) -> reached; it survived -> not reached. A gate that measured nothing, or a region that was
 * not the cause's, settles nothing. Never throws.
 */
export function settleCauseAnchor(gapId: string, gate: { kind: string; record?: Row }): void {
  try {
    const rec = gate.record ?? {};
    if (rec["region"] !== "derived_from_stated_cause" || (gate.kind !== "pass" && gate.kind !== "refuse")) return;
    const measured = Number(rec["measured"] ?? 0);
    if (!(measured > 0)) return;
    const now = nowMs();
    const all = load();
    const kept = expire(all, now);
    const mine = kept.filter((p) => p.gapId === gapId);
    if (mine.length === 0) { if (kept.length !== all.length) save(kept); return; }
    save(kept.filter((p) => p.gapId !== gapId));
    const reached = gate.kind === "pass" && Number(rec["changed"] ?? 0) > 0;
    for (const p of mine) {
      const impulse = `checkRegionAnchor:${p.traceId}`;
      post({
        execution_id: p.traceId.replace(/^check-region-cause-anchor-/, "check-region-cause-anchor-credit-"),
        template_id: CHECK_REGION_CAUSE_ANCHOR_CREDIT_ACTIVITY, activity_id: CHECK_REGION_CAUSE_ANCHOR_CREDIT_ACTIVITY, activity_variant_id: CHECK_REGION_CAUSE_ANCHOR_CREDIT_ACTIVITY,
        status: reached ? "completed" : "failed", success: reached,
        ...(reached ? {} : { failure_mode: { type: "verifier_negative", reason: "the check's red survived replacing the stated cause's region" } }),
        started_at: new Date(now).toISOString(), duration_ms: 0, composition_chain: [p.traceId],
        tasks: [{ id: "region-gate", resolver_id: "deterministic", resolver_tier: "deterministic", success: reached, input_impulse_ids: [impulse], output_impulse_ids: [],
          consumed_provenance: [{ impulse_id: impulse, producer_execution_id: p.traceId, origin: "ancestor" }] }],
        tags: [reached ? "reached:true" : "reached:false", `check_region_cause_anchor_variant:${p.variant}`],
        metadata: { producer_execution_id: p.traceId, variant: p.variant, gap_id: gapId, cause: p.anchor, line: p.line, measured, changed: Number(rec["changed"] ?? 0) },
      }, `credit of ${p.traceId}`);
      console.log(`${CRCA_LOG} settled ${p.traceId} reached=${reached} gap=${gapId}`);
    }
  } catch { /* the credit never changes an arm */ }
}
