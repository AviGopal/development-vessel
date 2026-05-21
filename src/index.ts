import { Hono } from "hono";
import { impulsesRouter } from "./routes/impulses.js";
import { config } from "./config.js";
import { startDiscoveryRegistration, isRegistered } from "./discovery-registration.js";

const app = new Hono();

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    vessel: "development-vessel",
    version: "0.1.0",
    discovery: { registered: isRegistered() },
  });
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

export default server;
