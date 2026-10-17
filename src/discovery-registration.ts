import { config } from "./config.js";
import { GAP_STORE_HELD_SHAPES, gapStoreIsLocal } from "./resolvers/substrate-gap.js";
import { MEMORY_NOTE_HELD_SHAPES } from "./resolvers/memory-note.js";
import { LEARNING_CREDIT_HELD_SHAPES } from "./judge/learning-credit.js";
import { LLM_COMPLETION_DISPATCH_DECLARED_TIERS } from "./resolvers/llm-completion-dispatch.js";

/** Per-shape held-data policies for the advertised shapes, from the store modules' own declarations. The holder names
 *  which store: this node's gap store when it holds it, else the designated holder it forwards to; its own memory store. */
export function heldShapePolicies(advertised: readonly string[]): Record<string, { distribution_policy: "stateful_data_owner_pin"; holder: string }> {
  const gapHolder = gapStoreIsLocal() ? `gap-store@${config.vesselId}` : "gap-store@designated-holder";
  const out: Record<string, { distribution_policy: "stateful_data_owner_pin"; holder: string }> = {};
  const add = (shapes: readonly string[], holder: string) => { for (const s of shapes) if (advertised.includes(s)) out[s] = { distribution_policy: "stateful_data_owner_pin", holder }; };
  add(GAP_STORE_HELD_SHAPES, gapHolder);
  add(LEARNING_CREDIT_HELD_SHAPES, gapHolder);
  add(MEMORY_NOTE_HELD_SHAPES, `memory-store@${config.vesselId}`);
  return out;
}
/** The resolver tiers this vessel DECLARES, from the resolver modules' own declarations (as the held shapes are), for the
 *  advertised shapes only: registration `resolvers[]` entries `{ id: shape, tier }`. A shape with no declaration is
 *  simply absent (undeclared), never defaulted here: a dispatcher keeps its own fallback for those. */
export function declaredResolverTiers(advertised: readonly string[]): Array<{ id: string; tier: "deterministic" | "pattern" | "llm" }> {
  const declarations: ReadonlyArray<Readonly<Record<string, "deterministic" | "pattern" | "llm">>> = [LLM_COMPLETION_DISPATCH_DECLARED_TIERS];
  const out: Array<{ id: string; tier: "deterministic" | "pattern" | "llm" }> = [];
  for (const d of declarations) for (const [id, tier] of Object.entries(d)) if (advertised.includes(id)) out.push({ id, tier });
  return out;
}
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
import { scheduleSeedDelivery } from "./seed/deliver.js";

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
  const raw = (createPublicKey(pem).export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
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

export function buildRegistrationPayload() {
  const advertised: readonly string[] = 'conceptDbReachable' in config && config.conceptDbReachable === false
    ? config.discovery.shapes.filter((s: string) => !['concept_usage_record', 'concept_search_by_source', 'concept_select_for_prompt'].includes(s))
    : config.discovery.shapes;
  return {
    vesselId: config.vesselId,
    vesselName: "development-vessel",
    version: "0.1.0",
    endpoint: (process.env["VESSEL_ADVERTISE_ENDPOINT"] ?? "").replace(/\/+$/, "")
      || (process.env["SUBSTRATE_ADVERTISE_HOST"] ? `http://${process.env["SUBSTRATE_ADVERTISE_HOST"]}:${config.port + Number(process.env["SUBSTRATE_ADVERTISE_PORT_OFFSET"] ?? 10_000)}` : "")
      || `http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`,
    // REGISTRATION is the list discovery actually ROUTES on — filtering the /shapes handler
    // alone is inert. Measured 2026-08-06: after /shapes correctly withheld
    // concept_usage_record, concept_search_by_source and concept_select_for_prompt (247 shapes
    // instead of 250), discovery STILL returned development-vessel-local as the producer for
    // both, because this payload carries its own static list. A fix that changes an endpoint
    // nobody routes on is the "landed and looks right but fixes nothing" failure this codebase
    // keeps producing; the routing-visible surface is here.
    //
    // The law it enforces is llm-resolver's (index.ts:188 syncCompletionAdvertisement): a
    // resolver must not advertise a shape it cannot serve. On this spoke concept-db is MASKED
    // because its data lives on the hub (law 11), and these three shapes are advertised by
    // development-vessel ALONE with no hub producer behind them, so every call SQUATS — the
    // usage observer logs "usage record failed: Unable to connect" on a loop and
    // concept_select_for_prompt answers `selected: []`. A caller cannot distinguish an empty
    // answer from an absent store, so the shortcoming is never discovered by attempting it.
    // Withholding makes the gap honest and lets any hub-served equivalent win the route.
    shapes: advertised,
    // Resolver-DESCRIPTION advertisement (2026-06-28): pass per-shape
    // descriptions so a decomposition planner can match this vessel's resolvers
    // from their descriptions alone (no hand-written hint). Optional/backward-compat.
    shape_descriptions: config.discovery.shapeDescriptions,
    // HELD SHAPES (discovery held-shape-routing): each store module declares the shapes its resolvers serve from data THIS
    // node holds (or, for the gap store on a non-holder, forwards to its designated holder); routers take those to this
    // node's own producer, never to an interchangeable peer. Only advertised shapes are listed.
    shape_policies: heldShapePolicies(advertised),
    // DECLARED RESOLVER TIERS (discovery echoes each on the shape's capability row as resolver_tier): a dispatcher stamps
    // the tier of the resolver that ran instead of a constant. Only advertised shapes, only where a module declares one.
    resolvers: declaredResolverTiers(advertised),
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

/**
 * Non-blocking startup registration. Failure logs but does not crash.
 *
 * The heartbeat/re-register timer is armed WHETHER OR NOT the boot registration
 * succeeded. It used to be armed only on success, so a vessel whose first
 * registration was refused transiently (measured 2026-09-23 01:31:47: discovery
 * answered 401 while identity was rate-limiting the fleet) never tried again —
 * development-vessel was absent from the registry for over an hour, every
 * activity whose resolver lives here was unroutable, and the only trace was one
 * warning line. A vessel that is not registered re-registers on every tick until
 * it is; a registered one heartbeats, and re-registers when a heartbeat fails.
 */
export function startDiscoveryRegistration(): void {
  // SEED DELIVERY rides the server's start path. This function is called once, by the vessel
  // server (src/index.ts) as it comes up, and by nothing a test or a CLI import reaches — so a
  // new or version-bumped seed reaches a POPULATED catalogue after every deploy, without an
  // import-time side effect (the suite runs as root in the container, against the live store).
  // Deferred and once per process; it does not depend on discovery, only on activity-api.
  scheduleSeedDelivery();
  const tick = (): void => {
    if (!registered) {
      doRegister()
        .then(() => console.log(`[discovery] registered as ${config.vesselId} (retry)`))
        .catch((e: unknown) => {
          console.warn(`[discovery] re-register failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      return;
    }
    doHeartbeat().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[discovery] heartbeat failed: ${msg}`);
      // Re-register on heartbeat failure (TTL may have expired, or the registry lost us)
      registered = false;
      doRegister()
        .then(() => console.log(`[discovery] re-registered as ${config.vesselId}`))
        .catch((e: unknown) => {
          console.warn(`[discovery] re-register failed: ${e instanceof Error ? e.message : String(e)}`);
        });
    });
  };
  doRegister()
    .then(() => {
      console.log(`[discovery] registered as ${config.vesselId}`);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[discovery] registration failed (vessel still functional; will retry every ${HEARTBEAT_INTERVAL_MS / 1000}s): ${msg}`);
    })
    .finally(() => {
      if (heartbeatTimer === null) heartbeatTimer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
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
