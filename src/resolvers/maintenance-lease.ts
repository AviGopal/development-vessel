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
 */

import { WORKSPACE_ROOT as DEFAULT_WORKSPACE_ROOT } from "../config.js";
import type { ResolverResult } from "./types.js";
import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

export interface MaintenanceLease {
  holder: string;
  token: string;
  acquired_at: string;
  expires_at: string;
}

export interface MaintenanceLeaseReadPointer {
  type: "maintenanceLease";
}

export interface MaintenanceLeaseWritePointer {
  type: "maintenanceLease_write";
  op: "acquire" | "renew" | "release";
  holder?: string;
  token?: string;
  ttl_ms?: number;
}

const DEFAULT_TTL_MS = 900_000; // 15 min
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 3_600_000; // 1 hour

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

async function readLease(): Promise<MaintenanceLease | null> {
  try {
    const raw = await readFile(leasePath(), "utf-8");
    const parsed = JSON.parse(raw) as MaintenanceLease;
    if (!parsed || typeof parsed !== "object" || !parsed.token || !parsed.expires_at) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeLease(lease: MaintenanceLease): Promise<void> {
  const path = leasePath();
  const dir = dirname(path);
  await mkdir(dir, { recursive: true }).catch((err: NodeJS.ErrnoException) => {
    if (err?.code !== "EEXIST") throw err;
  });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(lease, null, 2), "utf-8");
  await rename(tmp, path);
}

async function deleteLease(): Promise<void> {
  try {
    await unlink(leasePath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

function isExpired(lease: MaintenanceLease): boolean {
  const exp = new Date(lease.expires_at).getTime();
  return !Number.isFinite(exp) || exp <= Date.now();
}

function clampTtl(requested: number | undefined): number {
  const v = requested ?? DEFAULT_TTL_MS;
  return Math.min(Math.max(v, MIN_TTL_MS), MAX_TTL_MS);
}

export async function resolveMaintenanceLease(
  _pointer: MaintenanceLeaseReadPointer,
): Promise<ResolverResult> {
  const lease = await readLease();
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
    },
  };
}

export async function resolveMaintenanceLeaseWrite(
  pointer: MaintenanceLeaseWritePointer,
): Promise<ResolverResult> {
  const now = new Date();

  if (pointer.op === "acquire") {
    const holder = pointer.holder;
    if (!holder) {
      return {
        shape: "structuredError",
        body: { resolver: "maintenanceLease_write", error: "missing_required_field", field: "holder" },
      };
    }
    const existing = await readLease();
    if (existing && !isExpired(existing) && existing.holder !== holder) {
      return {
        shape: "maintenanceLeaseWriteResult",
        body: { acquired: false, held_by: existing.holder, expires_at: existing.expires_at },
      };
    }
    const token = randomBytes(16).toString("hex");
    const acquired_at = now.toISOString();
    const expires_at = new Date(now.getTime() + clampTtl(pointer.ttl_ms)).toISOString();
    await writeLease({ holder, token, acquired_at, expires_at });
    return {
      shape: "maintenanceLeaseWriteResult",
      body: { acquired: true, token, holder, expires_at },
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
    const existing = await readLease();
    if (!existing || existing.token !== token) {
      return {
        shape: "maintenanceLeaseWriteResult",
        body: { renewed: false, error: "token_mismatch_or_no_lease" },
      };
    }
    const expires_at = new Date(now.getTime() + clampTtl(pointer.ttl_ms)).toISOString();
    await writeLease({ ...existing, expires_at });
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
    const existing = await readLease();
    if (!existing) {
      return { shape: "maintenanceLeaseWriteResult", body: { released: true, note: "already_absent" } };
    }
    if (existing.token !== token) {
      return { shape: "maintenanceLeaseWriteResult", body: { released: false, error: "token_mismatch" } };
    }
    await deleteLease();
    return { shape: "maintenanceLeaseWriteResult", body: { released: true } };
  }

  return {
    shape: "structuredError",
    body: { resolver: "maintenanceLease_write", error: "unknown_op", op: (pointer as { op?: string }).op },
  };
}
