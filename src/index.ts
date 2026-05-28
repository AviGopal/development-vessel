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

export default server;
