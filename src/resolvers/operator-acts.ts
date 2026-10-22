/**
 * operatorActsOf — THE ONE READER of the operator acts in a gap row's provenance (qa ruling 2026-10-21, law 3).
 *
 * A closure is counted as the system's own repair only when no operator act is in its provenance. Two readers used to
 * decide that separately (the research watcher and goal reach), and each missed acts the other saw. This module is the
 * one reader qa ruled for: today its only caller is the standing evaluator's repair_autonomy row (self-fact-reconcile.ts).
 * goal-reach-tick does NOT read it yet; moving goal reach onto it is separate work.
 *
 * PURE. Every input is passed in: the gap rows (for lineage), the gap-write events, the commits touching the edit site
 * and the check file, the scope acts, and the key class map. Nothing here reads the store, git, the journal or the
 * environment, so the verdict cannot move with anything the caller did not hand it, and the tests drive it with
 * fixtures alone.
 *
 * WHAT COUNTS AS AN OPERATOR ACT (the accepted link requirements, operator_acts_addenda, in order):
 *   2a   a hold OR a release (any operator_<x>_by stamped "operator:…") on the row or ANY lineage ancestor, timed at or
 *        before the fix. Lineage follows parent_gap_id / parent_gap / root_gap_id / root_gap transitively, AND the id
 *        rule: a recommit child PREPENDS "recommit-", a narrow / step / verify child APPENDS "-<suffix>".
 *   2a′  an operator_<x>_at stamp with no matching _by still counts (holds and releases are only ever operator acts).
 *   3    an operator scope act opening the edit_site, effective from its earliest per-node apply (the caller passes
 *        the effective time it can show; a commit time is earlier than any apply, so it is the conservative stand-in).
 *   -    an operator commit to the edit_site or the check file before the fix.
 *   -    an operator-authored check file (the commit that added it was not the lane's).
 *   -    an operator-filed row (source operator:* or human_reported, or filed_by operator:*).
 *   4/4a an in-process or node-self gap write counts as SYSTEM, flagged route-unverifiable while the write event
 *        carries no route (the /resolvers/execute fix has not landed).
 * THE WINDOW is the row's FILING to its close + 24 h (link 5), not the fix: a post-fix re-arm, a hand close, an edit
 * of a deadline or of the evidence, all count. An undated hold flag (operator_hold with no _at), an operator-only row
 * field (deadline_status, date_status, latest_by), a hand close (closed_by operator:*, close_basis
 * operator_exercised_falsifier), an operator write on an ANCESTOR row, and an operator oracle label on a provenance
 * trace count too. UNKNOWN IS NEVER CLEAN: events that are unread, capped, or do not reach back to the filing, an
 * unparsable time, and unread labels are reported (unread / unattributable / review), never read as "no act".
 * The arm write is read through the same events: an arm (a write changing check_supply or evidence_resolve) by an
 * operator principal is the act the repair row exists to see ("arm writer not an operator route"). Any other operator
 * gap write in the provenance counts too, and so does an attempt registered directed (an operator:direct grant): both
 * are operator acts by construction, outside the addenda list only because the list names what was being missed.
 *
 * KEY CLASSES ARE DATA. A gap-write event names only the first 6 characters of a key id. Which keys are operator keys
 * is not known to this vessel (identity holds no owner kind it serves), so the class map is an INPUT; with none, a
 * key-principal write is unattributable, never assumed system. Two listed keys sharing the 6-character prefix make it
 * ambiguous, never first-match. A write the holder recorded under a PEER key was forwarded: the forwarding node's own
 * event decides, and without it nobody can say who wrote it.
 */

export type GapRow = Record<string, unknown>;

/** "recommit-" prefixes stripped, and how many there were. */
export function coreId(id: string): { core: string; depth: number } {
  let core = id;
  let depth = 0;
  while (core.startsWith("recommit-")) { core = core.slice("recommit-".length); depth += 1; }
  return { core, depth };
}

const metaOf = (r: GapRow | undefined): Record<string, unknown> => {
  const m = r?.["classification_metadata"];
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
};

const LINK_FIELDS = ["parent_gap_id", "parent_gap", "root_gap_id", "root_gap"] as const;

/**
 * The lineage ancestors of `gid`: explicit links (transitively, from the row and from each linked ancestor) UNION the
 * id rule on gid itself — k is an ancestor when core(k) is a "-"-boundary prefix of core(gid), or equal to it with
 * fewer recommit- prefixes. (A suffix-only rule missed every recommit parent.)
 */
export function lineageAncestors(gid: string, byId: ReadonlyMap<string, GapRow>): Set<string> {
  const out = new Set<string>();
  const todo = [gid];
  while (todo.length > 0) {
    const cur = byId.get(todo.pop()!);
    if (!cur) continue;
    const m = metaOf(cur);
    for (const k of LINK_FIELDS) {
      const v = m[k] || cur[k];
      if (typeof v === "string" && byId.has(v) && v !== gid && !out.has(v)) { out.add(v); todo.push(v); }
    }
  }
  const g = coreId(gid);
  for (const k of byId.keys()) {
    if (k === gid || out.has(k)) continue;
    const c = coreId(k);
    if (g.core.startsWith(c.core + "-") || (c.core === g.core && c.depth < g.depth)) out.add(k);
  }
  return out;
}

/** An instant from an ISO time; fractional seconds past milliseconds are dropped (the parser reads three digits). */
export function isoMs(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).replace(/(\.\d{3})\d+/, "$1");
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export type OperatorActKind = "2a" | "2a-at-without-by" | "hold-undated" | "3" | "edit-site-commit" | "check-authored" | "operator-filed" | "arm" | "gap-write" | "ancestor-gap-write" | "directed" | "hand-close" | "operator-field" | "operator-label";
export interface OperatorAct {
  /** Which accepted addendum this act falls under; `operator_act:<addendum>` is the failing link it names. */
  readonly addendum: OperatorActKind;
  readonly detail: string;
  /** The row the act is stamped on, when it is a row act (this row or an ancestor). */
  readonly on?: string;
  readonly at: string | null;
}

/**
 * Addendum 2a and 2a′: operator acts stamped as fields on the row or its lineage ancestors, at or before `untilMs`.
 * An unreadable stamp time counts (conservatively), and so does an operator_<x>_at with no _by, dated or not.
 */
export function rowFieldOperatorActs(gid: string, byId: ReadonlyMap<string, GapRow>, untilMs: number | null): OperatorAct[] {
  const out: OperatorAct[] = [];
  for (const k of [gid, ...[...lineageAncestors(gid, byId)].sort()]) {
    const m = metaOf(byId.get(k));
    const where = k === gid ? "this row" : `ancestor ${k.slice(-60)}`;
    const seenAt = new Set<string>();
    for (const [f, v] of Object.entries(m)) {
      if (!(f.startsWith("operator_") && f.endsWith("_by") && String(v).startsWith("operator:"))) continue;
      const atField = `${f.slice(0, -3)}_at`;
      seenAt.add(atField);
      const at = isoMs(m[atField]);
      if (at === null || untilMs === null || at <= untilMs) {
        out.push({ addendum: "2a", on: k, at: at === null ? null : new Date(at).toISOString(), detail: `row field ${f}=${String(v).slice(0, 40)} @ ${at === null ? "?" : new Date(at).toISOString()} on ${where}` });
      }
    }
    for (const [f, v] of Object.entries(m)) {
      if (!(f.startsWith("operator_") && f.endsWith("_at")) || seenAt.has(f) || !v) continue;
      const at = isoMs(v);
      // An unparsable time is unknown, and unknown is never clean: the stamp counts.
      if (at === null || untilMs === null || at <= untilMs) {
        out.push({ addendum: "2a-at-without-by", on: k, at: at === null ? null : new Date(at).toISOString(), detail: `row field ${f}=${String(v).slice(0, 24)} (no _by stamped; counted${at === null ? ", time unparsable" : ""}) on ${where}` });
      }
    }
  }
  return out;
}

// ─── gap-write events (link 5 / addendum 4) ─────────────────────────────────
export type KeyClass = "operator" | "system" | "peer";
/** One key the class map knows: a masked id (any length from 6) and its owner kind. */
export interface KeyMapEntry { readonly id: string; readonly owner_kind: KeyClass | string }

/** The class of a 6-character event key id: "ambiguous" when more than one listed key shares it (never first match). */
export function keyClass6(kid6: string, keymap: readonly KeyMapEntry[]): string | null {
  const hits = keymap.filter((k) => k.id.slice(0, 6) === kid6);
  if (hits.length > 1) return "ambiguous";
  return hits[0] ? String(hits[0].owner_kind) : null;
}

export interface GapWriteEventLike {
  readonly gap_id?: string | null;
  readonly principal_kind?: string | null;
  readonly key_id?: string | null;
  readonly operator_marker?: boolean | null;
  readonly store?: string | null;
  readonly outcome?: string | null;
  readonly fields_changed?: readonly string[] | null;
  readonly ts?: string | null;
  readonly route?: unknown;
}

/**
 * One gap-write event's writer class: "operator" | "system" | "system(unobserved principal: in-process)" |
 * "forwarded(origin event decides)" | "unattributable(…)". `source` is "holder" for the gap-store holder's own file and
 * "origin" for a forwarding node's file; `originPresent` says whether the forwarding node's events were read.
 * `peerKeys6` are the 6-character ids of the node keys a forwarding node writes through.
 */
export function classifyGapWriteEvent(ev: GapWriteEventLike, source: "holder" | "origin", originPresent: boolean, keymap: readonly KeyMapEntry[], peerKeys6: readonly string[]): string {
  const kind = ev.principal_kind ?? null;
  const kid = String(ev.key_id ?? "");
  if (ev.operator_marker === true) return "operator";
  if (kind === "node-self") return "system";
  if (kind === "key") {
    const kc = keyClass6(kid, keymap);
    if (kc === "ambiguous") return `unattributable(ambiguous 6-char key prefix ${kid})`;
    if (kc === "operator") return "operator";
    if (source === "holder" && peerKeys6.some((p) => kid.startsWith(p))) {
      return originPresent ? "forwarded(origin event decides)" : `unattributable(forwarded via peer key ${kid}; origin file absent)`;
    }
    if (kc === "system") return "system";
  }
  // Addendum 4: no route crossed, so no operator key could carry it — system by construction, principal unobserved.
  if (kind === "in-process") return "system(unobserved principal: in-process)";
  return `unattributable(${kind ?? "none"}:${kid || "-"})`;
}

// ─── oracle labels (operator feedback on a trace in the provenance) ─────────
export interface OracleLabelLike {
  readonly labeler?: string | null;
  readonly source?: string | null;
  readonly created_at?: string | null;
  readonly principal_kind?: string | null;
  readonly principal_key_id?: string | null;
}
export interface LabelClassContext {
  /** When the server-set label principal converged on the label's node; labels before it are caller-declared. */
  readonly fixLiveAt: string;
  readonly keymap: readonly KeyMapEntry[];
  /** Peer and node keys a label can be forwarded under: the true writer is then unknown. */
  readonly forwardingKeys: readonly string[];
  /** The node's own bootstrap admin key(s): an admin label under one is the system's. */
  readonly nodeSelfAdminKeys: readonly string[];
}
/**
 * STRICT label rule: a (labeler, source) pair is caller-chosen and forgeable, so a label created before the server-set
 * principal converged reads "review". After it, the stored principal decides: a person's session or an operator key
 * is "operator(…)"; a system key, or the node-self admin key, is "system"; a forwarding key, an obo principal, an
 * ambiguous or unlisted key reads "review(…)".
 */
export function classifyOracleLabel(lab: OracleLabelLike, ctx: LabelClassContext): string {
  const ct = isoMs(lab.created_at), ft = isoMs(ctx.fixLiveAt);
  if (ft === null || ct === null || ct < ft || !lab.principal_kind) {
    return `review(label ${String(lab.labeler ?? "None")}/${String(lab.source ?? "None")} before the server-set principal: caller-declared, unattributable — strict rule)`;
  }
  const kind = lab.principal_kind;
  const pkid = String(lab.principal_key_id ?? "");
  if (kind === "session") return "operator(label by a person's session — human feedback)";
  if (kind === "obo") return "review(label written on behalf of another principal — true writer unknown)";
  const hits = ctx.keymap.filter((k) => pkid !== "" && (pkid.startsWith(k.id) || k.id.startsWith(pkid)));
  if ((kind === "key" || kind === "admin") && pkid !== "") {
    if (hits.length > 1) return `review(label principal key ${pkid}: ambiguous)`;
    if (ctx.forwardingKeys.some((f) => pkid.startsWith(f))) return `review(label via peer/node key ${pkid}: forwarded, true writer unknown)`;
    if (kind === "admin") return ctx.nodeSelfAdminKeys.some((a) => pkid.startsWith(a)) ? "system" : "operator(label by an admin principal)";
    if (hits.length === 1) {
      if (hits[0]!.owner_kind === "operator") return "operator(label written by an operator principal — operator feedback)";
      if (hits[0]!.owner_kind === "system") return "system";
    }
    return `review(label principal key ${pkid}: unlisted)`;
  }
  return `review(label principal ${kind})`;
}

// ─── the reader ─────────────────────────────────────────────────────────────
/** An operator scope act: the paths it opened to the lane, effective from `effective_at` (earliest per-node apply). */
export interface ScopeAct { readonly id: string; readonly opened: readonly string[]; readonly effective_at: string }
/** A commit touching the edit site or the check file. `lane` is true for the lane's own author. */
export interface SiteCommit { readonly sha: string; readonly author: string; readonly at: string; readonly lane: boolean; readonly files: readonly string[] }

/**
 * THE AUTONOMOUS-INTENT RULE, as the auto-revert states it (gap-landing-verdict.ts, autoRevertRegressedLandings guard 2,
 * and recordFalsifiedAutonomousLanding): an attempt is autonomous only when its attemptIntent says `directed === false`
 * EXACTLY; absent or unknown (null) is not autonomous. Restated here rather than imported because that module keeps it
 * inline (`intent.directed !== false`); one predicate, the same three cases.
 */
export function intentIsAutonomous(directed: unknown): boolean { return directed === false; }

/** Row fields only an operator writes (no system writer sets them): a deadline, a dated ruling, a filing note. */
export const OPERATOR_ONLY_FIELDS = ["deadline_status", "date_status", "latest_by", "filed_by"] as const;
/** Row fields that name the traces a gap derives from (oracle labels on them are operator feedback in its provenance). */
export const PROVENANCE_TRACE_FIELDS = ["execution_id", "example_trace_ids", "sample_exec_ids", "representative_trace_ids", "first_failed_task_id", "closed_by_trace"] as const;
/** Every provenance trace id of a row (its PROVENANCE_TRACE_FIELDS, at the top level and in its metadata) plus `extra`.
 *  ONE list: the caller fetches the oracle labels of exactly these, and the reader matches labels against them. */
export function provenanceTraceIds(row: GapRow, extra: readonly string[] = []): string[] {
  const m = metaOf(row);
  const out = new Set<string>(extra.filter((x) => typeof x === "string" && x.length > 0));
  for (const f of PROVENANCE_TRACE_FIELDS) {
    for (const v of [m[f], row[f]]) for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string" && x) out.add(x);
  }
  return [...out].sort();
}

export interface OperatorActsContext {
  /** Every gap row the store holds (lineage reads ancestors from it). */
  readonly byId: ReadonlyMap<string, GapRow>;
  /** The provenance window, FILING to close + 24 h (link 5): every act inside it counts, before or after the fix.
   *  null untilAt = no upper bound (the closure is still open, or its close cannot be dated). */
  readonly filedAt: string | null;
  readonly untilAt: string | null;
  /** The repo-relative edit site and check file paths, as the commits list their files. */
  readonly editSitePath?: string | null;
  readonly checkPath?: string | null;
  /** Addendum 3. null: unreadable (said in `unread`). */
  readonly scopeActs?: readonly ScopeAct[] | null;
  /** Commits touching the edit site or the check file. null: unreadable. */
  readonly siteCommits?: readonly SiteCommit[] | null;
  /** The commit that ADDED the check file. null: unreadable; undefined: never added. */
  readonly checkFirstCommit?: SiteCommit | null;
  /** Gap-write events of the row AND of its lineage ancestors (holder's file; a forwarding node's as source "origin").
   *  null: unreadable. */
  readonly events?: ReadonlyArray<GapWriteEventLike & { readonly source?: "holder" | "origin" }> | null;
  /** The events read were cut by the read cap: some may be missing. */
  readonly eventsCapped?: boolean;
  /** The events reach back to the row's filing (its creating write, status_from "absent", is among them). */
  readonly eventsFromFiling?: boolean;
  readonly originPresent?: boolean;
  /** The landing attempt's attemptIntent.directed, as stored (true, false, null or absent). */
  readonly directed?: unknown;
  /** Extra provenance traces (the landing's authoring execution). */
  readonly traceIds?: readonly string[];
  /** Oracle labels on the provenance traces. null: unreadable, so operator feedback cannot be ruled out (REVIEW). */
  readonly labels?: ReadonlyArray<OracleLabelLike & { readonly execution_id?: string | null }> | null;
  readonly labelContext?: LabelClassContext | null;
  /** The key class map. null or absent: no map, so a key-principal write is unattributable. */
  readonly keymap?: readonly KeyMapEntry[] | null;
  readonly peerKeys6?: readonly string[];
}
export interface OperatorActsResult {
  readonly acts: OperatorAct[];
  /** The arm writes (check_supply / evidence_resolve changes), each with its writer class. */
  readonly arm_writes: Array<{ readonly at: string | null; readonly writer: string }>;
  /** Writes whose writer cannot be classed: while any stands and no act is found, the closure is unattributable. */
  readonly unattributable: string[];
  /** Label (or other) readings that need review before anything counts. */
  readonly review: string[];
  /** Addendum 4a: system-principal writes (in-process, node-self) with no recorded route. */
  readonly route_unverifiable: number;
  /** Inputs that were unreadable or incomplete, by name: an act there cannot be ruled out. */
  readonly unread: string[];
}

const ARM_FIELDS = ["classification_metadata.check_supply", "classification_metadata.evidence_resolve"];

/** Every operator act in `row`'s provenance, FILING to close + 24 h (see the module comment for what counts). */
export function operatorActsOf(row: GapRow, ctx: OperatorActsContext): OperatorActsResult {
  const gid = String(row["id"] ?? "");
  const m = metaOf(row);
  const filedMs = isoMs(ctx.filedAt);
  const untilMs = isoMs(ctx.untilAt);
  const acts: OperatorAct[] = [];
  const unread: string[] = [];
  const unattributable: string[] = [];
  const review: string[] = [];
  const armWrites: Array<{ at: string | null; writer: string }> = [];
  let routeUnverifiable = 0;
  if (filedMs === null) unread.push("the row's filing time (unset or unparsable)");
  if (ctx.untilAt !== null && untilMs === null) unread.push("the provenance window's end (unparsable)");
  const inWindow = (ms: number) => (filedMs === null || ms >= filedMs) && (untilMs === null || ms <= untilMs);

  // an operator-filed row
  const src = String(row["source"] ?? "");
  const filedBy = String(m["filed_by"] ?? "");
  if (src.startsWith("operator:") || src === "human_reported" || filedBy.startsWith("operator:")) {
    acts.push({ addendum: "operator-filed", at: ctx.filedAt, detail: `filed by ${src.startsWith("operator:") || src === "human_reported" ? src : filedBy}` });
  }
  if (ctx.directed === true) acts.push({ addendum: "directed", at: null, detail: "the landing's attempt was registered directed under an operator:direct grant" });
  // 2a, 2a′, and a hold flag with no stamp, on the row and every lineage ancestor
  const byId = ctx.byId.has(gid) ? ctx.byId : new Map([...ctx.byId, [gid, row]]);
  const lineage = [gid, ...[...lineageAncestors(gid, byId)].sort()];
  acts.push(...rowFieldOperatorActs(gid, byId, untilMs));
  for (const k of lineage) {
    const km = metaOf(byId.get(k));
    if (km["operator_hold"] === true && !km["operator_hold_at"]) acts.push({ addendum: "hold-undated", on: k, at: null, detail: `operator_hold set with no operator_hold_at on ${k === gid ? "this row" : `ancestor ${k.slice(-60)}`} (an undated hold counts)` });
  }
  // operator-only row fields and a hand close, on the row and every lineage ancestor
  for (const k of lineage) {
    const kr = byId.get(k);
    const km = metaOf(kr);
    const where = k === gid ? "this row" : `ancestor ${k.slice(-60)}`;
    for (const f of OPERATOR_ONLY_FIELDS) if (f !== "filed_by" && km[f] !== undefined && km[f] !== null && km[f] !== "") acts.push({ addendum: "operator-field", on: k, at: null, detail: `row field ${f} is set on ${where} (only an operator writes it)` });
    if (String(km["closed_by"] ?? "").startsWith("operator:") || km["close_basis"] === "operator_exercised_falsifier") acts.push({ addendum: "hand-close", on: k, at: String(kr?.["closed_at"] ?? km["closed_at"] ?? "") || null, detail: `${where} closed by hand (${String(km["closed_by"] ?? km["close_basis"])})` });
  }
  // 3: an operator scope act opening the edit site, effective inside the window
  const site = String(m["edit_site"] ?? "");
  if (ctx.scopeActs === null) unread.push("scope acts");
  for (const a of ctx.scopeActs ?? []) {
    const eff = isoMs(a.effective_at);
    if (!site || !a.opened.includes(site)) continue;
    if (eff === null) { acts.push({ addendum: "3", at: null, detail: `edit_site opened to the lane by operator scope act ${a.id} (time unparsable; counted)` }); continue; }
    if (untilMs === null || eff <= untilMs) acts.push({ addendum: "3", at: new Date(eff).toISOString(), detail: `edit_site opened to the lane by operator scope act ${a.id} effective ${new Date(eff).toISOString()}` });
  }
  // operator commits to the edit site or the check file inside the window (after the fix too)
  if (ctx.siteCommits === null) unread.push("edit-site and check-file commits");
  for (const c of ctx.siteCommits ?? []) {
    if (c.lane) continue;
    const onSite = !!ctx.editSitePath && c.files.includes(ctx.editSitePath);
    const onCheck = !!ctx.checkPath && c.files.includes(ctx.checkPath);
    if (!onSite && !onCheck) continue;
    const at = isoMs(c.at);
    if (at !== null && !inWindow(at)) continue;
    acts.push({ addendum: "edit-site-commit", at: at === null ? null : new Date(at).toISOString(), detail: `operator commit ${c.sha.slice(0, 8)} by ${c.author} @ ${at === null ? "unparsable time" : new Date(at).toISOString()} on the ${onSite ? "edit_site" : "check file"}` });
  }
  // an operator-authored check file
  if (ctx.checkPath) {
    if (ctx.checkFirstCommit === null) unread.push("check file history");
    else if (ctx.checkFirstCommit && !ctx.checkFirstCommit.lane) acts.push({ addendum: "check-authored", at: ctx.checkFirstCommit.at, detail: `check ${ctx.checkPath} was added by ${ctx.checkFirstCommit.author} (${ctx.checkFirstCommit.sha.slice(0, 8)} @ ${ctx.checkFirstCommit.at})` });
  }
  // gap-write events of the row and its ancestors: the arm writer, operator writes (re-arms, edits, closes), 4/4a
  if (ctx.events === null) unread.push("gap-write events");
  else {
    if (ctx.eventsCapped) unread.push("gap-write events (the read cap was reached)");
    if (ctx.eventsFromFiling !== true) unread.push("gap-write events (they do not reach back to the row's filing)");
  }
  const lineageSet = new Set(lineage);
  for (const ev of ctx.events ?? []) {
    const evGap = ev.gap_id ?? gid;
    if (!lineageSet.has(evGap)) continue;
    if (!String(ev.outcome ?? "").startsWith("written")) continue; // a refused or thrown write changed nothing
    const at = isoMs(ev.ts);
    if (at === null) { unattributable.push(`${ev.source ?? "holder"}: event time unparsable (${String(ev.ts).slice(0, 30)})`); continue; }
    if (!inWindow(at)) continue;
    const cls = classifyGapWriteEvent(ev, ev.source ?? "holder", ctx.originPresent === true, ctx.keymap ?? [], ctx.peerKeys6 ?? []);
    const isArm = (ev.fields_changed ?? []).some((f) => ARM_FIELDS.includes(f));
    const when = new Date(at).toISOString();
    const onAncestor = evGap !== gid;
    if (isArm && !onAncestor) armWrites.push({ at: when, writer: `${cls} (${ev.principal_kind ?? "?"}${ev.key_id ? `:${ev.key_id}` : ""}${ev.operator_marker ? ", marker" : ""})` });
    if (cls === "operator") {
      acts.push({ addendum: onAncestor ? "ancestor-gap-write" : isArm ? "arm" : "gap-write", on: evGap, at: when, detail: `operator gap write (${ev.source ?? "holder"}, ${ev.principal_kind ?? "?"}:${ev.key_id ?? "-"}, marker=${ev.operator_marker === true}) @ ${when} on ${onAncestor ? `ancestor ${evGap.slice(-60)}` : "this row"} fields=${(ev.fields_changed ?? []).slice(0, 4).join(",")}` });
    } else if (cls.startsWith("unattributable") || cls.startsWith("forwarded")) {
      unattributable.push(`${ev.source ?? "holder"}${onAncestor ? ` (ancestor ${evGap.slice(-40)})` : ""}: ${cls}`);
    }
    if ((ev.principal_kind === "in-process" || ev.principal_kind === "node-self") && !ev.route) routeUnverifiable += 1;
  }
  // oracle labels on the provenance traces (operator feedback there is an operator act)
  const traces = new Set<string>(provenanceTraceIds(row, ctx.traceIds ?? []));
  if (ctx.labels === null || ctx.labels === undefined || !ctx.labelContext) {
    review.push("oracle labels unread: operator feedback on a provenance trace cannot be ruled out");
  } else {
    for (const lab of ctx.labels) {
      if (!lab.execution_id || !traces.has(lab.execution_id)) continue;
      const c = classifyOracleLabel(lab, ctx.labelContext);
      if (c.startsWith("operator")) acts.push({ addendum: "operator-label", at: lab.created_at ?? null, detail: `${c} on trace ${lab.execution_id}` });
      else if (c.startsWith("review")) review.push(`${c} on trace ${lab.execution_id}`);
    }
  }
  return { acts, arm_writes: armWrites, unattributable, review, route_unverifiable: routeUnverifiable, unread };
}
