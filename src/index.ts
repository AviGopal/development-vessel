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

app.get("/shapes", (c) => {
  return c.json({ shapes: DISCOVERY_SHAPES });
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


