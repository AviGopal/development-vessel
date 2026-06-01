import { Hono } from "hono";
import { impulsesRouter } from "./routes/impulses.js";
import { config, DISCOVERY_SHAPES } from "./config.js";
import { startDiscoveryRegistration, isRegistered } from "./discovery-registration.js";
import { startRegistryChangeObserver } from "./observers/registry-change-observer.js";
import { startConceptBridgeObserver } from "./observers/concept-bridge-observer.js";

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
  fetch: app.fetch,
});

console.log(`development-vessel listening on ${config.host}:${config.port}`);

// Non-blocking; failure logs but does not crash
startDiscoveryRegistration();
startRegistryChangeObserver();
startConceptBridgeObserver();

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
