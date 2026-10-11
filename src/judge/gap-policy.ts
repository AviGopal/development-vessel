/**
 * GAP POLICY (gap-judge-core, closed). This module holds the readers and gates for the policy records that govern
 * autonomous work:
 * - the autonomy scope (autonomyScope, autonomyScopeExcludes, autonomyScopeFloor, tightening holds);
 * - the spend envelope (spendEnvelopeAllows);
 * - own-substrate producer trust (discoverOwnResolveUrls, isOwnSubstrateProducer);
 * - vessel ownership (ownedVessels, identifyVessel).
 *
 * Moved verbatim out of src/resolvers/gap-to-feature.ts (the gap-to-feature judge split, BOUNDARY.md 1.2). Closed files
 * read these to decide what the lane may touch: the cutover's scope chokepoint, feature-compose's scope floor,
 * scope-earn-in, self-fact-reconcile, gap-lifecycle-scan, rhythm-conductor-tick, substrate-gap and
 * apply-proposal-as-patch. A lane edit to them would change what the closed files treat as excluded or affordable.
 */
import { existsSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { gapLineageRoot } from "../resolvers/staged-mitosis-gate.js";
import { METABOB_API_KEY, lookupShape, describeLookup, discoveryFailureBackoffMs, __resetDiscoveryForTests } from "../config.js";
import { evaluatorTreeRoot } from "../lib/evaluator-tree.js";

// The evaluator's tree (lib/evaluator-tree.ts), the same alias gap-to-feature uses.
const runtimeRoot = evaluatorTreeRoot;

/** Resolve the vessel directory under the runtime root, returning the repos/<vessel> rel path. */
export function vesselDirExists(vessel: string): boolean {
  try {
    return statSync(join(runtimeRoot(), vessel)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Identify the target vessel for a gap. Order: explicit metadata.vessel, then an
 * edit-site/file_path's repos/<vessel>/ or /vessels/<vessel>/ prefix, then a vessel name
 * embedded in the gap id ("responsibility-<vessel>-…", "<…>-<vessel>-…"). Returns a
 * vessel dir name that EXISTS under the runtime root, else null.
 */
export function identifyVessel(gap: Record<string, unknown>, meta: Record<string, unknown>): string | null {
  // 1. explicit metadata.vessel
  const mv = typeof meta.vessel === "string" ? meta.vessel.trim() : "";
  if (mv && vesselDirExists(mv)) return mv;
  // 2. a path field already names the vessel
  for (const f of ["edit_site", "file_path", "change_site", "path"]) {
    const v = meta[f];
    if (typeof v === "string") {
      const m = v.match(/(?:^|\/)(?:repos|vessels)\/([^/]+)\//);
      if (m && m[1] && vesselDirExists(m[1])) return m[1];
    }
  }
  // 3. vessel name embedded in the gap id. Match the LONGEST existing vessel dir whose
  //    name appears as a hyphen-bounded token run in the id (so "goal-host-vessel" wins
  //    over "vessel"). Only consider dirs that look like vessels (end with "-vessel" or
  //    "-api", or are a known top-level vessel) to avoid spurious single-word matches.
  const id = String(gap.id ?? "");
  let best: string | null = null;
  try {
    const dirs = readdirSync(runtimeRoot()).filter((d) => {
      try { return statSync(join(runtimeRoot(), d)).isDirectory(); } catch { return false; }
    });
    for (const d of dirs) {
      if (!/-(vessel|api)$/.test(d) && !/^(activity-api|goal-host-vessel)$/.test(d)) continue;
      // hyphen-bounded: "-<dir>-" or "-<dir>" at end, or "<dir>-" at start
      if (new RegExp(`(?:^|-)${d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:-|$)`).test(id)) {
        if (!best || d.length > best.length) best = d;
      }
    }
  } catch { /* readdir best-effort */ }
  return best;
}

// Call-time (not module-load) so tests can point at a fixture clone tree; production
// never sets the override and uses the same path as the other clone readers here.
export const vesselsCloneRoot = (): string => process.env["VESSELS_CLONE_ROOT"] ?? "/workspace/git/vessels";

// Unit directories a mask can live in (persistent /etc, runtime /run); call-time so tests can point at a fixture.
export const systemdUnitDirs = (): string[] => (process.env["SYSTEMD_UNIT_DIRS"] ?? "/etc/systemd/system:/run/systemd/system").split(":").filter(Boolean);

/** Whether this node has MASKED the vessel's unit (<vessel>.service is a symlink to /dev/null). An unreadable
 *  directory or a vessel with no unit (a library clone) is not masked. */
export function vesselUnitMasked(vessel: string): boolean {
  for (const dir of systemdUnitDirs()) {
    try { if (readlinkSync(join(dir, `${vessel}.service`)) === "/dev/null") return true; } catch { /* absent, not a link, or unreadable */ }
  }
  return false;
}

// A NODE OWNS COMPOSES ONLY FOR VESSELS IT RUNS (2026-10-07). Clone presence alone let compose2, which masks
// activity-api, compose and land activity-api code it never serves (its landings can never be verified there).
// A vessel whose unit is masked here is not owned, whatever SUBSTRATE_PUSH_VESSELS says.
export function ownedVessels(): Set<string> {
  try {
    const present = readdirSync(vesselsCloneRoot()).filter((d) => existsSync(join(vesselsCloneRoot(), d, ".git")));
    const declared = (process.env["SUBSTRATE_PUSH_VESSELS"] ?? "").split(/[\s,]+/).filter(Boolean);
    return new Set((declared.length > 0 ? present.filter((d) => declared.includes(d)) : present).filter((d) => !vesselUnitMasked(d)));
  } catch {
    return new Set();
  }
}

// SPEND ENVELOPE (value-per-cost-selection 4.1/4.2). Autonomous spending obeys one hourly USD
// envelope read at use time as a shaped impulse: the newest open poolImpulse of shape
// `spendEnvelope` ({usd_cap_per_hour, paused, reason}) across every poolImpulse producer of THIS
// substrate (discoverOwnResolveUrls: a peer substrate's producers never count), so a record written
// on either node binds both. Spent = the sum over every
// distinct llmSpendSummary producer of its current window plus the unexpired share of its
// previous window (a sliding hour). NO CAP IS ONLY EVER EXPLICIT: a record {uncapped: true}
// (and not paused) allows without a cap. Every own producer answering with no spendEnvelope
// record is ABSENT, and absent refuses exactly like unreadable (`absent: true` names which): a
// node that holds no record of its own must not read "no record" as "no cap" (10-01, node 2).
// A record with neither a finite usd_cap_per_hour nor uncapped:true, or with both, refuses too.
// A discovered producer that does not answer makes the envelope UNREADABLE, and unreadable
// blocks (fail closed): a partial read could miss the one node that holds the pause.
// Cached for SPEND_ENVELOPE_TTL_MS so a gap-write burst costs one read.
// `lookup_failed` marks an unreadable verdict whose cause was discovery itself (timeout, network,
// 5xx), as opposed to a discovery answer naming no producer: both fail closed, but only the second
// says anything about the fleet.
// FAIR SHARE (value-per-cost-selection 4.5), optional fields on the same record, each absent = off:
//   lineage_usd_cap_per_window + lineage_window_s (default 3600): a gap lineage that has spent the
//     ceiling inside the window without landing is held from auto-pick (lineageSpendHeld), so one
//     low-yield lineage cannot drain the shared cap;
//   max_node_share (0 < f <= 1): this node refuses once ITS OWN spend reaches f x cap, leaving the rest of
//     the shared cap to the other nodes (`node_share_exhausted`). Not yield-weighted: no per-node landing
//     count is read here (5.3 remains open for that).
// A field that is present but not a positive finite number (or a share above 1) is a misconfiguration and
// refuses like a non-finite cap. The global cap stays the hard ceiling either way.
export type SpendEnvelopeVerdict = { allow: boolean; reason: string; unreadable?: boolean; absent?: boolean; lookup_failed?: boolean; paused?: boolean; cap_usd?: number; spent_usd?: number; spend_sources?: number; lineage_usd_cap?: number; lineage_window_ms?: number; max_node_share?: number; own_spent_usd?: number; node_share_exhausted?: boolean };
const SPEND_ENVELOPE_TTL_MS = 30_000;
// An UNREADABLE policy verdict is remembered only as long as a failed discovery lookup is, so the
// next read after a slow peer re-reads instead of refusing for 30 s on one timeout (09-30, node 2).
const policyUnreadableRetryMs = (): number => discoveryFailureBackoffMs();
let spendEnvelopeCache: { at: number; v: SpendEnvelopeVerdict } | null = null;
// An UNREADABLE envelope always refuses, and so does an ABSENT one (a read that succeeded and found
// no spendEnvelope record on any own producer): "no cap" is a record that says {uncapped: true},
// never the lack of one. Whether a record was ever seen is process memory, false at every start,
// so no refusal may be gated on it (it failed open after every restart whose first read failed).
/** The resolve URL of every producer of `shape`, through the shared discovery client. A lookup
 *  that could not be answered comes back as `{ok:false}` with its reason, never as an empty list. */
export async function discoverResolveUrls(shape: string): Promise<{ ok: true; urls: string[] } | { ok: false; why: string }> {
  const r = await lookupShape(shape);
  if (!r.ok) return { ok: false, why: describeLookup(r) };
  return { ok: true, urls: [...new Set(r.producers.map((p) => p.resolveEndpoint).filter((u) => u.length > 0))] };
}

// OWN-SUBSTRATE PRODUCERS ONLY (substrate-local policy reads). Discovery unions this node's producers
// with every federated peer's, so "the newest record across every poolImpulse producer" let a PEER
// substrate set OUR autonomy scope and spend envelope by writing a permissive record with a later
// updated_at. The policy readers below take a producer only when it is provably this substrate's:
//   - origin "local": served from this node's own discovery registry, or
//   - origin "peer:<E>" with E in this substrate's node list AND origin_upstream "local": served from
//     the registry of a node of this same substrate (not merely relayed through one, which is how a
//     third substrate's rows reach node 2 via node 1).
// Everything else is foreign: other peers, libp2p facades ("overlay"), and every UNSTAMPED row (an
// older discovery that names no origin is not provably anyone's, so it fails closed, never open).
// The node list is itself a shaped record read at use time (law 1): the newest open poolImpulse of
// shape `substrateNodes` ({discovery_endpoints: string[], reason}), read from LOCAL-origin producers
// only, since a list read through peers could be written by the very peer it is meant to exclude.
// No record = an empty list: peer rows are refused and local rows are still own, so a standalone node
// never halts on it (a node of a multi-node substrate then reads only its own pool until the list is
// written). An UNREADABLE list fails the policy read closed. It is read only when discovery returned a
// peer row that could be own (a listed node's local row), so a standalone node never reads it. Cached
// like the scope.
export type OwnProducerView = { origin?: string; originUpstream?: string | null };
const endpointKey = (e: string): string => {
  const t = String(e).trim();
  try { const u = new URL(t); if (u.protocol === "http:" || u.protocol === "https:") return u.origin; } catch { /* not a URL */ }
  return t.replace(/\/+$/, "");
};
// A FUTURE libp2p POLICY PRODUCER FAILS CLOSED. Discovery stamps a libp2p row in its own registry
// "overlay" (a facade for a vessel served elsewhere), and "overlay" is never own here. If this
// substrate ever serves poolImpulse over libp2p from one of its own nodes, these reads will refuse that
// producer (and, if it is the only one, read unreadable) until the overlay origin is classified: e.g.
// discovery stamping an own-substrate overlay row by an attested peer id. Do not widen this predicate to
// accept "overlay" without that classification; an overlay row is registered on behalf of a remote peer.
// origin_upstream is read ONLY here, as the claim of a node already in the list; nothing else may treat
// it as an identity.
/** True iff a discovered producer is this substrate's own (see above). Unstamped rows are never own. */
export function isOwnSubstrateProducer(p: OwnProducerView, nodeEndpoints: readonly string[]): boolean {
  if (p.origin === "local") return true;
  if (typeof p.origin !== "string" || !p.origin.startsWith("peer:")) return false;
  if (p.originUpstream !== "local") return false;
  const asked = endpointKey(p.origin.slice("peer:".length));
  return nodeEndpoints.some((e) => endpointKey(e) === asked);
}
type SubstrateNodes = { ok: true; endpoints: string[]; reason: string } | { ok: false; why: string };
const SUBSTRATE_NODES_TTL_MS = 30_000;
let substrateNodesCache: { at: number; v: SubstrateNodes } | null = null;
/** This substrate's discovery endpoints, from the newest open `substrateNodes` poolImpulse on LOCAL producers. */
export async function substrateNodeEndpoints(): Promise<SubstrateNodes> {
  if (substrateNodesCache && Date.now() - substrateNodesCache.at < (substrateNodesCache.v.ok ? SUBSTRATE_NODES_TTL_MS : policyUnreadableRetryMs())) return substrateNodesCache.v;
  let v: SubstrateNodes;
  try {
    const r = await lookupShape("poolImpulse");
    if (!r.ok) {
      v = { ok: false, why: "substrateNodes unreadable: " + describeLookup(r) };
      console.log(policyReadLine("substrateNodes", { asked: [], verdict: `unreadable (${v.why})` }));
    } else {
      const local = policyProducers(r.producers.filter((p) => (p as OwnProducerView).origin === "local"));
      if (local.length === 0) {
        v = { ok: false, why: `substrateNodes unreadable: no local-origin poolImpulse producer (${r.producers.length} non-local ignored)` };
        console.log(policyReadLine("substrateNodes", { asked: local, verdict: `unreadable (${v.why})` }));
      } else {
        const read = await readNewestPoolRecord("substrateNodes", local);
        if (read.silent.length > 0) {
          v = { ok: false, why: "substrateNodes unreadable: no answer from " + read.silent[0]!.url };
          console.log(policyReadLine("substrateNodes", { asked: local, answered: read.answered, verdict: `unreadable (${v.why})` }));
        } else {
          const raw = (read.newest?.body as { discovery_endpoints?: unknown } | undefined)?.discovery_endpoints;
          const endpoints = Array.isArray(raw) ? raw.filter((e): e is string => typeof e === "string" && e.trim().length > 0).map(endpointKey) : [];
          v = { ok: true, endpoints, reason: read.newest ? `substrateNodes: ${endpoints.length} node endpoint(s)` : "no substrateNodes record (local producers only)" };
          console.log(policyReadLine("substrateNodes", { asked: local, answered: read.answered, found: !!read.newest, entries: endpoints.length, verdict: read.newest ? `${endpoints.length} node endpoint(s)` : "no node list: peer rows refused, local rows only" }));
        }
      }
    }
  } catch (err) {
    v = { ok: false, why: "substrateNodes unreadable: " + String(err) };
  }
  substrateNodesCache = { at: Date.now(), v };
  return v;
}
/** discoverResolveUrls restricted to this substrate's own producers. A failed lookup, or an unreadable
 *  node list, is `{ok:false}`; `foreign` counts the producers set aside. */
export async function discoverOwnResolveUrls(shape: string): Promise<{ ok: true; urls: string[]; producers: PolicyProducer[]; foreign: number } | { ok: false; why: string; lookup_failed: boolean }> {
  const r = await lookupShape(shape);
  if (!r.ok) return { ok: false, why: describeLookup(r), lookup_failed: true };
  // The node list matters only for a peer row that could be own (a listed node's local row). With
  // none, it is not read: a standalone node's reads never depend on it.
  const mayBeOwnPeer = r.producers.some((p) => { const v = p as OwnProducerView; return typeof v.origin === "string" && v.origin.startsWith("peer:") && v.originUpstream === "local"; });
  let nodeEndpoints: string[] = [];
  if (mayBeOwnPeer) {
    const nodes = await substrateNodeEndpoints();
    if (!nodes.ok) return { ok: false, why: nodes.why, lookup_failed: false };
    nodeEndpoints = nodes.endpoints;
  }
  const own = r.producers.filter((p) => isOwnSubstrateProducer(p as OwnProducerView, nodeEndpoints));
  const producers = policyProducers(own);
  return { ok: true, urls: producers.map((p) => p.url), producers, foreign: r.producers.length - own.length };
}
// A policy producer as the read logs it: its resolve URL and the origin discovery stamped on it.
type PolicyProducer = { url: string; origin: string };
const policyProducers = (ps: ReadonlyArray<{ resolveEndpoint: string }>): PolicyProducer[] => {
  const seen = new Map<string, PolicyProducer>();
  for (const p of ps) if (p.resolveEndpoint.length > 0 && !seen.has(p.resolveEndpoint)) seen.set(p.resolveEndpoint, { url: p.resolveEndpoint, origin: String((p as OwnProducerView).origin ?? "unstamped") });
  return [...seen.values()];
};
type PoolRecord = { shape?: string; updated_at?: string; body?: unknown };
/** The newest open pool record of `shape` across `producers`, read in parallel. `silent` lists every
 *  producer that gave no answer (the read is then unreadable); `newest` is null when none holds one. */
async function readNewestPoolRecord(shape: string, producers: readonly PolicyProducer[]): Promise<{ answered: PolicyProducer[]; silent: PolicyProducer[]; newest: PoolRecord | null }> {
  const res = await Promise.all(producers.map((p) => postEnvelopeRead(p.url, { impulse: { type: "poolImpulse", shape, status: "open" } })));
  const answered: PolicyProducer[] = [];
  const silent: PolicyProducer[] = [];
  let newest: PoolRecord | null = null;
  producers.forEach((p, i) => {
    const imps = (res[i]?.["body"] as { impulses?: unknown } | undefined)?.impulses;
    if (!Array.isArray(imps)) { silent.push(p); return; }
    answered.push(p);
    for (const imp of imps as PoolRecord[]) {
      if (imp.shape === shape && (!newest || String(imp.updated_at ?? "") > String(newest.updated_at ?? ""))) newest = imp;
    }
  });
  return { answered, silent, newest };
}
// ONE JOURNAL LINE PER POLICY READ (on cache refresh, never per cached use): which own producers were
// asked (count + origins), which answered, whether a record was found and how many entries it holds,
// and the verdict. "Readable but empty" is a line of its own (record ABSENT among N answering own
// producers -> closed), so a node reading no policy is visible in the journal, never silent.
const describeProducers = (ps: readonly PolicyProducer[]): string => `${ps.length} [${ps.map((p) => p.origin).join(", ")}]`;
export function policyReadLine(shape: string, a: { asked: readonly PolicyProducer[]; answered?: readonly PolicyProducer[]; found?: boolean; entries?: number; verdict: string }): string {
  const answered = a.answered ? `answered ${describeProducers(a.answered)}` : "answered -";
  const record = a.found === undefined ? "record -" : a.found ? `record found (${a.entries ?? 0} entr${a.entries === 1 ? "y" : "ies"})` : `record ABSENT among ${a.answered?.length ?? 0} answering own producer(s)`;
  return `[policy-read] ${shape}: asked ${describeProducers(a.asked)} own producer(s); ${answered}; ${record} → ${a.verdict}`;
}
const foreignNote = (n: number): string => (n > 0 ? ` (${n} non-own producer(s) ignored)` : "");

/** Tests only: forget the policy verdicts and every remembered discovery lookup (a fresh process). */
export function __resetPolicyReadsForTests(): void {
  spendEnvelopeCache = null;
  autonomyScopeCache = null;
  substrateNodesCache = null;
  __resetDiscoveryForTests();
}
export async function postEnvelopeRead(url: string, body: unknown): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch { return null; }
}
async function readSpendEnvelope(): Promise<SpendEnvelopeVerdict> {
  const [pool, spend] = await Promise.all([discoverOwnResolveUrls("poolImpulse"), discoverOwnResolveUrls("llmSpendSummaryNode")]);
  if (!pool.ok) {
    const v: SpendEnvelopeVerdict = { allow: false, unreadable: true, ...(pool.lookup_failed ? { lookup_failed: true } : {}), reason: "envelope unreadable: " + pool.why };
    console.log(policyReadLine("spendEnvelope", { asked: [], verdict: `closed (${v.reason})` }));
    return v;
  }
  if (pool.producers.length === 0) {
    const v: SpendEnvelopeVerdict = { allow: false, unreadable: true, reason: "envelope unreadable: no " + (pool.foreign > 0 ? "own-substrate " : "") + "poolImpulse producer discovered" + foreignNote(pool.foreign) };
    console.log(policyReadLine("spendEnvelope", { asked: [], verdict: `closed (${v.reason})` }));
    return v;
  }
  const read = await readNewestPoolRecord("spendEnvelope", pool.producers);
  const line = (verdict: string, found?: boolean, entries?: number) => console.log(policyReadLine("spendEnvelope", { asked: pool.producers, answered: read.answered, ...(found === undefined ? {} : { found, entries }), verdict }));
  if (read.silent.length > 0) {
    const v: SpendEnvelopeVerdict = { allow: false, unreadable: true, reason: "envelope unreadable: no answer from " + read.silent[0]!.url };
    line(`closed (${v.reason})`);
    return v;
  }
  const newest = read.newest;
  if (!newest) {
    const v: SpendEnvelopeVerdict = { allow: false, unreadable: true, absent: true, reason: `envelope absent: no spendEnvelope record among ${read.answered.length} answering own producer(s) (no cap must be explicit: {uncapped: true})` };
    line("closed (absent)", false, 0);
    return v;
  }
  const env = (newest.body ?? {}) as { usd_cap_per_hour?: unknown; paused?: unknown; uncapped?: unknown; reason?: unknown; lineage_usd_cap_per_window?: unknown; lineage_window_s?: unknown; max_node_share?: unknown };
  const entries = (["usd_cap_per_hour", "paused", "uncapped"] as const).filter((k) => env[k] !== undefined && env[k] !== null).length;
  const rec = (v: SpendEnvelopeVerdict, verdict: string): SpendEnvelopeVerdict => { line(verdict, true, entries); return v; };
  if (env.paused === true) return rec({ allow: false, paused: true, reason: "paused: " + String(env.reason ?? "no reason given") }, "closed (paused)");
  const rawCap = env.usd_cap_per_hour;
  // A cap that is present but not a finite number is a misconfiguration, not "no cap".
  if (rawCap !== undefined && rawCap !== null && !(typeof rawCap === "number" && Number.isFinite(rawCap))) return rec({ allow: false, unreadable: true, reason: "envelope unreadable: usd_cap_per_hour is not a finite number" }, "closed (cap not a finite number)");
  const cap = typeof rawCap === "number" ? rawCap : null;
  if (cap !== null && env.uncapped === true) return rec({ allow: false, unreadable: true, reason: "envelope unreadable: the record sets both usd_cap_per_hour and uncapped:true" }, "closed (contradictory record)");
  if (cap === null) {
    if (env.uncapped === true) return rec({ allow: true, reason: "spendEnvelope is explicitly uncapped (no cap)" }, "open (explicitly uncapped)");
    return rec({ allow: false, unreadable: true, reason: "envelope unreadable: the record has no finite usd_cap_per_hour and is not explicitly uncapped" }, "closed (no cap and not uncapped:true)");
  }
  // Fair-share fields (4.5): parsed only under a finite cap; present-but-invalid refuses.
  const posNum = (v: unknown): number | null | undefined => (v === undefined || v === null ? undefined : typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const lineageCap = posNum(env.lineage_usd_cap_per_window);
  const lineageWindowS = posNum(env.lineage_window_s);
  const nodeShare = posNum(env.max_node_share);
  if (lineageCap === null || lineageWindowS === null || nodeShare === null || (typeof nodeShare === "number" && nodeShare > 1)) {
    return rec({ allow: false, unreadable: true, cap_usd: cap, reason: "envelope unreadable: a fair-share field (lineage_usd_cap_per_window, lineage_window_s, max_node_share) is not a positive finite number (share <= 1)" }, "closed (invalid fair-share field)");
  }
  const fair = {
    ...(lineageCap !== undefined ? { lineage_usd_cap: lineageCap, lineage_window_ms: (lineageWindowS ?? 3600) * 1000 } : {}),
    ...(nodeShare !== undefined ? { max_node_share: nodeShare } : {}),
  };
  line(`cap ${cap} USD/h` + (lineageCap !== undefined ? `, lineage ${lineageCap} USD/${lineageWindowS ?? 3600}s` : "") + (nodeShare !== undefined ? `, node share ${nodeShare}` : ""), true, entries);
  if (!spend.ok) return { allow: false, unreadable: true, ...(spend.lookup_failed ? { lookup_failed: true } : {}), cap_usd: cap, reason: "envelope unreadable: " + spend.why };
  const spendUrls = spend.urls;
  if (spendUrls.length === 0) return { allow: false, unreadable: true, cap_usd: cap, reason: "envelope unreadable: no " + (spend.foreign > 0 ? "own-substrate " : "") + "llmSpendSummaryNode producer discovered" + foreignNote(spend.foreign) };
  // One llmSpendSummaryNode producer per node (development-vessel relays its own node's
  // llm-resolver, whose own endpoint is loopback-only), so the sum covers every node (4.0a).
  const sums = await Promise.all(spendUrls.map((u) => postEnvelopeRead(u, { impulse: { pointer: { type: "llmSpendSummaryNode" } } })));
  let spent = 0;
  let ownSpent = 0;
  for (let i = 0; i < spendUrls.length; i++) {
    const b = sums[i]?.["body"] as { window_ms?: number; current?: { window_start?: string; cost_usd?: number }; previous?: { cost_usd?: number } | null } | undefined;
    if (!b || !b.current || typeof b.current.cost_usd !== "number") return { allow: false, unreadable: true, cap_usd: cap, reason: "envelope unreadable: no spend summary from " + spendUrls[i] };
    const windowMs = Number(b.window_ms) > 0 ? Number(b.window_ms) : 3_600_000;
    const elapsed = Date.now() - Date.parse(String(b.current.window_start ?? ""));
    const prevShare = Number.isFinite(elapsed) ? Math.max(0, 1 - elapsed / windowMs) : 1;
    const nodeSpent = b.current.cost_usd + (typeof b.previous?.cost_usd === "number" ? b.previous.cost_usd * prevShare : 0);
    spent += nodeSpent;
    // This node's own relay is the LOCAL-origin producer (discovery stamps it "local").
    if (spend.producers.find((p) => p.url === spendUrls[i])?.origin === "local") ownSpent += nodeSpent;
  }
  const verdict = { cap_usd: cap, spent_usd: spent, spend_sources: spendUrls.length, ...fair, ...(nodeShare !== undefined ? { own_spent_usd: ownSpent } : {}) };
  if (spent >= cap) return { allow: false, ...verdict, reason: "exhausted: spent " + spent.toFixed(3) + " USD of " + cap + " USD/h over " + spendUrls.length + " spend source(s)" };
  if (nodeShare !== undefined && ownSpent >= nodeShare * cap) return { allow: false, ...verdict, node_share_exhausted: true, reason: "node share exhausted: this node spent " + ownSpent.toFixed(3) + " USD of its " + (nodeShare * cap).toFixed(3) + " USD/h share (" + nodeShare + " x " + cap + "); fleet total " + spent.toFixed(3) };
  return { allow: true, ...verdict, reason: "within envelope: spent " + spent.toFixed(3) + " USD of " + cap + " USD/h" };
}
export async function spendEnvelopeAllows(): Promise<SpendEnvelopeVerdict> {
  // An ABSENT record is a successful read that found nothing, not a transient failure: it is held for
  // the normal TTL (a 2 s retry would re-read and re-log every 2 s on a node that holds no record).
  if (spendEnvelopeCache && Date.now() - spendEnvelopeCache.at < (spendEnvelopeCache.v.unreadable && !spendEnvelopeCache.v.absent ? policyUnreadableRetryMs() : SPEND_ENVELOPE_TTL_MS)) return spendEnvelopeCache.v;
  let v: SpendEnvelopeVerdict;
  try { v = await readSpendEnvelope(); } catch (err) { v = { allow: false, unreadable: true, reason: "envelope unreadable: " + String(err) }; console.log(policyReadLine("spendEnvelope", { asked: [], verdict: `closed (${v.reason})` })); }
  if (v.unreadable) v = { ...v, allow: false }; // fail closed, whatever this process has seen before
  spendEnvelopeCache = { at: Date.now(), v };
  return v;
}

// AUTONOMY SCOPE (contained-self-development 1.1). Autonomous work must not land on the machinery
// that lands and verifies work (the lane core), or its first failure is the lane refusing its own
// repair. The excluded paths are a shaped impulse read at use time: the newest open poolImpulse of
// shape `autonomyScope` ({excluded_paths: string[], reason}) across every poolImpulse producer of THIS
// substrate (discoverOwnResolveUrls), so one record binds every node and no peer substrate's does. Entries are repo-relative (`repos/<vessel>/src/
// file.ts`, or a directory ending in `/`). NO SCOPE IS ONLY EVER EXPLICIT: a record {unrestricted:
// true, reason} excludes nothing. A read that succeeded and found no record on any own producer is
// ABSENT, and absent excludes everything autonomous exactly like unreadable (`absent: true` names
// which): on 10-01 node 2, holding no record of its own while node 1 was not yet own, read the scope
// as empty and readable, admitted 229 gaps and composed on an excluded path. A record whose
// excluded_paths is empty or missing without unrestricted:true, or that sets unrestricted:true AND
// lists paths, is a misconfiguration and closed too. An unreadable scope excludes everything
// autonomous (fail closed), including on a fresh process that has not read one yet.
// Directed work never consults it. Cached 30 s.
export type AutonomyScope = { excluded: string[]; readable: boolean; reason: string; absent?: boolean; lookup_failed?: boolean; requireFalsifierClasses?: string[]; holds?: ScopeHold[] };

/**
 * A TIGHTENING HOLD MUST NOT BLOCK THE REPAIR OF ITS OWN REGRESSION (scope earn-in, qa ruling 10-05). The evaluator
 * (scope-earn-in.ts) adds a file with an open, unreverted regression to excluded_paths with a TTL hold, and stores on
 * the hold the regression's lineage: lineage_roots (the gap ids its evidence names) and lineage_checks (those gaps'
 * own test_suite checks, "<test_file>|<test title>"). The hold keeps every OTHER autonomous change off the file, but
 * a gap in that lineage is the repair itself, so it stays eligible:
 *   - the evidence gap, or any gap whose id, parent_gap_id, root_gap_id or source_gap_id (walked up the candidate
 *     set) reduces to a root once recommit- prefixes and -narrowed / -step-N / -cN suffixes are stripped;
 *   - or any gap whose own check names one of the regressing checks.
 * A hold with no lineage (no evidence gap) exempts nothing. Only the held entry is exempted; any other excluded path
 * still excludes.
 */
export type ScopeHold = { path: string; expires_at?: string; lineage_roots: string[]; lineage_checks: string[] };
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((e): e is string => typeof e === "string" && e.trim().length > 0).map((e) => e.trim()) : []);
export function parseScopeHolds(raw: unknown): ScopeHold[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((h): h is Record<string, unknown> => !!h && typeof h === "object" && typeof (h as { path?: unknown }).path === "string")
    .map((h) => ({ path: String(h.path).trim(), ...(typeof h.expires_at === "string" ? { expires_at: h.expires_at } : {}), lineage_roots: strList(h.lineage_roots), lineage_checks: strList(h.lineage_checks) }));
}
/** A gap's own test_suite check, as "<test_file>|<title>" keys (one per named test). */
export function gapCheckKeys(gap: Record<string, unknown>): string[] {
  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  const er = meta.evidence_resolve as { shape?: unknown; input?: Record<string, unknown> } | null | undefined;
  if (!er || typeof er !== "object" || er.shape !== "test_suite" || !er.input) return [];
  const file = typeof er.input.test_file === "string" ? er.input.test_file.trim() : "";
  return strList(er.input.only_tests).map((t) => `${file}|${t}`);
}
/** A gap id's lineage stem: recommit- layers removed (gapLineageRoot), then -narrowed / -step-N / -cN suffixes. */
export function gapLineageStem(id: string): string {
  let s = gapLineageRoot(id);
  for (let prev = ""; prev !== s;) { prev = s; s = s.replace(/-(?:narrowed|step-\d+|c\d+)$/, ""); }
  return s;
}
/** The hold behind an excluded entry, when that entry is a tightening hold. */
export function scopeHoldFor(scope: AutonomyScope, entry: string): ScopeHold | null {
  const n = (p: string) => p.replace(/^\.\//, "").replace(/^repos\//, "");
  return (scope.holds ?? []).find((h) => n(h.path) === n(entry)) ?? null;
}
export function gapInHoldLineage(gap: Record<string, unknown>, hold: ScopeHold, byId: Map<string, Record<string, unknown>> = new Map()): boolean {
  if (hold.lineage_roots.length === 0 && hold.lineage_checks.length === 0) return false;
  const roots = new Set(hold.lineage_roots.flatMap((r) => [r, gapLineageStem(r)]));
  const ids: string[] = [];
  const seen = new Set<string>();
  let cur: Record<string, unknown> | undefined = gap;
  for (let depth = 0; cur && depth <= 8; depth++) {
    const id = String(cur.id ?? "");
    if (seen.has(id)) break;
    seen.add(id);
    const meta = (cur.classification_metadata ?? cur.metadata ?? {}) as Record<string, unknown>;
    ids.push(id, ...[meta.parent_gap_id, meta.root_gap_id, meta.source_gap_id].filter((v): v is string => typeof v === "string" && v.length > 0));
    const parent = String(meta.parent_gap_id ?? meta.source_gap_id ?? "");
    cur = parent ? byId.get(parent) : undefined;
  }
  if (ids.some((id) => id && (roots.has(id) || roots.has(gapLineageStem(id))))) return true;
  const checks = new Set(hold.lineage_checks);
  return gapCheckKeys(gap).some((k) => checks.has(k));
}
let autonomyScopeCache: { at: number; v: AutonomyScope } | null = null;
export async function autonomyScope(): Promise<AutonomyScope> {
  // ABSENT is held for the normal TTL like a readable scope (a successful read; see spendEnvelopeAllows).
  if (autonomyScopeCache && Date.now() - autonomyScopeCache.at < (autonomyScopeCache.v.readable || autonomyScopeCache.v.absent ? 30_000 : policyUnreadableRetryMs())) return autonomyScopeCache.v;
  let v: AutonomyScope;
  try {
    const pool = await discoverOwnResolveUrls("poolImpulse");
    if (!pool.ok) {
      v = { excluded: [], readable: false, ...(pool.lookup_failed ? { lookup_failed: true } : {}), reason: pool.why };
      console.log(policyReadLine("autonomyScope", { asked: [], verdict: `closed (unreadable: ${v.reason})` }));
    } else if (pool.producers.length === 0) {
      v = { excluded: [], readable: false, reason: "no " + (pool.foreign > 0 ? "own-substrate " : "") + "poolImpulse producer discovered" + foreignNote(pool.foreign) };
      console.log(policyReadLine("autonomyScope", { asked: [], verdict: `closed (unreadable: ${v.reason})` }));
    } else {
      const read = await readNewestPoolRecord("autonomyScope", pool.producers);
      const line = (verdict: string, found?: boolean, entries?: number) => console.log(policyReadLine("autonomyScope", { asked: pool.producers, answered: read.answered, ...(found === undefined ? {} : { found, entries }), verdict }));
      const body = (read.newest?.body ?? {}) as { excluded_paths?: unknown; unrestricted?: unknown; require_falsifier_classes?: unknown };
      const raw = body.excluded_paths;
      const excluded = Array.isArray(raw) ? raw.filter((e): e is string => typeof e === "string" && e.trim().length > 0).map((e) => e.trim()) : [];
      if (read.silent.length > 0) {
        v = { excluded: [], readable: false, reason: "no answer from " + read.silent[0]!.url };
        line(`closed (unreadable: ${v.reason})`);
      } else if (!read.newest) {
        v = { excluded: [], readable: false, absent: true, reason: `autonomyScope absent: no record among ${read.answered.length} answering own producer(s) (no scope must be explicit: {unrestricted: true})` };
        line("closed (absent)", false, 0);
      } else if (body.unrestricted === true && excluded.length > 0) {
        v = { excluded: [], readable: false, reason: `autonomyScope misconfigured: unrestricted:true with ${excluded.length} excluded path(s)` };
        line("closed (contradictory record)", true, excluded.length);
      } else if (body.unrestricted !== true && excluded.length === 0) {
        v = { excluded: [], readable: false, reason: "autonomyScope misconfigured: the record names no excluded_paths and is not explicitly unrestricted" };
        line("closed (no excluded_paths and not unrestricted:true)", true, 0);
      } else {
        // require_falsifier_classes: autonomous admission takes only gaps a pre-existing,
        // machine-checkable falsifier can verify (a post-landing removed-line predicate is true by
        // construction, so a landing without one cannot be credited as an improvement).
        const reqRaw = body.require_falsifier_classes;
        const requireFalsifierClasses = Array.isArray(reqRaw) ? reqRaw.filter((e): e is string => typeof e === "string" && e.trim().length > 0).map((e) => e.trim().toLowerCase()) : undefined;
        const holds = parseScopeHolds((body as { tightening_holds?: unknown }).tightening_holds);
        v = { excluded, readable: true, reason: body.unrestricted === true ? "autonomyScope: explicitly unrestricted" : `autonomyScope: ${excluded.length} excluded path(s)`, ...(requireFalsifierClasses ? { requireFalsifierClasses } : {}), ...(holds.length ? { holds } : {}) };
        line(body.unrestricted === true ? "open (explicitly unrestricted)" : `contained (${excluded.length} excluded path(s))`, true, excluded.length);
      }
    }
  } catch (err) {
    v = { excluded: [], readable: false, reason: "autonomyScope unreadable: " + String(err) };
    console.log(policyReadLine("autonomyScope", { asked: [], verdict: `closed (${v.reason})` }));
  }
  autonomyScopeCache = { at: Date.now(), v };
  return v;
}
/** The scope entry that excludes `path` from autonomous work, or null. An unreadable scope excludes
 *  everything. Paths may be absolute, repo-relative or carry `:line`. */
export function autonomyScopeExcludes(scope: AutonomyScope, path: string): string | null {
  if (!scope.readable) return `scope ${scope.absent ? "absent" : "unreadable"} (${scope.reason})`;
  const n = String(path).replace(/:\d+.*$/, "").replace(/\\/g, "/").trim();
  for (const e of scope.excluded) {
    const s = e.replace(/^\.\//, "").replace(/^repos\//, "");
    if (s.endsWith("/")) {
      if (n.startsWith(s) || n.includes("/" + s)) return e;
    } else if (n === s || n.endsWith("/" + s)) {
      return e;
    }
  }
  return null;
}

/** The autonomy-scope floor for one autonomous compose: the scope entries its applied paths hit, and,
 *  when those hits exist only because the scope could not be read, why. That withhold still fails
 *  closed, but it is an environment condition, not a verdict on the draft. */
export function autonomyScopeFloor(scope: AutonomyScope, appliedPaths: string[], gap?: Record<string, unknown> | null): { hits: string[]; unreadable: string | null } {
  // A held entry does not withhold the compose of a gap in that hold's lineage (gapInHoldLineage); every other hit does.
  const hits = [...new Set(appliedPaths.map((p) => autonomyScopeExcludes(scope, p)).filter((h): h is string => !!h))]
    .filter((h) => { const hold = gap ? scopeHoldFor(scope, h) : null; return !(hold && gap && gapInHoldLineage(gap, hold)); });
  const unreadable = hits.length > 0 && !scope.readable
    ? `autonomy scope ${scope.absent ? "absent" : "unreadable"}${scope.lookup_failed ? " (discovery lookup failed)" : ""}: ${scope.reason}`
    : null;
  return { hits, unreadable };
}
