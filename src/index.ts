import { Hono } from "hono";
import { isLongRunningBody } from "./long-running.js";
import { impulsesRouter } from "./routes/impulses.js";
import { config, DISCOVERY_SHAPES } from "./config.js";
import { startDiscoveryRegistration, isRegistered } from "./discovery-registration.js";
import { startRegistryChangeObserver } from "./observers/registry-change-observer.js";
import { startConceptBridgeObserver } from "./observers/concept-bridge-observer.js";
import { startAutocompleteConceptWriter } from "./observers/autocomplete-concept-writer.js";
import { startFailureCreditObserver } from "./observers/failure-credit-observer.js";
import { GapDrainObserver } from "./services/gap-drain-observer.js";

const app = new Hono();

import { VESSEL_ID } from "./config.js";

// Published so lifecycle actors can SEE the work before deciding to restart us.
// substrate-pull-sync defers a vessel's restart while it reports in-flight work,
// and it reads exactly this field — but only if the vessel actually emits it.
// development-vessel did not, so the deferral built for that purpose could never
// protect the vessel whose runs are the longest in the fleet.
// DRAIN BUDGET SIZED TO THE STAGE IT PROTECTS (resumable landings 2.1b): the only work a
// drain must outwait is a cutover's commit+push; everything before it is parked or cheap
// to redo. Stays below the unit's 300 s TimeoutStopSec so the drain always finishes first.
const CUTOVER_STAGE_MS = Number(process.env["DEV_VESSEL_CUTOVER_STAGE_MS"] ?? 180_000);
const DEV_VESSEL_DRAIN_MS = CUTOVER_STAGE_MS + 60_000;
let readInFlight: () => number = () => 0;
export function publishInFlight(fn: () => number): void { readInFlight = fn; }

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    vessel: "development-vessel",
    vesselId: VESSEL_ID,
    version: "0.1.0",
    in_flight: readInFlight(),
        in_flight_oldest_ms: readInFlightOldestMs(),
    // ADVERTISE THE DRAIN BUDGET, or the protection built on it cannot apply.
    //
    // substrate-pull-sync gates its safe-convergence path on this field: a vessel
    // that publishes `drain_ms` is quiesced (admission closed) and waited out
    // before restart; one that does not falls through to plain deferral and then
    // the starvation break, which converges destructively.
    //
    // goal-host publishes it. development-vessel — which hosts feature_compose and
    // patch_with_tools, the LONGEST runs in the fleet and the only ones whose loss
    // destroys a measurement — did not. So the quiesce mechanism written to stop
    // exactly that loss could never engage for the vessel it was written for.
    // Measured 2026-08-11: `[QUIESCED (admission closed)]` never appeared; the log
    // said "deferring convergence" instead, and composes kept dying on restart.
    //
    // Same number the drain itself uses, read from the same env, so the value the
    // converger trusts is the value the drain will honour.
    drain_ms: DEV_VESSEL_DRAIN_MS,
    discovery: { registered: isRegistered() },
  });
});

// A RESOLVER MUST NOT ADVERTISE A SHAPE IT CANNOT SERVE. llm-resolver-vessel already encodes
// this law in syncCompletionAdvertisement (index.ts:188): when every lane is cooling it DROPS
// the completion shapes so discovery routes callers to a producer that still works — including
// a remote hub arm — instead of into a dead local one. development-vessel was not doing the
// same, and the consequence is measurable.
//
// Measured 2026-08-06 on this spoke, where concept-db is MASKED because its data lives on the
// hub (law 11): concept_usage_record, concept_search_by_source and concept_select_for_prompt
// are advertised by development-vessel ALONE — no hub producer to fall back to — and every one
// POSTs to the pinned, dead CONCEPT_DB_ENDPOINT. They do not fail loudly; they SQUAT.
// concept_select_for_prompt answers `candidates_considered:0, selected:[]` and the concept-usage
// observer logs "usage record failed: Unable to connect" on a loop. A caller cannot tell an
// empty answer from an absent store, so the shortcoming is never discovered by attempting it.
//
// Dropping them makes the failure HONEST: discovery reports no producer, the walk sees a real
// capability gap it can act on, and any hub-served equivalent (concept_create_write,
// conceptSearch) wins the route instead of being shadowed by a local squatter.
//
// Probe result is cached and FAIL-CLOSED-ON-UNKNOWN-ONLY: a probe that has never succeeded
// withholds the shapes, but once concept-db is reachable the full list is restored on the next
// refresh. Never the reverse — a transient blip must not permanently un-advertise a working
// vessel, and the refresh is cache maintenance, not a behavioural rhythm.
const CONCEPT_BACKED_SHAPES = new Set([
  "concept_usage_record",
  "concept_search_by_source",
  "concept_select_for_prompt",
]);
const CONCEPT_PROBE_TTL_MS = 60_000;
let conceptDbReachable: boolean | null = null;
let conceptProbedAt = 0;
async function probeConceptDb(): Promise<void> {
  if (Date.now() - conceptProbedAt < CONCEPT_PROBE_TTL_MS) return;
  conceptProbedAt = Date.now();
  const base = process.env["CONCEPT_DB_ENDPOINT"] ?? "http://127.0.0.1:8260";
  try {
    const r = await fetch(`${base.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(3_000) });
    const next = r.ok;
    if (next !== conceptDbReachable) {
      console.log(`[shapes] concept-db reachable=${next} — ${next ? "advertising" : "withholding"} ${CONCEPT_BACKED_SHAPES.size} concept shape(s)`);
    }
    conceptDbReachable = next;
  } catch {
    if (conceptDbReachable !== false) {
      console.log(`[shapes] concept-db unreachable at ${base} — withholding ${CONCEPT_BACKED_SHAPES.size} concept shape(s) so discovery routes to a producer that can serve them`);
    }
    conceptDbReachable = false;
  }
}

app.get("/shapes", (c) => {
  void probeConceptDb();
  const shapes = conceptDbReachable === false
    ? DISCOVERY_SHAPES.filter((s: string) => !CONCEPT_BACKED_SHAPES.has(s))
    : DISCOVERY_SHAPES;
  return c.json({ shapes });
});

app.route("/", impulsesRouter);

// IN-FLIGHT REQUEST COUNT — the half the authoring markers do not cover.
//
// The drain below waits on `/workspace/authoring-inflight` markers, and those are
// not written until the APPLY stage. A compose spends most of its 5-8 minutes
// before that point (grounding, the planning call, verification), so a restart
// landing in that window drains "cleanly" — logging `0 authoring runs in flight`
// — while an inbound request is very much alive. The caller sees exactly the
// symptom this file's own comment describes: "socket connection closed
// unexpectedly".
//
// Observed 2026-08-10: a correctly-routed edit dispatch reached feature_compose,
// development-vessel restarted 2 minutes later reporting a clean drain, and the
// dispatch died `interrupted:none` with nothing staged. A previous session
// diagnosed this same gap from the cutover side (see vessel-mitosis-cutover.ts,
// "the marker is not written until the apply stage") and guarded the timer path;
// this closes it at the drain, which is where every caller of this vessel is
// exposed to it.
// COUNT ONLY THE REQUESTS WORTH WAITING FOR.
//
// A first version counted EVERY request. Measured immediately: this vessel's
// steady state is 3-5 concurrent requests (health polls, registry reads, short
// resolves), so "0 in flight" is unreachable and the drain simply burned its
// whole 240s budget every time and then killed the compose anyway — a gate that
// holds the door but never lets go is the same outage with a longer preamble.
//
// Only LONG-RUNNING work is worth blocking a restart for, and on this vessel that
// is the drafting surface: feature_compose and patch_with_tools, whose runs take
// 5-8 minutes and whose loss is the thing this drain exists to prevent. A health
// poll interrupted mid-flight costs nothing and retries itself.
//
// CLASSIFY BY POINTER TYPE, NEVER BY BODY TEXT.
//
// The previous version tested this regex against the RAW REQUEST BODY, so any
// request that merely MENTIONED one of these words counted as a long-running run.
// Measured 2026-08-10 against an independent census — `ls /workspace/compose-slots`
// (the authoritative count of live composes) said **1**, `/health` said **9**.
// The autonomous lane was writing gap records titled
// "feature-compose-has-no-concurrency-cap"; every such write registered as a
// compose in flight.
//
// That inflation was load-bearing in three places built on top of it: the drain
// waits for this to reach 0 (so it never could, and killed the compose at its
// deadline — the exact failure the counter was added to prevent), substrate-pull-sync
// defers restarts on it (so it deferred every tick until it hit its bound and
// restarted anyway), and it is published on /health for anyone else to believe.
//
// A request IS a compose only if its impulse pointer SAYS so, so read the pointer.
// Non-JSON and unparseable bodies are not counted: a compose pointer is always a
// JSON envelope, so "cannot parse" is conclusive evidence this is not one.
/**
 * QUIESCE — close admission WITHOUT killing anything.
 *
 * A convergence that restarts this vessel destroys whatever compose is in flight.
 * substrate-pull-sync knows that and trades it away deliberately: "the restart
 * drains for up to ${DRAINMS}ms, and work still running past that IS lost." The
 * drain is bounded, so a long compose dies anyway.
 *
 * That trade is what makes the system unable to measure itself while it develops
 * itself. The outcome of an in-flight change is the evidence that attributes
 * credit to the decision that produced it; if convergence destroys the run, the
 * dispatch ends `interrupted`, no verdict is recorded, and the learning loop
 * cannot tell a good change from a bad one. Measured 2026-08-11: three
 * consecutive operator trials died exactly this way, and each push of a fix
 * triggered the convergence that killed the next measurement.
 *
 * The drain is bounded only because work keeps ARRIVING. Close admission first
 * and in-flight decreases monotonically to zero on its own — so a quiesce-then-
 * restart is bounded by the longest single compose, not unbounded, and loses
 * nothing. That is the whole difference between a destructive convergence and a
 * safe one, and it needs no new machinery: the lame-duck refusal already exists
 * for SIGTERM, and this simply lets a converger open it early.
 *
 * A FILE, deliberately: pull-sync is a shell script and the marker must be
 * settable without an authenticated call, readable across process restarts, and
 * removable by a supervisor if the converger dies mid-run. Stale markers are
 * bounded by mtime for exactly that case — a quiesce that outlives its owner must
 * not wedge the vessel permanently.
 */
const QUIESCE_MARKER = process.env["QUIESCE_MARKER"] ?? "/workspace/quiesce/development-vessel";
const QUIESCE_MAX_MS = Number(process.env["QUIESCE_MAX_MS"] ?? 20 * 60_000);
function quiesced(): boolean {
  try {
    const { statSync } = require("node:fs") as typeof import("node:fs");
    const st = statSync(QUIESCE_MARKER);
    // Fail open on a stale marker: a converger that died must not close admission
    // forever. Same reasoning as the compose-slot staleness backstop.
    return Date.now() - st.mtimeMs < QUIESCE_MAX_MS;
  } catch {
    return false;
  }
}

// Declared HERE rather than beside the drain below: the request handler is the
// other reader, and a flag whose only declaration sits after its consumer is how
// this one stayed unread in the first place.
let devDraining = false;
let inFlightRequests = 0;
const inFlightStarts = new Set<{ at: number }>();
let readInFlightOldestMs: () => number | null = () => null;
export function publishInFlightOldest(fn: () => number | null): void {
  readInFlightOldestMs = fn;
}
publishInFlight(() => inFlightRequests);
publishInFlightOldest(() => { let oldest: number | null = null; for (const s of inFlightStarts) if (oldest === null || s.at < oldest) oldest = s.at; return oldest === null ? null : Date.now() - oldest; });
const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  idleTimeout: 60,
  fetch: async (req, srv) => {
    // Read the body ONCE to classify, then hand a fresh Request downstream:
    // consuming the stream here would leave the handler with an empty body.
        let counted = false;
    let startRec: { at: number } | null = null;
    let forwarded = req;
    try {
      if (req.method === "POST") {
        const raw = await req.clone().text();
        if (isLongRunningBody(raw)) {
          // LAME-DUCK ADMISSION. Once the drain has begun this process is going to
          // exit at a fixed deadline, so admitting a 5-8 minute compose now is
          // admitting work we have already decided to kill.
          //
          // Observed 2026-08-10: SIGTERM at 23:20:29, a NEW compose admitted at
          // 23:23:54, drain deadline at 23:24:30 — 36 seconds of life, one dead
          // dispatch, and the slot burned for nothing. The `devDraining` flag that
          // would have prevented it already existed; this handler simply never
          // read it.
          //
          // 503 + Retry-After, not a silent drop: the caller's gap stays open and
          // the work is retried against the process that replaces this one. That is
          // strictly better than quiescing on a counter, because the gap lane
          // retries every ~2 minutes and "wait until in-flight is 0" is unreachable
          // under that arrival rate.
          if (devDraining || quiesced()) {
            console.log(
              `[development-vessel] REFUSING long-running request during drain — it cannot finish before the deadline; caller should retry against the next process`,
            );
            return new Response(
              JSON.stringify({
                success: false,
                error: "draining",
                message:
                  "development-vessel is draining for restart and cannot start long-running work; retry shortly",
              }),
              { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "30" } },
            );
          }
          counted = true;
          inFlightRequests++;
          startRec = { at: Date.now() };
          inFlightStarts.add(startRec);
        }
        forwarded = new Request(req.url, {
          method: req.method,
          headers: req.headers,
          body: raw,
        });
      }
    } catch {
      forwarded = req; // unreadable body → forward untouched, never count
    }
    try {
      return await app.fetch(forwarded, srv);
    } finally {
      if (counted) inFlightRequests--;
      if (startRec) inFlightStarts.delete(startRec);
    }
  },
});

console.log(`development-vessel listening on ${config.host}:${config.port}`);

// WHY DID THIS PROCESS START? Nothing in systemd's journal records who requested a
// restart, and every restart of THIS vessel discards in-flight composes for the
// whole fleet once the drain deadline passes. An UNATTRIBUTED line here is the
// signal being hunted: a source that restarts the compose host without declaring
// itself. Purely observational and fully swallowed — a vessel must never fail to
// boot because its telemetry file is unreadable.
void (async () => {
  try {
    const { readFile } = await import("node:fs/promises");
    const { breadcrumbPath, parseBreadcrumb, describeStart } = await import("./restart-attribution.js");
    const raw = await readFile(breadcrumbPath("development-vessel"), "utf8").catch(() => "");
    console.log(describeStart(raw ? parseBreadcrumb(raw) : null, Date.now()));
  } catch { /* telemetry only */ }
})();

// GRACEFUL DRAIN. This vessel serves feature_compose and patch_with_tools, whose
// runs take 5-8 minutes. With no SIGTERM handler at all, a restart (its own mitosis
// cutover, or pull-sync converging it) killed the run outright and the caller saw
// only "socket connection closed unexpectedly" — fully drafted, typecheck-clean
// edits were lost that way repeatedly on 2026-08-05. The authoring-inflight markers
// already mark exactly the window that must not be interrupted, so drain on them.
// Bounded at 75s, deliberately UNDER the unit's 90s TimeoutStopSec, so this
// deadline fires before systemd's SIGKILL and the process exits on its own terms —
// a drain budget that exceeds its own stop timeout can never complete.
async function developmentVesselDrain(sig: string): Promise<void> {
  if (devDraining) return;
  devDraining = true;
  // Honour VESSEL_DRAIN_MS too: the live drop-in sets exactly that name, and it had
// no reader anywhere in the fleet — a knob that is configured and consumed by
// nothing. Prefer the vessel-specific name when present, fall back to the shared
// one, and default to 240s rather than 75s. The 75s default was chosen against the
// 90s DefaultTimeoutStopSec this unit used to inherit; its drop-in now allows 300s,
// so the old default abandoned three quarters of the available budget and killed
// composes that would have finished. The ordering invariant still holds and is the
// whole point: drain budget (240s) < stop timeout (300s), so this deadline fires
// before systemd's SIGKILL and the process exits on its own terms.
const deadline = Date.now() + DEV_VESSEL_DRAIN_MS;
  const markerDir = "/workspace/authoring-inflight";
  const freshMs = Number(process.env["DEV_VESSEL_DRAIN_FRESH_MS"] ?? 600000);
  try {
    const { readdir, stat } = await import("node:fs/promises");
    for (;;) {
      let live = 0;
      try {
        for (const f of await readdir(markerDir)) {
          if (!f.endsWith(".json")) continue;
          try {
            const st = await stat(`${markerDir}/${f}`);
            if (Date.now() - st.mtimeMs < freshMs) live++;
          } catch { /* vanished mid-scan — not in flight */ }
        }
      } catch { break; }
      // WAIT ONLY FOR CUTOVERS IN PROGRESS (resumable landings). A compose that passed its
      // gates has already parked its patch (/workspace/parked-landings) before calling the
      // cutover, and a draft/verify stage is cheap to redo, so neither is worth holding a
      // restart for. A cutover mid commit+push holds the change_window lease under name
      // "cutover" - that is the one stage a restart can still destroy.
      let cutoversLive = 0;
      try {
        const { resolveMaintenanceLease } = await import("./resolvers/maintenance-lease.js");
        const lease = (await resolveMaintenanceLease({ type: "maintenanceLease" })).body as { holds?: Array<{ name: string | null }> };
        cutoversLive = (lease.holds ?? []).filter((h) => h.name === "cutover").length;
      } catch { /* lease unreadable: fall through to the request/marker signals below */ }
      if (cutoversLive === 0) {
        console.log(`[development-vessel] ${sig}: drained (0 cutovers in progress; ${inFlightRequests} request(s) and ${live} authoring run(s) in draft/verify are parked or re-picked, not waited for)`);
        break;
      }
      console.log(`[development-vessel] ${sig}: ${cutoversLive} cutover(s) in progress - waiting for push`);
      // Both signals must be quiet: a marker-free vessel can still be mid-compose.
      if (live === 0 && inFlightRequests === 0) { console.log(`[development-vessel] ${sig}: drained (0 authoring runs, 0 requests in flight)`); break; }
      if (live === 0 && inFlightRequests > 0) {
        console.log(`[development-vessel] ${sig}: no authoring markers but ${inFlightRequests} request(s) still in flight — continuing to drain`);
      }
      // REPORT BOTH SIGNALS, because both can lose work.
      //
      // This line used to print only `live` (the marker count) while the loop's
      // continue-condition above reads BOTH markers and requests. Observed output,
      // one second apart on 2026-08-10:
      //
      //   23:24:29  no authoring markers but 2 request(s) still in flight — continuing to drain
      //   23:24:30  drain deadline with 0 authoring run(s) still in flight — they will be lost
      //
      // Two requests died and the log recorded zero losses. When a loop gains a
      // second signal, every branch that REPORTS on it has to gain it too, not just
      // the branch that reads it.
      if (Date.now() >= deadline) {
        console.warn(
          `[development-vessel] ${sig}: drain deadline — ${live} authoring run(s) and ${inFlightRequests} long-running request(s) still in flight; they will be lost`,
        );
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (e) { console.warn(`[development-vessel] ${sig}: drain error (exiting anyway): ${(e as Error).message}`); }
  try { server.stop(true); } catch { /* best-effort */ }
  process.exit(0);
}
process.on("SIGTERM", () => { void developmentVesselDrain("SIGTERM"); });
process.on("SIGINT", () => { void developmentVesselDrain("SIGINT"); });

// Non-blocking; failure logs but does not crash
startDiscoveryRegistration();
startRegistryChangeObserver();
startConceptBridgeObserver();
startAutocompleteConceptWriter();
startFailureCreditObserver();
if (process.env["GAP_DRAIN_OBSERVER"] !== "0") {
  try {
    const gapDrainObserver = new GapDrainObserver();
    gapDrainObserver.start();
  } catch (err) {
    console.log("[gap-drain-observer] failed to start (non-fatal):", err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Iteration 9 of the cross-vessel OOM hunt — periodic Bun.gc(true) workaround.
// See: concept_T-CTTOEl97IM (description), concept_s9ye5GKLw2L8 (signature),
//      concept_9ldsmRgqSTd5 (iter-6 derivation in goal-host-vessel).
//
// Hypothesis: Bun 1.3.14 retains heap-arena pages after free; affected vessels
// show RSS growth disconnected from heapUsed. goal-host hit OOM first because
// of its event volume; per iter-9 we apply the same workaround substrate-wide.
// A periodic forced full GC bounds RSS without changing semantics.
//
// .unref() so the timer doesn't prevent process exit.
// ─────────────────────────────────────────────────────────────────────────────
const GC_INTERVAL_MS = parseInt(process.env.DEV_VESSEL_GC_INTERVAL_MS ?? "30000", 10);
interface BunGlobal { Bun?: { gc?: (force: boolean) => number } }
const bunGlobal = globalThis as unknown as BunGlobal;
setInterval(() => {
  const gc = bunGlobal.Bun?.gc;
  if (typeof gc === "function") {
    try {
      const freed = gc(true);
      const rssMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
      console.log(`[gc-tick] vessel=development-vessel freed=${freed}B rss_after=${rssMB}MB`);
    } catch (err) {
      console.warn(`[gc-tick] Bun.gc failed: ${(err as Error).message}`);
    }
  }
}, GC_INTERVAL_MS).unref();

// ─────────────────────────────────────────────────────────────────────────────
// ARTIFACT-EXPECTATION OBSERVATION LOOP (2026-09-19). The substrate's verified
// reaches now persist standing expectations (memoryNote "expectation:<title>",
// written by goal-host's transform oracle at verdict time). This loop is the
// commitment-keeping half: on a rhythm it re-checks each expectation against
// the CURRENT artifact, independently of the original verdict. A violation
// makes THIS CODE author the investigative gap (worded for the adjudication
// pathway) and dispatch the restoration goal — no operator files the problem
// or supplies the next step. Attention is ordered by past violations (an
// artifact that degraded before is checked first: experience changes future
// selection). Recovery self-closes the gap and resets the baseline. Healthy
// ticks do nothing but heartbeat (restraint). Fail-open everywhere.
const EXP_SCAN_INTERVAL_MS = parseInt(process.env["EXPECTATION_SCAN_INTERVAL_MS"] ?? "300000", 10);
const EXP_SELF = process.env["DEV_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8090";
const EXP_GOAL_HOST = process.env["GOAL_HOST_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8210";
const EXP_KEY = process.env["METABOB_API_KEY"] ?? "";
const EXP_GOAL_TEXT: Record<string, (operand: string, title: string) => string> = {
  sha256: (o, t) => `Compute the SHA-256 hex digest of the exact string ${o} and store the digest in a memoryNote titled ${t}.`,
  base64: (o, t) => `Base64-encode the exact string ${o} and store the encoded text in a memoryNote titled ${t}.`,
  reverse: (o, t) => `Reverse the string ${o} and store the reversed text in a memoryNote titled ${t}.`,
  uppercase: (o, t) => `Uppercase the string ${o} and store the result in a memoryNote titled ${t}.`,
  lowercase: (o, t) => `Lowercase the string ${o} and store the result in a memoryNote titled ${t}.`,
  lettercount: (o, t) => `Count the letters in the word ${o} and store the count in a memoryNote titled ${t}.`,
  product: (o, t) => `Compute the product ${o} and store the numeric answer in a memoryNote titled ${t}.`,
};
async function expResolveNote(prefix: string): Promise<Array<{ title?: string; body?: string }>> {
  const r = await fetch(`${EXP_SELF}/v2/impulses/resolve`, { method: "POST", headers: { "Content-Type": "application/json", ...(EXP_KEY ? { Authorization: `ApiKey ${EXP_KEY}` } : {}) }, body: JSON.stringify({ impulse: { pointer: { type: "memoryNote", title_prefix: prefix, limit: 25 } } }), signal: AbortSignal.timeout(8000) });
  const j = (await r.json()) as { body?: { notes?: Array<{ title?: string; body?: string }> } };
  return j?.body?.notes ?? [];
}
async function expWrite(id: string, body: string): Promise<void> {
  await fetch(`${EXP_SELF}/v2/impulses/resolve`, { method: "POST", headers: { "Content-Type": "application/json", ...(EXP_KEY ? { Authorization: `ApiKey ${EXP_KEY}` } : {}) }, body: JSON.stringify({ impulse: { pointer: { type: "memoryNote_write", note: { id, type: "reference", title: id, body } } } }), signal: AbortSignal.timeout(8000) });
}
async function expGapWrite(gap: Record<string, unknown>): Promise<void> {
  await fetch(`${EXP_SELF}/v2/impulses/resolve`, { method: "POST", headers: { "Content-Type": "application/json", ...(EXP_KEY ? { Authorization: `ApiKey ${EXP_KEY}` } : {}) }, body: JSON.stringify({ impulse: { type: "substrateGap_write", pointer: { type: "substrateGap_write", gap: { ...gap, detected_at: new Date().toISOString() } } } }), signal: AbortSignal.timeout(8000) });
}
setInterval(() => { void (async () => {
  try {
    const expectations = (await expResolveNote("expectation:")).filter((n) => (n.title ?? "").startsWith("expectation:"));
    let violationsFound = 0;
    const parsed = expectations.map((n) => { try { return { title: n.title ?? "", spec: JSON.parse(n.body ?? "{}") as { target_title?: string; family?: string; operand?: string; expected?: string; violations?: number } }; } catch { return null; } }).filter((x): x is NonNullable<typeof x> => !!x && !!x.spec.target_title && !!x.spec.expected);
    parsed.sort((a, b) => (b.spec.violations ?? 0) - (a.spec.violations ?? 0));
    for (const e of parsed) {
      const target = String(e.spec.target_title);
      const notes = await expResolveNote(target);
      const live = notes.find((n) => n.title === target);
      const liveBody = typeof live?.body === "string" ? live.body.trim() : null;
      const gapId = "gap-artifact-expectation-violated-" + target.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
      if (liveBody === String(e.spec.expected)) {
        if ((e.spec.violations ?? 0) > 0) {
          await expWrite(e.title, JSON.stringify({ ...e.spec, violations: 0, restored_at: new Date().toISOString() }));
          await expGapWrite({ id: gapId, source: "substrate_detected", status: "closed", summary: `RESOLVED by observation loop: artifact ${target} again byte-equals its expectation ${String(e.spec.expected).slice(0, 60)} (${e.spec.family}(${e.spec.operand})). The violation was observed, an investigative restoration goal was dispatched, and the artifact recovered; baseline reset.` });
          console.log(`[expectation-scan] ${target} RECOVERED — gap ${gapId} self-closed, violations reset`);
        }
        continue;
      }
      violationsFound++;
      const v = (e.spec.violations ?? 0) + 1;
      await expWrite(e.title, JSON.stringify({ ...e.spec, violations: v, last_violation_at: new Date().toISOString(), last_observed: liveBody === null ? "(absent)" : liveBody.slice(0, 80) }));
      await expGapWrite({ id: gapId, source: "substrate_detected", status: "open", summary: `Observation loop found a verified artifact no longer valid: memoryNote ${target} was verified to byte-equal ${String(e.spec.expected).slice(0, 80)} (goal determines ${String(e.spec.expected).slice(0, 80)} for ${e.spec.family}(${e.spec.operand})) but now ${liveBody === null ? "is absent" : "stores " + liveBody.slice(0, 80)} — the artifact and its recorded verification disagree (violation #${v}). One mechanism degraded it after verdict; determine which, restore the artifact, preserve the criterion.` });
      const mk = EXP_GOAL_TEXT[String(e.spec.family)];
      if (mk && e.spec.operand) {
        await fetch(`${EXP_GOAL_HOST}/run-goal`, { method: "POST", headers: { "Content-Type": "application/json", ...(EXP_KEY ? { Authorization: `ApiKey ${EXP_KEY}` } : {}) }, body: JSON.stringify({ goal: mk(String(e.spec.operand), target), tags: ["operator:expectation-scan", "restoration", gapId] }), signal: AbortSignal.timeout(10000) }).then((r) => console.log(`[expectation-scan] ${target} VIOLATION #${v} — restoration goal dispatched (http ${r.status}), gap ${gapId} filed`)).catch((err) => console.warn(`[expectation-scan] restoration dispatch failed for ${target}: ${(err as Error).message}`));
      } else {
        console.log(`[expectation-scan] ${target} VIOLATION #${v} — gap ${gapId} filed; no goal template for family ${String(e.spec.family)} (investigation left to the repair lane)`);
      }
    }
    await expWrite("expectation-scan-heartbeat", JSON.stringify({ at: new Date().toISOString(), checked: parsed.length, violations_found: violationsFound }));
    if (parsed.length > 0 || violationsFound > 0) console.log(`[expectation-scan] tick complete checked=${parsed.length} violations=${violationsFound}`);
  } catch (err) {
    console.warn(`[expectation-scan] tick failed (non-fatal): ${(err as Error).message}`);
  }
})(); }, EXP_SCAN_INTERVAL_MS).unref();

// ─────────────────────────────────────────────────────────────────────────────
// TREND-EXPECTATION CHECK (2026-09-19). The artifact loop above keeps
// commitments about INDIVIDUAL verified artifacts; this loop keeps a standing
// commitment about the REACH TREND itself. The commitment lives as an impulse
// (memoryNote "expectation-trend:deterministic-battery" holding the bar, the
// probe count, and the cadence — read at use time, law 1); when due, this
// checker GENERATES fresh probe goals itself, dispatches them, and
// byte-verifies the artifacts IN-PROCESS — independent of goal-host's own
// verdicts, so an agreeing-wrong producer/verifier pair cannot satisfy it.
// A score below the committed bar files a substrate_detected gap; recovery on
// a later check closes it; no standing note -> no work (restraint). History
// rides in the note so the trend is durable and inspectable.
const TREND_EXP_PREFIX = "expectation-trend:";
const TREND_PROBE_GEN: Record<string, (seed: string, i: number, title: string) => { goal: string; expected: string }> = {
  product: (seed, i, t) => { const a = 101 + ((seed.charCodeAt(seed.length - 1) * 7 + i * 37) % 797); const b = 103 + ((seed.charCodeAt(0) * 11 + i * 91) % 793); return { goal: `Compute the product ${a}*${b} and store the numeric answer in a memoryNote titled ${t}.`, expected: String(a * b) }; },
  reverse: (seed, i, t) => { const w = "trend" + seed.slice(-4) + String(i); return { goal: `Reverse the string ${w} and store the reversed text in a memoryNote titled ${t}.`, expected: w.split("").reverse().join("") }; },
  uppercase: (seed, i, t) => { const w = "check" + seed.slice(-4) + String(i); return { goal: `Uppercase the string ${w} and store the result in a memoryNote titled ${t}.`, expected: w.toUpperCase() }; },
  lowercase: (seed, i, t) => { const w = "CHECK" + seed.slice(-4).toUpperCase() + String(i); return { goal: `Lowercase the string ${w} and store the result in a memoryNote titled ${t}.`, expected: w.toLowerCase() }; },
  base64: (seed, i, t) => { const w = "trend-" + seed.slice(-5) + String(i); return { goal: `Base64-encode the exact string ${w} and store the encoded text in a memoryNote titled ${t}.`, expected: Buffer.from(w, "utf8").toString("base64") }; },
  lettercount: (seed, i, t) => { const w = "abcdefghij".slice(0, 4 + ((seed.charCodeAt(0) + i) % 6)) + "kl"; return { goal: `Count the letters in the word ${w} and store the count in a memoryNote titled ${t}.`, expected: String(w.length) }; },
};
setInterval(() => { void (async () => {
  try {
    // SELF-ORIGINATED COMMITMENTS (2026-09-20, item-2 of the autonomy ledger).
    // Iterate EVERY expectation-trend:* impulse — operator-minted or
    // SELF-MINTED by goal-host on a family's first verified reach — instead of
    // one hardcoded title. Each note carries its own bar, probe count, cadence,
    // and family; probes are generated per family, dispatched, and
    // BYTE-VERIFIED IN-PROCESS, independent of dispatch verdicts. Violation
    // files a per-family substrate_detected gap; recovery closes it; history
    // rides in each impulse. No notes -> no work.
    const all = (await expResolveNote(TREND_EXP_PREFIX)).filter((n) => (n.title ?? "").startsWith(TREND_EXP_PREFIX));
    for (const row of all) {
      if (typeof row.body !== "string" || !row.title) continue;
      let spec: { family?: string; bar_min_r?: number; n?: number; cadence_minutes?: number; last_run_at?: string; open_violation?: boolean; history?: Array<{ at: string; r: number; n: number }> };
      try { spec = JSON.parse(row.body) as typeof spec; } catch { continue; }
      const famKey = String(spec.family ?? "").toLowerCase();
      const gen = TREND_PROBE_GEN[famKey] ?? null;
      const cadMs = Math.max(1, spec.cadence_minutes ?? 360) * 60000;
      const lastAt = spec.last_run_at ? Date.parse(spec.last_run_at) : 0;
      if (Number.isFinite(lastAt) && lastAt > 0 && Date.now() - lastAt < cadMs) continue;
      if (!gen) { console.log(`[trend-expectation] ${row.title}: no probe generator for family "${famKey}" — recorded, not checked`); await expWrite(row.title, JSON.stringify({ ...spec, last_run_at: new Date().toISOString(), last_score: "ungeneratable" })); continue; }
      const n = Math.max(1, Math.min(6, spec.n ?? 3));
      const seed = Date.now().toString(36);
      let r = 0;
      for (let i = 0; i < n; i++) {
        const title = `trendcheck-${famKey}-${seed}-${i}`;
        const probe = gen(seed, i, title);
        try {
          const dr = await fetch(`${EXP_GOAL_HOST}/run-goal`, { method: "POST", headers: { "Content-Type": "application/json", ...(EXP_KEY ? { Authorization: `ApiKey ${EXP_KEY}` } : {}) }, body: JSON.stringify({ goal: probe.goal, tags: ["operator:trend-expectation-check", famKey] }), signal: AbortSignal.timeout(10000) });
          const dj = (await dr.json()) as { dispatchId?: string };
          if (!dj.dispatchId) continue;
          for (let w2 = 0; w2 < 30; w2++) { await new Promise((res) => setTimeout(res, 10000)); try { const sr = await fetch(`${EXP_GOAL_HOST}/executions/${dj.dispatchId}`, { headers: { ...(EXP_KEY ? { Authorization: `ApiKey ${EXP_KEY}` } : {}) }, signal: AbortSignal.timeout(8000) }); const sj = (await sr.json()) as { status?: string }; if (sj.status === "completed" || sj.status === "failed") break; } catch {} }
          const notes = await expResolveNote(title);
          const live = notes.find((x) => x.title === title);
          if (live && typeof live.body === "string" && live.body.trim() === probe.expected) r++;
          try {
            await fetch(`${EXP_SELF}/v2/impulses/resolve`, { method: "POST", headers: { "Content-Type": "application/json", ...(EXP_KEY ? { Authorization: `ApiKey ${EXP_KEY}` } : {}) }, body: JSON.stringify({ type: "memoryNote_write", note: { id: title, retire: true } }), signal: AbortSignal.timeout(8000) });
            await fetch(`${EXP_SELF}/v2/impulses/resolve`, { method: "POST", headers: { "Content-Type": "application/json", ...(EXP_KEY ? { Authorization: `ApiKey ${EXP_KEY}` } : {}) }, body: JSON.stringify({ type: "memoryNote_write", note: { id: `expectation:${title}`, retire: true } }), signal: AbortSignal.timeout(8000) });
          } catch (e) { console.warn(`[trend-expectation] failed to retire probe note '${title}': ${e}`); }
        } catch { /* a failed probe is a miss, never a crash */ }
      }
      const hist = [...(spec.history ?? []).slice(-11), { at: new Date().toISOString(), r, n }];
      const bar = spec.bar_min_r ?? Math.ceil(n * 0.8);
      const violated = r < bar;
      const gapId = "gap-trend-expectation-violated-" + famKey;
      if (violated) {
        await expGapWrite({ id: gapId, source: "substrate_detected", status: "open", summary: `Standing trend expectation VIOLATED for family ${famKey}: independent check scored ${r}/${n} against the committed bar ${bar}/${n} (in-process byte-verification of freshly generated probes, not dispatch verdicts). History: ${JSON.stringify(hist.slice(-4))}. Determine which mechanism regressed and restore the bar; the commitment is the impulse ${row.title}.` });
      } else if (spec.open_violation) {
        await expGapWrite({ id: gapId, source: "substrate_detected", status: "closed", summary: `RESOLVED: trend expectation for family ${famKey} restored — ${r}/${n} meets the bar ${bar}/${n}. Closed by the checker that filed it.` });
        // After a successful grade, RETIRE the probe notes this checker just generated and graded.
        // Producer: probe note titles are built by this checker as `${TREND_EXP_PREFIX}${famKey}:probe:` + batch discriminator when dispatching probes
        // (see the generator near TREND_PROBE_GEN in this file). Matching on that concrete prefix retires the real probe notes we just graded.
        try {
          const retirePrefix = `${TREND_EXP_PREFIX}${famKey}:probe:`;
          const gradedProbes = (await expResolveNote(retirePrefix)).filter(p => (p.title ?? "").startsWith(retirePrefix));
          for (const g of gradedProbes) {
            const id = g.title ?? "";
            if (!id) continue;
            await fetch(`${EXP_SELF}/v2/impulses/resolve`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(EXP_KEY ? { Authorization: `ApiKey ${EXP_KEY}` } : {}) },
              body: JSON.stringify({ impulse: { pointer: { type: "memoryNote_retire", note: { id } } } }),
              signal: AbortSignal.timeout(8000),
            });
          }
        } catch (e) {
          console.warn(`[expectation-trend] retire failed for family ${famKey}: ${(e as Error).message}`);
        }
      }
      await expWrite(row.title, JSON.stringify({ ...spec, last_run_at: new Date().toISOString(), last_score: `${r}/${n}`, open_violation: violated, history: hist }));
      console.log(`[trend-expectation] ${row.title} check complete r=${r}/${n} bar=${bar} violated=${violated}`);
    }
  } catch (err) {
    console.warn(`[trend-expectation] tick failed (non-fatal): ${(err as Error).message}`);
  }
})(); }, 120000).unref();

export default server;


