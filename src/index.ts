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
let readInFlight: () => number = () => 0;
export function publishInFlight(fn: () => number): void { readInFlight = fn; }

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    vessel: "development-vessel",
    vesselId: VESSEL_ID,
    version: "0.1.0",
    in_flight: readInFlight(),
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
// Declared HERE rather than beside the drain below: the request handler is the
// other reader, and a flag whose only declaration sits after its consumer is how
// this one stayed unread in the first place.
let devDraining = false;
let inFlightRequests = 0;
publishInFlight(() => inFlightRequests);
const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  idleTimeout: 60,
  fetch: async (req, srv) => {
    // Read the body ONCE to classify, then hand a fresh Request downstream:
    // consuming the stream here would leave the handler with an empty body.
    let counted = false;
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
          if (devDraining) {
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
    }
  },
});

console.log(`development-vessel listening on ${config.host}:${config.port}`);

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
const deadline = Date.now() + Number(process.env["DEV_VESSEL_DRAIN_MS"] ?? process.env["VESSEL_DRAIN_MS"] ?? 240000);
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

export default server;


