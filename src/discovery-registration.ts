import { config } from "./config.js";

const HEARTBEAT_INTERVAL_MS = 60_000;

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let registered = false;

function buildRegistrationPayload() {
  return {
    vesselId: config.vesselId,
    vesselName: "development-vessel",
    version: "0.1.0",
    endpoint: `http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`,
    shapes: config.discovery.shapes,
    resolve_endpoint: config.discovery.resolveEndpoint,
    resolve_request_format: config.discovery.resolveRequestFormat,
    auth_scheme: config.discovery.authScheme,
    resolve_timeout_ms: config.discovery.resolveTimeoutMs,
    auth_token_source: "caller_identity" as const,
    auth_delegation_mode: "forward" as const,
  };
}

async function doRegister(): Promise<void> {
  const res = await fetch(`${config.discoveryEndpoint}/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `ApiKey ${config.metabobApiKey}`,
    },
    body: JSON.stringify(buildRegistrationPayload()),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`discovery register ${res.status}: ${text}`);
  }
  registered = true;
}

async function doHeartbeat(): Promise<void> {
  const res = await fetch(`${config.discoveryEndpoint}/heartbeat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `ApiKey ${config.metabobApiKey}`,
    },
    body: JSON.stringify({ vesselId: config.vesselId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`discovery heartbeat ${res.status}: ${text}`);
  }
}

/** Non-blocking startup registration. Failure logs but does not crash. */
export function startDiscoveryRegistration(): void {
  doRegister()
    .then(() => {
      console.log(`[discovery] registered as ${config.vesselId}`);
      heartbeatTimer = setInterval(() => {
        doHeartbeat().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[discovery] heartbeat failed: ${msg}`);
          // Re-register on heartbeat failure (TTL may have expired)
          doRegister().catch((e: unknown) => {
            console.warn(`[discovery] re-register failed: ${e instanceof Error ? e.message : String(e)}`);
          });
        });
      }, HEARTBEAT_INTERVAL_MS);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[discovery] registration failed (vessel still functional): ${msg}`);
    });
}

export function stopDiscoveryRegistration(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

export function isRegistered(): boolean {
  return registered;
}
