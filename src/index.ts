import { Hono } from "hono";
import { impulsesRouter } from "./routes/impulses.js";
import { config, DISCOVERY_SHAPES } from "./config.js";
import { startDiscoveryRegistration, isRegistered } from "./discovery-registration.js";
import { startRegistryChangeObserver } from "./observers/registry-change-observer.js";
import { startConceptBridgeObserver } from "./observers/concept-bridge-observer.js";
import { startAutocompleteConceptWriter } from "./observers/autocomplete-concept-writer.js";
import { startFailureCreditObserver } from "./observers/failure-credit-observer.js";
import { GapDrainObserver } from "./services/gap-drain-observer.js";

const app = new Hono();

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    vessel: "development-vessel",
    version: "0.1.0",
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

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  idleTimeout: 60,
  fetch: app.fetch,
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
let devDraining = false;
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
      if (live === 0) { console.log(`[development-vessel] ${sig}: drained (0 authoring runs in flight)`); break; }
      if (Date.now() >= deadline) { console.warn(`[development-vessel] ${sig}: drain deadline with ${live} authoring run(s) still in flight — they will be lost`); break; }
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


