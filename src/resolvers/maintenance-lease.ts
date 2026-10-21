// deploy-pipeline probe 2026-07-19b
/**
 * maintenanceLease resolver — file-backed advisory lock for DB maintenance windows.
 *
 * Part of the substrate-self-managed-DB-reconciliation change (openspec
 * 2026-07-08-substrate-self-managed-db-reconciliation/design.md). The trace
 * store swap (`db_admin reconcile_trace_store`) must not run concurrently with
 * observers/tick loops reading the trace store, and vice versa — the lease is
 * the coordination primitive both sides check. activity-api's db_admin route
 * validates a caller-supplied `lease_token` against this same file before
 * executing the reconcile op; `http-retry.ts`'s pausable-citizen guard reads
 * it to skip trace-store-read cycles while a lease is held.
 *
 * Storage: WORKSPACE_ROOT/leases/maintenance.json (env override
 * MAINTENANCE_LEASE_PATH for tests / non-default deployments), a single JSON
 * object `{ holder, token, acquired_at, expires_at }`. No file = no lease.
 * Atomic write (tmp → rename), same pattern as memory-note.ts / substrate-gap.ts.
 *
 * Contract (shared with activity-api's parallel build — do not rename fields):
 *   - acquire: { holder, ttl_ms? } -> { acquired: true, token, holder, expires_at }
 *                                   | { acquired: false, held_by, expires_at }
 *   - renew:   { token, ttl_ms? }  -> { renewed: true, token, expires_at }
 *                                   | { renewed: false, error }
 *   - release: { token }           -> { released: true } (idempotent if already gone)
 *                                   | { released: false, error: "token_mismatch" }
 *   - status (read pointer)        -> { held: true, holder, acquired_at, expires_at }
 *                                   | { held: false }
 *
 * WHO HOLDS A LEASE IS THE CREDENTIAL, NOT THE BODY. The resolve route stamps `_route_caller` (the identity its
 * write gate validated, routes/caller-identity.ts callerAuthLabel; any inbound one is overwritten) on every
 * maintenanceLease_write it serves. A stamped call holds as that principal: its `holder` is the principal's label
 * (a key by its masked id) and a body `holder` is ignored. A call with no stamp did not come through a route: it is
 * this process (the cutover's own holds), node-self, and keeps its own holder label. The lease file records the
 * full principal beside the holder; an acquire re-enters a live hold only when both match, so knowing a holder
 * name no longer takes its lease over. The status read never returns the principal.
 *
 * SYSTEM LEASES ARE NODE-SELF'S. The holds the node's own lanes take and read (SYSTEM_LEASE_NAMES, and the unnamed
 * global hold, which excludes every name and pauses the trace-store readers in http-retry.ts) are acquired,
 * renewed and released only by node-self; any other principal gets `system_lease_requires_node_self`.
 *
 * A HOLD HAS A TOTAL BOUND. Renewals extend a hold up to its acquired_at plus the tuning row
 * maintenance_lease.max_total_hold_s (activity-api tuning-params; absent or unreadable means
 * MAX_TOTAL_HOLD_S_DEFAULT). A renew starts a read of it at most once per MAX_TOTAL_HOLD_READ_MS and never waits
 * for it; every op uses the last value read, so no lease op (a landing's acquire least of all) waits on the read. A renew past the bound releases the hold with a log line; a re-entering acquire keeps the hold's
 * acquired_at, so re-acquiring does not restart the count.
 */

import { WORKSPACE_ROOT as DEFAULT_WORKSPACE_ROOT } from "../config.js";
import type { ResolverResult } from "./types.js";
import { readFile, writeFile, rename, mkdir, unlink, readdir } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { randomBytes } from "node:crypto";

export interface MaintenanceLease {
  holder: string;
  token: string;
  acquired_at: string;
  expires_at: string;
  /** The principal that took the hold (see WHO HOLDS A LEASE). Absent on a hold written before it was recorded. */
  principal?: string;
}

export interface MaintenanceLeaseReadPointer {
  type: "maintenanceLease";
  name?: string;
}

export interface MaintenanceLeaseWritePointer {
  type: "maintenanceLease_write";
  op: "acquire" | "renew" | "release";
  name?: string;
  holder?: string;
  token?: string;
  ttl_ms?: number;
  /** Stamped by the resolve routes from the credential their write gate validated (routes/impulses.ts), never by a
   *  client; absent on an in-process call. */
  _route_caller?: { auth?: unknown; remote?: unknown };
}

const DEFAULT_TTL_MS = 900_000; // 15 min
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 3_600_000; // 1 hour

/** The named holds the node's own lanes take (cutover, the trace-store reconcile) and read (the auto-pick, the
 *  drain observer, pull-sync and the watchdogs). Only node-self holds them, as it does the unnamed global hold. */
export const SYSTEM_LEASE_NAMES: ReadonlySet<string> = new Set(["autonomous_pick", "cutover", "change_window", "trace_store"]);
export const MAX_TOTAL_HOLD_S_ROW = "maintenance_lease.max_total_hold_s";
export const MAX_TOTAL_HOLD_S_DEFAULT = 4 * 3600;
const MAX_TOTAL_HOLD_READ_MS = 10 * 60_000;

type LeaseDeps = { now: () => number; maxTotalHoldS: () => Promise<number | null> };
const liveDeps: LeaseDeps = {
  now: Date.now,
  maxTotalHoldS: async () => (await import("../judge/gap-policy.js")).readTuningNumber(MAX_TOTAL_HOLD_S_ROW),
};
let deps: LeaseDeps = liveDeps;
let maxTotalHoldMs = MAX_TOTAL_HOLD_S_DEFAULT * 1000;
let maxTotalHoldReadAt = Number.NEGATIVE_INFINITY;
/** Tests only: replace the clock / the bound's tuning read (null restores both), and forget the cached bound. */
export function __setMaintenanceLeaseDepsForTests(d: Partial<LeaseDeps> | null): void {
  deps = d ? { ...liveDeps, ...d } : liveDeps;
  maxTotalHoldMs = MAX_TOTAL_HOLD_S_DEFAULT * 1000;
  maxTotalHoldReadAt = Number.NEGATIVE_INFINITY;
}
/** The bound in force: the last value read. A renew past MAX_TOTAL_HOLD_READ_MS since the last read starts a fresh read
 *  and does not wait for it (no lease op waits on activity-api); the value it reads applies from the next op. */
function totalHoldBoundMs(extending: boolean): number {
  if (extending && deps.now() - maxTotalHoldReadAt > MAX_TOTAL_HOLD_READ_MS) {
    maxTotalHoldReadAt = deps.now();
    void deps.maxTotalHoldS().then(
      (tuned) => { maxTotalHoldMs = (tuned !== null && tuned > 0 ? tuned : MAX_TOTAL_HOLD_S_DEFAULT) * 1000; },
      (err: unknown) => { console.warn(`[maintenance-lease] ${MAX_TOTAL_HOLD_S_ROW} read failed; the bound stays ${Math.round(maxTotalHoldMs / 1000)} s: ${String(err).slice(0, 200)}`); },
    );
  }
  return maxTotalHoldMs;
}

/** Who is writing (see WHO HOLDS A LEASE): the full principal, the holder label it holds under, whether it is
 *  node-self, and whether it is identifiable enough to re-enter its own hold (a caller identity named by scopes
 *  alone is not: two keys can share them). null when the stamp names no authenticated caller. */
function leasePrincipal(pointer: MaintenanceLeaseWritePointer): { principal: string; label: string; node_self: boolean; reentrant: boolean } | null {
  const rc = pointer._route_caller;
  if (rc === undefined) return { principal: "node-self", label: pointer.holder ?? "", node_self: true, reentrant: true };
  const auth = rc && typeof rc === "object" && typeof rc.auth === "string" ? rc.auth : "unauthenticated";
  if (auth === "authenticated:node-self") return { principal: "node-self", label: "node-self", node_self: true, reentrant: true };
  if (auth !== "authenticated" && !auth.startsWith("authenticated:")) return null;
  const key = /^authenticated:key_id:(.+)$/.exec(auth);
  return { principal: auth, label: key ? `key_id:${key[1]!.slice(0, 6)}` : auth, node_self: false, reentrant: key !== null };
}

/**
 * Read at call time, not module load, so tests can set MAINTENANCE_LEASE_PATH
 * (or WORKSPACE_ROOT) after this module is imported — config.ts snapshots its
 * exports at load, which is fine in production (env is set before bun starts)
 * but not for late-binding test overrides.
 */
export function leasePath(): string {
  return (
    process.env["MAINTENANCE_LEASE_PATH"] ??
    join(process.env["WORKSPACE_ROOT"] ?? DEFAULT_WORKSPACE_ROOT, "leases", "maintenance.json")
  );
}

/**
 * The lease file's own stem ("maintenance" for the default path). Named holds live beside
 * it as `<stem>-<name>.json`, so a non-default MAINTENANCE_LEASE_PATH keeps its named holds
 * private: tests point it into the shared /tmp, and a stem-less `maintenance-<name>.json`
 * there leaked one test's cutover hold into every other test's view of the lease.
 */
function leaseStem(): string {
  return basename(leasePath()).replace(/\.json$/, "");
}

export function namedLeasePath(name?: string): string {
  return name ? `${dirname(leasePath())}/${leaseStem()}-${name.replace(/[^a-z0-9_-]/gi, "_")}.json` : leasePath();
}

async function readLease(name?: string): Promise<MaintenanceLease | null> {
  try {
    const raw = await readFile(namedLeasePath(name), "utf-8");
    const parsed = JSON.parse(raw) as MaintenanceLease;
    if (!parsed || typeof parsed !== "object" || !parsed.token || !parsed.expires_at) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeLease(lease: MaintenanceLease, name?: string): Promise<void> {
  const path = namedLeasePath(name);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true }).catch((err: NodeJS.ErrnoException) => {
    if (err?.code !== "EEXIST") throw err;
  });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(lease, null, 2), "utf-8");
  await rename(tmp, path);
}

async function deleteLease(name?: string): Promise<void> {
  try {
    await unlink(namedLeasePath(name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

/** Every unexpired hold in the lease directory, the unnamed global first. */
async function listHolds(): Promise<Array<MaintenanceLease & { name: string | null }>> {
  let files: string[] = [];
  try {
    files = await readdir(dirname(leasePath()));
  } catch {
    return [];
  }
  const holds: Array<MaintenanceLease & { name: string | null }> = [];
  const stem = leaseStem();
  for (const f of files) {
    if (!f.startsWith(stem) || !f.endsWith(".json")) continue;
    const rest = f.slice(stem.length, -".json".length);
    if (rest !== "" && !rest.startsWith("-")) continue;
    const name = rest === "" ? null : rest.slice(1);
    const lease = await readLease(name ?? undefined);
    if (lease && !isExpired(lease)) holds.push({ ...lease, name });
  }
  return holds.sort((a, b) => (a.name === null ? -1 : b.name === null ? 1 : 0));
}

function isExpired(lease: MaintenanceLease): boolean {
  const exp = new Date(lease.expires_at).getTime();
  return !Number.isFinite(exp) || exp <= deps.now();
}

function clampTtl(requested: number | undefined): number {
  const v = requested ?? DEFAULT_TTL_MS;
  return Math.min(Math.max(v, MIN_TTL_MS), MAX_TTL_MS);
}

export async function resolveMaintenanceLease(
  _pointer: MaintenanceLeaseReadPointer,
): Promise<ResolverResult> {
  const own = await readLease(_pointer.name);
  // An unnamed hold means everything: a named read also sees the global hold
  // (services/gap-drain-observer.ts reads with names "trace_store" and "change_window").
  const lease = own && !isExpired(own) ? own : _pointer.name ? await readLease() : ((await listHolds())[0] ?? own);
  if (!lease || isExpired(lease)) {
    return { shape: "maintenanceLease", body: { held: false } };
  }
  return {
    shape: "maintenanceLease",
    body: {
      held: true,
      holder: lease.holder,
      acquired_at: lease.acquired_at,
      expires_at: lease.expires_at,
      holds: _pointer.name
        ? undefined
        : (await listHolds()).map((h) => ({ name: h.name, holder: h.holder, acquired_at: h.acquired_at, expires_at: h.expires_at })),
    },
  };
}

export async function resolveMaintenanceLeaseWrite(
  pointer: MaintenanceLeaseWritePointer,
): Promise<ResolverResult> {
  const now = new Date(deps.now());
  const who = leasePrincipal(pointer);
  if (!who) {
    return {
      shape: "structuredError",
      body: { resolver: "maintenanceLease_write", error: "caller_credential_required", op: pointer.op ?? null },
    };
  }
  const refuseSystem = (name: string | undefined): ResolverResult | null => {
    if (who.node_self || (name && !SYSTEM_LEASE_NAMES.has(name))) return null;
    console.warn(`[maintenance-lease] REFUSED ${pointer.op} of system lease ${name ?? "(unnamed global)"} by ${who.label}: only node-self holds it`);
    return {
      shape: "structuredError",
      body: { resolver: "maintenanceLease_write", error: "system_lease_requires_node_self", op: pointer.op ?? null, name: name ?? null, caller: who.label },
    };
  };
  // A release without a name finds its hold by token, so its system check waits for the hold it names.
  const refusedUpFront = pointer.op === "release" && !pointer.name ? null : refuseSystem(pointer.name);
  if (refusedUpFront) return refusedUpFront;

  if (pointer.op === "acquire") {
    const holder = who.label;
    if (!holder) {
      return {
        shape: "structuredError",
        body: { resolver: "maintenanceLease_write", error: "missing_required_field", field: "holder" },
      };
    }
    let existing = await readLease(pointer.name);
    // An acquire never asks for the bound (the cutover re-enters its own hold on its landing path); it uses the last
    // value read, and the next renew reads it.
    const boundMs = totalHoldBoundMs(false);
    if (existing && !isExpired(existing) && now.getTime() >= new Date(existing.acquired_at).getTime() + boundMs) {
      console.warn(`[maintenance-lease] RELEASED ${pointer.name ?? "(unnamed global)"} held by ${existing.holder} at its total-hold bound (${Math.round(boundMs / 1000)} s since ${existing.acquired_at})`);
      await deleteLease(pointer.name);
      // Its own holder re-acquiring is answered as a renew would be: the hold it continues is over, not renewed.
      if (existing.holder === holder && existing.principal === who.principal) {
        return {
          shape: "maintenanceLeaseWriteResult",
          body: { acquired: false, error: "total_hold_bound_reached", acquired_at: existing.acquired_at, bound_s: Math.round(boundMs / 1000), name: pointer.name ?? null },
        };
      }
      existing = null;
    }
    const globalHold = pointer.name ? await readLease() : null;
    // An unnamed acquire is refused while ANY hold exists (named ones included).
    const namedHolds: MaintenanceLease[] = pointer.name ? [] : await listHolds();
    for (const h of [existing, globalHold, ...namedHolds]) {
      if (h && !isExpired(h) && (h.holder !== holder || h.principal !== who.principal || !who.reentrant)) {
        return {
          shape: "maintenanceLeaseWriteResult",
          body: { acquired: false, held_by: h.holder, expires_at: h.expires_at, name: pointer.name ?? null },
        };
      }
    }
    const token = randomBytes(16).toString("hex");
    // A re-entering acquire continues the hold it re-enters: its total-hold bound counts from the first acquire.
    const acquired_at = existing && !isExpired(existing) ? existing.acquired_at : now.toISOString();
    const expires_at = new Date(Math.min(now.getTime() + clampTtl(pointer.ttl_ms), new Date(acquired_at).getTime() + boundMs)).toISOString();
    await writeLease({ holder, token, acquired_at, expires_at, principal: who.principal }, pointer.name);
    return {
      shape: "maintenanceLeaseWriteResult",
      body: { acquired: true, token, holder, expires_at, name: pointer.name ?? null },
    };
  }

  if (pointer.op === "renew") {
    const token = pointer.token;
    if (!token) {
      return {
        shape: "structuredError",
        body: { resolver: "maintenanceLease_write", error: "missing_required_field", field: "token" },
      };
    }
    const existing = await readLease(pointer.name);
    if (!existing || existing.token !== token) {
      return {
        shape: "maintenanceLeaseWriteResult",
        body: { renewed: false, error: "token_mismatch_or_no_lease" },
      };
    }
    const boundMs = totalHoldBoundMs(true);
    const boundAt = new Date(existing.acquired_at).getTime() + boundMs;
    if (!(now.getTime() < boundAt)) {
      console.warn(`[maintenance-lease] RELEASED ${pointer.name ?? "(unnamed global)"} held by ${existing.holder} at its total-hold bound (${Math.round(boundMs / 1000)} s since ${existing.acquired_at}); the renew is refused`);
      await deleteLease(pointer.name);
      return {
        shape: "maintenanceLeaseWriteResult",
        body: { renewed: false, error: "total_hold_bound_reached", acquired_at: existing.acquired_at, bound_s: Math.round(boundMs / 1000) },
      };
    }
    const expires_at = new Date(Math.min(now.getTime() + clampTtl(pointer.ttl_ms), boundAt)).toISOString();
    await writeLease({ ...existing, expires_at }, pointer.name);
    return { shape: "maintenanceLeaseWriteResult", body: { renewed: true, token, expires_at } };
  }

  if (pointer.op === "release") {
    const token = pointer.token;
    if (!token) {
      return {
        shape: "structuredError",
        body: { resolver: "maintenanceLease_write", error: "missing_required_field", field: "token" },
      };
    }
    let releaseName = pointer.name;
    let existing = await readLease(releaseName);
    // A release without a name still releases a hold its caller took under a name.
    if (!pointer.name && (!existing || existing.token !== token)) {
      const match = (await listHolds()).find((h) => h.name !== null && h.token === token);
      if (match) {
        existing = match;
        releaseName = match.name ?? undefined;
      }
    }
    if (!existing) {
      return { shape: "maintenanceLeaseWriteResult", body: { released: true, note: "already_absent" } };
    }
    if (existing.token !== token) {
      return { shape: "maintenanceLeaseWriteResult", body: { released: false, error: "token_mismatch" } };
    }
    const refused = pointer.name ? null : refuseSystem(releaseName);
    if (refused) return refused;
    await deleteLease(releaseName);
    return { shape: "maintenanceLeaseWriteResult", body: { released: true } };
  }

  return {
    shape: "structuredError",
    body: { resolver: "maintenanceLease_write", error: "unknown_op", op: (pointer as { op?: string }).op },
  };
}
