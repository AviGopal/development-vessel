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

// The operator-id readers, moved here verbatim from goal-reach-tick.ts (which re-exports them), so the evaluator
// imports nothing the lane can edit (evaluator-grant-scan).
/**
 * Operator ids MACHINE dispatchers stamp. goal-host maps any operator id to trigger "operator", so
 * these would read as a human without this list. Census of origin/dev operator literals + live
 * activeDispatches (2026-10-02): rhythm-conductor-tick.ts drain (`rhythm-conductor-drain`),
 * scripts/substrate/learning-liveness-probe.ts, scripts/substrate/substrate-status.sh (known-answer
 * probe), scripts/substrate/learning-loop-selftest-tick.ts (its PROBE_TAG, matched by prefix).
 * Human ids seen live: human-surface, claude-code-operator, codex-operator.
 */
export const MACHINE_OPERATOR_IDS: ReadonlySet<string> = new Set(["rhythm-conductor-drain", "learning-liveness-probe", "substrate-status"]);
export function isHumanOperatorId(op: unknown): boolean {
  if (typeof op !== "string") return false;
  const o = op.trim();
  if (!o) return false;
  return !MACHINE_OPERATOR_IDS.has(o) && !/^learning-loop-selftest/.test(o);
}

/**
 * The operator id a dispatch's HANDS are read from: the label its caller claimed (operator_label), else `operator` (a
 * record from before goal-host's inbound door, where the two were one field). Since the door, `operator` is AUTHORITY,
 * set only for an operator credential, so reading it alone made a person's cockpit dispatch with an ordinary key look
 * autonomous. A label is attribution only: it confers nothing, and a false claim can only take credit away from the
 * system (it marks hands), never add authority.
 */
export function handsOperatorId(d: { operator?: string | null; operator_label?: string | null }): string | null {
  const label = typeof d.operator_label === "string" && d.operator_label.trim() ? d.operator_label : null;
  return label ?? (typeof d.operator === "string" ? d.operator : null);
}

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

/**
 * What lineageAncestors could NOT read (qa eval5 B1): an ancestor it cannot see is unknown, and unknown is never clean.
 * - A link field (LINK_FIELDS) on the row, or on an ancestor reached through the links, that names an id the store read
 *   does not hold: the parent exists somewhere, unseen, so whoever filed it cannot be ruled out.
 * - A recommit row (coreId depth > 0) with no key in the store sharing its core at a lower depth: its recommit parent
 *   is not in the read.
 * Named limit of the id rule's "-" prefix half: a narrowed child whose parent is absent from the store is, by its id
 * alone, indistinguishable from a root whose id happens to contain "-", so the prefix half cannot report a missing
 * parent; only an explicit link field or a recommit- prefix can say one is missing.
 * Returns one reason per unseen ancestor; empty when the lineage was read in full.
 */
export function lineageUnknown(gid: string, byId: ReadonlyMap<string, GapRow>): string[] {
  const out: string[] = [];
  const seen = new Set<string>([gid]);
  const todo = [gid];
  while (todo.length > 0) {
    const id = todo.pop()!;
    const cur = byId.get(id);
    if (!cur) continue;
    const m = metaOf(cur);
    for (const k of LINK_FIELDS) {
      const v = m[k] || cur[k];
      if (typeof v !== "string" || v.length === 0 || v === gid) continue;
      if (!byId.has(v)) { out.push(`lineage: ${id === gid ? "the row" : `ancestor ${id.slice(-60)}`} links ${k}=${v.slice(-60)}, which is not in the gap store read`); continue; }
      if (!seen.has(v)) { seen.add(v); todo.push(v); }
    }
  }
  const g = coreId(gid);
  if (g.depth > 0 && ![...byId.keys()].some((k) => k !== gid && (() => { const c = coreId(k); return c.core === g.core && c.depth < g.depth; })())) {
    out.push(`lineage: ${gid.slice(-60)} is a recommit (depth ${g.depth}) and no row of core ${g.core.slice(-60)} at a lower depth is in the gap store read`);
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

export type OperatorActKind = "2a" | "2a-at-without-by" | "hold-undated" | "3" | "edit-site-commit" | "check-authored" | "operator-filed" | "arm" | "gap-write" | "ancestor-gap-write" | "directed" | "hand-close" | "operator-field" | "operator-label" | "s2-answer" | "operator-dispatch";
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

// ─── S-2 resolver answers (USER RULING 2026-10-22: "Autonomous if the system initiated it") ───────────────
/** One goal-host DispatchRecord.resolverAnswers[] entry (S-2 contract): answered_by_tag is the answering principal's
 *  tag, never a key id; lease_provenance and answer_id are null for a person's v1 answer by solicitation id. */
export interface ResolverAnswerLike {
  readonly request_id?: string | null;
  readonly outcome?: string | null;
  readonly at?: string | null;
  readonly answered_by_tag?: string | null;
  readonly lease_provenance?: { readonly request_id?: string | null; readonly lease_id?: string | null; readonly attempt?: number | null; readonly dispatch_id?: string | null; readonly origin?: string | null } | null;
  readonly answer_id?: string | null;
  /** GUARD, not a contract field: goal-host builds resolverAnswers itself and no answer can carry an operator marker
   *  (S-2 builder, 2026-10-22). If one ever does, it is never exempted. */
  readonly operator_marker?: boolean | null;
}
/** One goal-host dispatch record as read (GET /executions/:dispatchId or goalWalkState): its id, the execution it
 *  ran (executionId), any trace ids it lists, and its resolverAnswers[]. A walk trace is tagged dispatch:<id>, but that
 *  tag can be caller-supplied (goal-host compose-gap-id keeps a caller's variables.dispatch_id), so a record is trusted
 *  only when it names a provenance trace itself. */
export interface ResolverDispatchLike {
  readonly dispatch_id: string;
  readonly execution_id?: string | null;
  readonly trace_ids?: ReadonlyArray<string> | null;
  readonly resolverAnswers?: ReadonlyArray<ResolverAnswerLike> | null;
}
/** goal-host's resolverRequest record (the lease record, read at use time), the fields addendum 8 reads. */
export interface ResolverRequestLike {
  readonly request_id: string;
  readonly origin?: string | null;
  readonly dispatch_id?: string | null;
  readonly attempts?: ReadonlyArray<{ readonly attempt?: number | null; readonly lease_id?: string | null; readonly granted_at?: string | null; readonly expires_at?: string | null; readonly ended_at?: string | null; readonly answer_binding?: { readonly answer_id?: string | null; readonly accepted_at?: string | null } | null }> | null;
}
/**
 * PREREG ADDENDUM 8 — S-2 RESOLVER ANSWERS (research's rule text, verbatim; the research instrument cites the same).
 *
 * Scope: every entry of DispatchRecord.resolverAnswers[] on a dispatch record that names the gap. Each entry is
 * classified as exactly one of SYSTEM, UNATTRIBUTABLE or OPERATOR.
 * UNATTRIBUTABLE if the entry is not a readable record, or if the resolverRequest record named by its
 * lease_provenance.request_id cannot be read.
 * Otherwise it is SYSTEM only if ALL of the following hold, and OPERATOR in every other case:
 * (a) neither the entry nor its lease_provenance carries an operator marker;
 * (b) lease_provenance is present and answer_id is non-empty;
 * (c) the entry's request_id equals lease_provenance.request_id;
 * (d) lease_provenance.origin is "system";
 * (e) the request record's origin is "system" and its dispatch_id equals lease_provenance.dispatch_id;
 * (f) the request has an attempt whose attempt AND lease_id both equal lease_provenance's;
 * (g) that attempt's answer_binding has a non-empty answer_id equal to the entry's answer_id, and a non-empty
 *     accepted_at;
 * (h) the entry's `at` parses as a time;
 * (i) the attempt has granted_at, and has ended_at or, absent that, expires_at;
 * (j) granted_at ≤ at ≤ (ended_at, else expires_at).
 * answered_by_tag is never used to classify. Origin is read only from the server-stamped provenance and request record.
 * Until S-4, any non-node-self key reads as operator origin.
 * Effect on the autonomy count: any OPERATOR entry is an operator act in the fix's provenance (ASSISTED). Any
 * UNATTRIBUTABLE entry makes link 5 UNATTRIBUTABLE. SYSTEM entries are counted as system, and the count is named in
 * the link evidence.
 *
 * Read-path precondition (this reader): a dispatch record's answers are in scope only when the record itself names one
 * of the closure's provenance traces (a dispatch:<id> tag can be caller-supplied); an untrusted or unread record is
 * UNATTRIBUTABLE. The operator marker of (a) is a guard: goal-host builds resolverAnswers itself and none carries one.
 */
export type S2AnswerClass = "SYSTEM" | "UNATTRIBUTABLE" | "OPERATOR";
export function classifyS2Answer(entry: unknown, requests: ReadonlyMap<string, ResolverRequestLike> | null | undefined): { cls: S2AnswerClass; clause: string | null; why: string } {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { cls: "UNATTRIBUTABLE", clause: null, why: "the entry is not a readable record" };
  const a = entry as ResolverAnswerLike;
  const prov = a.lease_provenance && typeof a.lease_provenance === "object" ? a.lease_provenance as NonNullable<ResolverAnswerLike["lease_provenance"]> & { operator_marker?: unknown } : null;
  const rid = prov && typeof prov.request_id === "string" ? prov.request_id : null;
  const req = rid !== null ? requests?.get(rid) : undefined;
  if (rid !== null && !req) return { cls: "UNATTRIBUTABLE", clause: null, why: `resolverRequest ${rid} cannot be read` };
  // UNATTRIBUTABLE is decided above, BEFORE clauses (a)-(j): a marked answer whose request cannot be read is
  // UNATTRIBUTABLE, not OPERATOR(a). An absent lease_provenance names no request, so it is not unreadable: OPERATOR(b).
  const op = (clause: string, why: string) => ({ cls: "OPERATOR" as const, clause, why: `S-2 clause (${clause}) unmet: ${why}` });
  if (a.operator_marker === true || prov?.operator_marker === true) return op("a", "an operator marker is carried");
  if (!prov || typeof a.answer_id !== "string" || a.answer_id.length === 0) return op("b", "no lease_provenance or no answer_id");
  if (a.request_id !== prov.request_id) return op("c", "the entry's request_id differs from lease_provenance.request_id");
  if (prov.origin !== "system") return op("d", `lease_provenance.origin is ${JSON.stringify(prov.origin ?? null)}`);
  if (!req || req.origin !== "system" || req.dispatch_id !== prov.dispatch_id) return op("e", `the request record's origin is ${JSON.stringify(req?.origin ?? null)} or its dispatch_id differs from lease_provenance.dispatch_id`);
  const att = (req.attempts ?? []).find((x) => !!x && x.attempt === prov.attempt && x.lease_id === prov.lease_id);
  if (!att) return op("f", `no attempt with attempt ${String(prov.attempt)} and lease_id ${String(prov.lease_id)}`);
  const ab = att.answer_binding;
  if (!ab || typeof ab.answer_id !== "string" || ab.answer_id.length === 0 || ab.answer_id !== a.answer_id || typeof ab.accepted_at !== "string" || ab.accepted_at.length === 0) return op("g", "the attempt's answer_binding does not bind this answer_id with an accepted_at");
  const t = isoMs(a.at);
  if (t === null) return op("h", "the entry's at does not parse");
  const end = att.ended_at ?? att.expires_at;
  const g = isoMs(att.granted_at), e = isoMs(end);
  if (g === null || e === null) return op("i", "the attempt lacks granted_at, or both ended_at and expires_at");
  if (!(g <= t && t <= e)) return op("j", "at is outside granted_at to (ended_at, else expires_at)");
  return { cls: "SYSTEM", clause: null, why: `the bound answer ${a.answer_id} of system-initiated request ${rid} (lease ${String(prov.lease_id)}, attempt ${String(prov.attempt)})` };
}

// ─── link 5: who RAN a dispatch (USER RULING 2026-10-22: "Yes, iff we ran it. Boredom, detectors or other ────
// instigators do not count."; qa refinement and USER RULING "Keep strict: unattributable (Recommended)") ─────────
/**
 * research's link-5 rule (autonomy6 dispatcher_class + operator_dispatches_naming), matched case for case against its
 * frozen parity fixtures (test/self-fact-evaluator/fixtures/parity-link5-fixtures.json). WHO RAN IT, from the
 * server-stamped principal first:
 *  - principal kind "key": the key's class in the key class map decides. operator => OURS. system => the claimed label
 *    decides (a human label => OURS, a system id or no label => SYSTEM). Unlisted or ambiguous => OURS (strict).
 *  - principal kind node_self: a human label (operator_label only) => OURS, else SYSTEM.
 *  - a principal of any other kind (session, admin, obo, or none named) => OURS (strict).
 *  - no principal (records from before goal-host's inbound door): the claimed tag (operator_label, else operator):
 *    a system id => SYSTEM, any other non-empty id => OURS (unknown counts), no tag at all => UNATTRIBUTABLE.
 *  - a record that is not an object => UNATTRIBUTABLE.
 * "Human" reuses goal-reach-tick's isHumanOperatorId test (a non-empty id outside the system dispatchers, not prefixed
 * learning-loop-selftest), over SYSTEM_DISPATCHER_IDS: MACHINE_OPERATOR_IDS plus the system minters it misses
 * (operator:expectation-scan, dv index.ts expectation scan, and its bare form expectation-scan).
 * NAMING (operator_dispatches_naming): a record names the gap when its JSON text contains the gap id, or the edit_site
 * in its qualified forms "repos/<vessel>/<path>" or "<vessel>/<path>" (never the bare vessel-relative path), each name
 * counted only when longer than 8 characters. A SYSTEM dispatch yields nothing. A dispatch whose start (epoch ms, or a
 * time) is outside the window yields nothing; an unreadable start stays in. A store text that cannot be parsed yields one
 * UNATTRIBUTABLE finding when it contains any name.
 */
export const SYSTEM_DISPATCHER_IDS: ReadonlySet<string> = new Set([...MACHINE_OPERATOR_IDS, "operator:expectation-scan", "expectation-scan"]);
const humanDispatcher = (op: unknown): boolean => {
  const o = typeof op === "string" ? op.trim() : "";
  return !!o && isHumanOperatorId(o) && !SYSTEM_DISPATCHER_IDS.has(o);
};
export type DispatchRunBy = "OURS" | "SYSTEM" | "UNATTRIBUTABLE";
/** The class of the key a dispatch principal names (its label "key:<keyId>", or key_id), from the key class map: one
 *  entry equal to the id, or one masked entry (12 characters or more) the id begins with; none or more than one is
 *  unlisted or ambiguous (null). */
function dispatchKeyClass(kid: string, keymap: readonly KeyMapEntry[]): string | null {
  if (!kid) return null;
  const hits = keymap.filter((k) => k.id === kid || (k.id.length >= 12 && kid.startsWith(k.id)));
  return hits.length === 1 ? String(hits[0]!.owner_kind) : null;
}
/** Who ran one dispatch record (research's dispatcher_class). */
export function dispatchRunBy(rec: unknown, keymap: readonly KeyMapEntry[] = []): { by: DispatchRunBy; why: string } {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return { by: "UNATTRIBUTABLE", why: "the record is not an object" };
  const r = rec as Record<string, unknown>;
  const label = typeof r["operator_label"] === "string" && (r["operator_label"] as string).trim() ? (r["operator_label"] as string) : null;
  const pr = r["principal"] && typeof r["principal"] === "object" && !Array.isArray(r["principal"]) ? (r["principal"] as Record<string, unknown>) : null;
  if (pr) {
    const kind = String(pr["kind"] || pr["principal_kind"] || "");
    if (kind === "node_self") return humanDispatcher(label) ? { by: "OURS", why: `node_self principal, human label ${label}` } : { by: "SYSTEM", why: `node_self principal, label ${label ?? "absent"}` };
    if (kind === "key") {
      const raw = String(pr["label"] || pr["key_id"] || "");
      const kid = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
      const kc = dispatchKeyClass(kid, keymap);
      if (kc === "system") return humanDispatcher(label) ? { by: "OURS", why: `system-class key, human label ${label}` } : { by: "SYSTEM", why: `system-class key, label ${label ?? "absent"}` };
      return { by: "OURS", why: `key principal, ${kc === "operator" ? "operator-class" : "unlisted or ambiguous"} key (strict)` };
    }
    return { by: "OURS", why: `principal kind ${kind || "unnamed"} (strict)` };
  }
  const tag = label ?? (typeof r["operator"] === "string" ? (r["operator"] as string) : null);
  if (tag && tag.trim()) return humanDispatcher(tag) ? { by: "OURS", why: `no principal, tag ${tag}` } : { by: "SYSTEM", why: `no principal, system tag ${tag}` };
  return { by: "UNATTRIBUTABLE", why: "no principal and no tag: who ran it cannot be read" };
}
/** A dispatch store entry as read: a parsed record, or the store text (one record or a list) not yet parsed. */
export type DispatchStoreEntry = Record<string, unknown> | string;
export interface DispatchFinding { readonly finding: "operator" | "unattributable"; readonly detail: string; readonly at: string | null }
/** research's operator_dispatches_naming: one finding per dispatch OUR side ran, or whose initiator cannot be read,
 *  whose record names the gap inside the window (null = no time filter). Pure. */
export function link5DispatchFindings(entries: ReadonlyArray<DispatchStoreEntry>, gapId: string, editSite: string, window: readonly [number, number] | null, keymap: readonly KeyMapEntry[] = []): DispatchFinding[] {
  const site = editSite || "";
  const names = [...new Set([gapId, site, site.startsWith("repos/") ? site.slice("repos/".length) : ""])].filter((n) => n && n.length > 8);
  const out: DispatchFinding[] = [];
  for (const e of entries) {
    let recs: unknown[];
    if (typeof e === "string") {
      let parsed: unknown;
      try { parsed = JSON.parse(e); } catch {
        if (names.some((n) => e.includes(n))) out.push({ finding: "unattributable", detail: "a dispatch store text that cannot be parsed names the gap or its edit_site", at: null });
        continue;
      }
      recs = Array.isArray(parsed) ? parsed : [parsed];
    } else recs = [e];
    for (const rec of recs) {
      const text = JSON.stringify(rec) ?? "";
      const hit = names.find((n) => text.includes(n));
      if (!hit) continue;
      const cls = dispatchRunBy(rec, keymap);
      if (cls.by === "SYSTEM") continue;
      const r = rec && typeof rec === "object" ? (rec as Record<string, unknown>) : null;
      const started = r ? (r["startedAt"] ?? r["started_at"]) : undefined;
      const st = typeof started === "number" && started > 1e11 ? started : isoMs(started);
      if (window && r && st !== null && !(window[0] <= st && st <= window[1])) continue;
      out.push({ finding: cls.by === "OURS" ? "operator" : "unattributable", at: st === null ? null : new Date(st).toISOString(),
        detail: `link 5 dispatch ${String(r?.["dispatchId"] ?? "?")}: ${cls.by} (${cls.why}), naming ${hit === gapId ? "the id" : `its edit_site ${hit}`}` });
    }
  }
  return out;
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
  /** Oracle labels on the provenance traces. null: unreadable, so operator feedback cannot be ruled out (UNATTRIBUTABLE). */
  readonly labels?: ReadonlyArray<OracleLabelLike & { readonly execution_id?: string | null }> | null;
  readonly labelContext?: LabelClassContext | null;
  /** The key class map. null or absent: no map, so a key-principal write is unattributable. */
  readonly keymap?: readonly KeyMapEntry[] | null;
  /** The goal-host dispatch records the provenance traces are tagged with (dispatch:<id>), each with its
   *  resolverAnswers[]. null: unread, so an operator answer cannot be ruled out (said in `unread`); undefined: not asked. */
  readonly resolverDispatches?: ReadonlyArray<ResolverDispatchLike> | null;
  /** goal-host's dispatch store entries (link 5 "who ran it"): parsed records or store texts. null: unread, so link 5
   *  is UNATTRIBUTABLE; undefined: not asked. */
  readonly dispatches?: ReadonlyArray<DispatchStoreEntry> | null;
  /** goal-host's resolverRequest records, by request_id (classifyS2Answer). A request not here cannot be read:
   *  its answers are UNATTRIBUTABLE. */
  readonly resolverRequests?: ReadonlyMap<string, ResolverRequestLike> | null;
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
  /** S-2 answers classified SYSTEM under PREREG ADDENDUM 8 (the count named in link 5's evidence). */
  readonly s2_system_answers?: string[];
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
  const s2Answers: string[] = [];
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
  // An ancestor the store read does not hold is unknown (lineageUnknown): its filer and its acts cannot be ruled out.
  unread.push(...lineageUnknown(gid, byId));
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
  // link 5: dispatches naming the gap that our side RAN (link5DispatchFindings): an operator finding is an operator act,
  // an unattributable one makes link 5 unattributable; a SYSTEM dispatch does not count.
  if (ctx.dispatches === null) unattributable.push("link 5 dispatch: the dispatch store cannot be read");
  for (const f of link5DispatchFindings(ctx.dispatches ?? [], gid, String(m["edit_site"] ?? ""), filedMs === null && untilMs === null ? null : [filedMs ?? Number.NEGATIVE_INFINITY, untilMs ?? Number.POSITIVE_INFINITY], ctx.keymap ?? [])) {
    if (f.finding === "operator") acts.push({ addendum: "operator-dispatch", at: f.at, detail: f.detail });
    else unattributable.push(f.detail);
  }
  // S-2 resolver answers (PREREG ADDENDUM 8, see classifyS2Answer): OPERATOR is an operator act, UNATTRIBUTABLE makes
  // link 5 unattributable, SYSTEM is counted as system and named in the evidence.
  if (ctx.resolverDispatches === null) unattributable.push("S-2 resolver answers: the dispatch records cannot be read");
  const provTraces = new Set<string>(provenanceTraceIds(row, ctx.traceIds ?? []));
  for (const d of ctx.resolverDispatches ?? []) {
    // A dispatch:<id> tag is not proof: the record itself must name one of this closure's provenance traces.
    const names = [d.execution_id, ...(d.trace_ids ?? [])].filter((x): x is string => typeof x === "string" && x.length > 0);
    if (!names.some((x) => provTraces.has(x))) { unattributable.push(`S-2 dispatch ${d.dispatch_id}: its record names no provenance trace (executionId ${d.execution_id ?? "none"}), so its tag cannot be trusted`); continue; }
    if (!Array.isArray(d.resolverAnswers)) { unattributable.push(`S-2 resolver answers of dispatch ${d.dispatch_id} cannot be read`); continue; }
    for (const a of d.resolverAnswers) {
      const c = classifyS2Answer(a, ctx.resolverRequests);
      const req = String((a as ResolverAnswerLike | null)?.request_id ?? "?");
      if (c.cls === "SYSTEM") s2Answers.push(c.why);
      else if (c.cls === "UNATTRIBUTABLE") unattributable.push(`S-2 answer on request ${req} (dispatch ${d.dispatch_id}): UNATTRIBUTABLE, ${c.why}`);
      else { const at = isoMs((a as ResolverAnswerLike).at); acts.push({ addendum: "s2-answer", at: at === null ? null : new Date(at).toISOString(), detail: `S-2 answer on request ${req} (dispatch ${d.dispatch_id}): ${c.why}` }); }
    }
  }
  // oracle labels on the provenance traces (operator feedback there is an operator act)
  const traces = new Set<string>(provenanceTraceIds(row, ctx.traceIds ?? []));
  if (ctx.labels === null || ctx.labels === undefined || !ctx.labelContext) {
    // UNATTRIBUTABLE, the PREREG/autonomy6 word for an unread input (qa parity ruling); a label that IS read and classes
    // review stays REVIEW below.
    unattributable.push("oracle labels unread: unattributable, operator feedback on a provenance trace cannot be ruled out");
  } else {
    for (const lab of ctx.labels) {
      if (!lab.execution_id || !traces.has(lab.execution_id)) continue;
      const c = classifyOracleLabel(lab, ctx.labelContext);
      if (c.startsWith("operator")) acts.push({ addendum: "operator-label", at: lab.created_at ?? null, detail: `${c} on trace ${lab.execution_id}` });
      else if (c.startsWith("review")) review.push(`${c} on trace ${lab.execution_id}`);
    }
  }
  return { acts, arm_writes: armWrites, unattributable, review, route_unverifiable: routeUnverifiable, unread, s2_system_answers: s2Answers };
}
