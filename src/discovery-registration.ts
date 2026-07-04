import { config } from "./config.js";
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const HEARTBEAT_INTERVAL_MS = 60_000;

/** Where the vessel's Ed25519 identity key lives (advisory H2 proof-of-possession). */
const IDENTITY_KEY_PATH =
  process.env.VESSEL_IDENTITY_KEY_PATH ?? "/workspace/keys/development-vessel.ed25519.pem";

/**
 * Load or create the vessel's Ed25519 identity keypair (advisory H2).
 * Random keygen at first start, persisted 0600 under the vessel data dir;
 * returns null on any fs error so registration never breaks on identity.
 */
function loadOrCreateIdentityKey(): KeyObject | null {
  try {
    if (existsSync(IDENTITY_KEY_PATH)) {
      return createPrivateKey(readFileSync(IDENTITY_KEY_PATH, "utf8"));
    }
    const { privateKey } = generateKeyPairSync("ed25519");
    mkdirSync(dirname(IDENTITY_KEY_PATH), { recursive: true });
    writeFileSync(
      IDENTITY_KEY_PATH,
      privateKey.export({ format: "pem", type: "pkcs8" }) as string,
      { mode: 0o600 },
    );
    return privateKey;
  } catch {
    return null;
  }
}

/**
 * Advisory H2 proof-of-possession fields for the registration payload:
 * pubkey + fresh Ed25519 self-signed challenge over canonical JSON
 * {vesselId, identity_signed_at, identity_nonce}. Recorded by discovery
 * (pubkey_hash + identity_status), never enforced. Empty when no key.
 */
function identityFields(vesselId: string): Record<string, unknown> {
  const key = loadOrCreateIdentityKey();
  if (!key) return {};
  const pem = key.export({ format: "pem", type: "pkcs8" }) as string;
  const raw = createPublicKey({ key: pem, format: "pem" }).export({ format: "der", type: "spki" }).subarray(-32);
  const pubkey = Buffer.from(raw).toString("base64");
  const identity_nonce = randomUUID();
  const identity_signed_at = Date.now();
  const payload = Buffer.from(
    JSON.stringify({ vesselId, identity_signed_at, identity_nonce }),
  );
  const identity_signature = sign(null, payload, key).toString("base64");
  return { pubkey, identity_signature, identity_nonce, identity_signed_at };
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let registered = false;

function buildRegistrationPayload() {
  return {
    vesselId: config.vesselId,
    vesselName: "development-vessel",
    version: "0.1.0",
    endpoint: `http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`,
    shapes: config.discovery.shapes,
    // Resolver-DESCRIPTION advertisement (2026-06-28): pass per-shape
    // descriptions so a decomposition planner can match this vessel's resolvers
    // from their descriptions alone (no hand-written hint). Optional/backward-compat.
    shape_descriptions: config.discovery.shapeDescriptions,
    resolve_endpoint: config.discovery.resolveEndpoint,
    resolve_request_format: config.discovery.resolveRequestFormat,
    auth_scheme: config.discovery.authScheme,
    resolve_timeout_ms: config.discovery.resolveTimeoutMs,
    auth_token_source: "caller_identity" as const,
    auth_delegation_mode: "forward" as const,
    // Advisory H2 identity proof-of-possession (recorded, never enforced).
    ...identityFields(config.vesselId),
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
