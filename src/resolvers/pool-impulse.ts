import { join } from 'node:path';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WORKSPACE_ROOT } from '../config.js';

const POOL_DIR = join(WORKSPACE_ROOT, 'pool');
const POOL_FILE = join(POOL_DIR, 'standing.json');

export interface StandingImpulse {
  id: string;
  shape: string;
  body: unknown;
  source: string;
  status: 'open' | 'consumed' | 'retired';
  injected_at: string;
  updated_at: string;
}

function loadImpulses(): StandingImpulse[] {
  if (!existsSync(POOL_FILE)) return [];
  try {
    const raw = readFileSync(POOL_FILE, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as StandingImpulse[];
    return [];
  } catch {
    return [];
  }
}

function saveImpulses(impulses: StandingImpulse[]): void {
  mkdirSync(POOL_DIR, { recursive: true });
  const tmp = POOL_FILE + '.tmp.' + Date.now();
  writeFileSync(tmp, JSON.stringify(impulses, null, 2), 'utf8');
  // atomic rename
  const fs = require('node:fs') as typeof import('node:fs');
  fs.renameSync(tmp, POOL_FILE);
}

export function resolvePoolImpulse(pointer: {
  type: string;
  id?: string;
  shape?: string;
  status?: string;
  limit?: number;
}): { shape: string; body: { impulses: StandingImpulse[]; count: number } } {
  const all = loadImpulses();
  const statusFilter = pointer.status ?? 'open';
  let filtered = all.filter((imp) => imp.status === statusFilter);
  if (pointer.id !== undefined) {
    filtered = filtered.filter((imp) => imp.id === pointer.id);
  }
  if (pointer.shape !== undefined) {
    filtered = filtered.filter((imp) => imp.shape === pointer.shape);
  }
  const limit = pointer.limit;
  const sorted = filtered.slice().sort((a, b) => {
    const ta = a.updated_at ?? a.injected_at ?? '';
    const tb = b.updated_at ?? b.injected_at ?? '';
    return tb < ta ? -1 : tb > ta ? 1 : 0;
  });
  const limited = limit !== undefined ? sorted.slice(0, limit) : sorted;
  return {
    shape: 'poolImpulse',
    body: { impulses: limited, count: limited.length },
  };
}

// TRUST-ROOT POOL SHAPES. A record of one of these shapes decides whom this substrate trusts, so it is
// written only with an OPERATOR credential: an API key that identity-vessel resolves with the "admin"
// scope (minted only through identity's bootstrap-admin, which demands the in-container root secret).
// The fleet service key and the cockpit key carry read/write only, so neither the autonomous lane (goal
// walks, ReAct tools, in-process writers) nor a federated peer reaching this route through the libp2p
// ingress (which forwards with the transport's own fleet key) or through discovery's forwarding (which
// forwards the caller's key) can create, change or retire one. The check lives in this function, the one
// writer of the pool store, so an in-process caller that passes no credential is refused too; only the
// HTTP route establishes `auth`, from the request's Authorization header.
//   substrateNodes: this substrate's discovery endpoints; gap-to-feature's policy reads accept a peer
//   node's producers only when its endpoint is listed, so a write here is a grant of policy authority.
//   autonomyScope / spendEnvelope: the containment and the budget the autonomous lane obeys. No
//   in-process writer exists (both records are operator-written), so gating them breaks nothing internal;
//   until an admin key is used, the failure direction is operator lock-out, never an outside write.
export const TRUST_ROOT_POOL_SHAPES: ReadonlySet<string> = new Set(['substrateNodes', 'autonomyScope', 'spendEnvelope']);
export type PoolWriteAuth = { operator: boolean; why?: string };
/** The trust-root shape a write would create or modify (by its own shape, or the shape of the row its id names), or null. */
export function trustRootWriteShape(pointer: { id?: string; shape?: string }): string | null {
  if (typeof pointer.shape === 'string' && TRUST_ROOT_POOL_SHAPES.has(pointer.shape)) return pointer.shape;
  if (typeof pointer.id === 'string') {
    const existing = loadImpulses().find((imp) => imp.id === pointer.id);
    if (existing && TRUST_ROOT_POOL_SHAPES.has(existing.shape)) return existing.shape;
  }
  return null;
}
const identityUrl = (): string => (process.env['IDENTITY_VESSEL_URL'] ?? '').trim().replace(/\/+$/, '');
/** Whether `authHeader` carries an operator credential: identity-vessel's /v1/auth/resolve (the contract
 *  discovery-vessel's auth middleware and activity-api's validateApiKeyWithFallback use) answers it
 *  authenticated WITH the "admin" scope. Anything else, including an unreachable identity, is not. */
export async function operatorCredential(authHeader: string | undefined): Promise<PoolWriteAuth> {
  const m = /^ApiKey\s+(\S+)$/i.exec(String(authHeader ?? '').trim());
  if (!m) return { operator: false, why: 'no ApiKey credential presented' };
  const base = identityUrl();
  if (!base) return { operator: false, why: 'IDENTITY_VESSEL_URL unset: identity cannot be asked' };
  try {
    const res = await fetch(`${base}/v1/auth/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ impulse: { type: 'authentication', pointer: { type: 'apiKey', apiKey: m[1] } } }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { operator: false, why: `identity answered HTTP ${res.status}` };
    const j = (await res.json()) as { success?: boolean; data?: { authenticated?: boolean; scopes?: unknown } };
    if (j?.data?.authenticated !== true) return { operator: false, why: 'credential not authenticated' };
    const scopes = Array.isArray(j.data.scopes) ? j.data.scopes : [];
    return scopes.includes('admin') ? { operator: true } : { operator: false, why: 'credential lacks the admin scope' };
  } catch (err) {
    return { operator: false, why: 'identity unreachable: ' + String((err as Error)?.message ?? err) };
  }
}

export function resolvePoolImpulseWrite(pointer: {
  type: string;
  id?: string;
  shape?: string;
  body?: unknown;
  source?: string;
  status?: 'open' | 'consumed' | 'retired';
  injected_at?: string;
  updated_at?: string;
  /** Compare-and-set: write only if the stored row's updated_at still equals this value. */
  if_updated_at?: string;
}, auth?: PoolWriteAuth): { shape: string; body: { ok: boolean; id: string; conflict?: boolean; current_updated_at?: string | null; error?: string } } {
  const trustRoot = trustRootWriteShape(pointer);
  if (trustRoot && auth?.operator !== true) {
    console.warn(`[pool] REFUSED ${trustRoot} write (id=${String(pointer.id ?? '(new)')}): operator credential required${auth?.why ? ` (${auth.why})` : ''}`);
    return { shape: 'poolImpulse_write', body: { ok: false, id: String(pointer.id ?? ''), error: `operator_credential_required: ${trustRoot} is a trust-root pool shape${auth?.why ? `; ${auth.why}` : ''}` } };
  }
  const all = loadImpulses();
  const now = new Date().toISOString();
  const id = pointer.id ?? randomUUID();
  const idx = all.findIndex((imp) => imp.id === id);
  // COMPARE-AND-SET (2026-09-26). The write REPLACES the body, so a writer that read a row, did slow
  // work, then wrote {...bodyItRead, change} silently reverted anything written in between (rhythm
  // alpha/beta lost under rhythm-reality-sync; the falsifier showed a residual ms window even after a
  // re-read). A caller that passes the updated_at it read gets {ok:false, conflict:true} instead of a
  // lost update, and re-reads. Writes without if_updated_at behave exactly as before.
  if (pointer.if_updated_at !== undefined) {
    const cur = idx >= 0 ? all[idx]!.updated_at : null;
    if (cur !== pointer.if_updated_at) {
      return { shape: 'poolImpulse_write', body: { ok: false, id, conflict: true, current_updated_at: cur ?? null } };
    }
  }
  if (idx >= 0) {
    const existing = all[idx]!;
    all[idx] = {
      id,
      shape: pointer.shape ?? existing.shape,
      body: pointer.body !== undefined ? pointer.body : existing.body,
      source: pointer.source ?? existing.source,
      status: pointer.status ?? existing.status,
      injected_at: existing.injected_at,
      updated_at: now,
    };
  } else {
    const entry: StandingImpulse = {
      id,
      shape: pointer.shape ?? '',
      body: pointer.body ?? null,
      source: pointer.source ?? '',
      status: pointer.status ?? 'open',
      injected_at: pointer.injected_at ?? now,
      updated_at: now,
    };
    all.push(entry);
  }
  saveImpulses(all);
  return { shape: 'poolImpulse_write', body: { ok: true, id } };
}
