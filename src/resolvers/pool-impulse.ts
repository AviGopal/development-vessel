import { join } from 'node:path';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { WORKSPACE_ROOT } from '../config.js';
import { identityCredential } from '../lib/caller-credential.js';

const POOL_DIR = join(WORKSPACE_ROOT, 'pool');
const POOL_FILE = join(POOL_DIR, 'standing.json');
// Tests only: the store file. WORKSPACE_ROOT is captured when config.ts first loads, which under a multi-file
// `bun test` is whichever file imported it first (often a non-temp cwd), so a suite that writes the pool names its own.
let poolFileOverride: string | null = null;
export function __setPoolFileForTests(path: string | null): void { poolFileOverride = path; }
const poolFile = (): string => poolFileOverride ?? POOL_FILE;

/** Written ONLY by resolvePoolImpulseWrite, on a trust-root write it accepted with an operator credential (or, for
 *  autonomyScope alone, from the accepted evaluator: EVALUATOR_TRUST_ROOT_WRITERS).
 *  key_id is identity's id for the validated key (null when identity's answer carried none); at equals the
 *  row's updated_at for that write. Unlike `source` (caller-supplied), a reader can rely on it. */
export interface PoolAttestation {
  /** 'operator': an admin-scoped credential. 'evaluator': the accepted in-process evaluator named in `evaluator`
   *  (EVALUATOR_TRUST_ROOT_WRITERS), which re-derived the change's evidence itself (no trust root as such: REALIGNMENT
   *  §7 step 9 / §10 item 1, 10-02 rulings). */
  by: 'operator' | 'evaluator';
  evaluator?: string;
  key_id: string | null;
  at: string;
  /** HMAC-SHA256 under this node's METABOB_API_KEY over the stored row (see attestationSig). Absent only
   *  when the node had no key at write time; a reader must then treat the row as unattested. */
  sig?: string;
}

/** Key-sorted JSON, so a body that crossed HTTP and a file round trip signs the same. TWIN: the same
 *  function in local-tools-vessel src/script-runner.ts (canonicalJson); change both together. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
}

/** SIGNED ATTESTATION. A reader on another vessel takes rows from whatever producer discovery lists as
 *  "local", and discovery stamps ANY authenticated plain registration "local", so a rogue producer could
 *  serve a forged `attested` (key ids are not secret). The stamp is therefore signed under this node's own
 *  key (METABOB_API_KEY: a spoke's is hub-issued per spoke, a root's minted at random), the same key the
 *  write-containment grants use; a peer's development-vessel signs with its own key and fails a reader
 *  here. TWIN: local-tools-vessel src/script-runner.ts (attestationSig) verifies exactly this string. */
export function attestationSig(key: string, row: { id: string; shape: string; status: string; body: unknown }, keyId: string | null, at: string): string {
  return createHmac('sha256', key)
    .update(['substrate-pool-attestation/v1', row.id, row.shape, row.status, canonicalJson(row.body), keyId ?? '', at].join('\n'))
    .digest('hex');
}

export interface StandingImpulse {
  id: string;
  shape: string;
  body: unknown;
  source: string;
  status: 'open' | 'consumed' | 'retired';
  injected_at: string;
  updated_at: string;
  /** Present only on a row whose last write was an operator-credentialed trust-root write. */
  attested?: PoolAttestation;
}

function loadImpulses(): StandingImpulse[] {
  if (!existsSync(poolFile())) return [];
  try {
    const raw = readFileSync(poolFile(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as StandingImpulse[];
    return [];
  } catch {
    return [];
  }
}

function saveImpulses(impulses: StandingImpulse[]): void {
  mkdirSync(poolFileOverride ? join(poolFileOverride, '..') : POOL_DIR, { recursive: true });
  const tmp = poolFile() + '.tmp.' + Date.now();
  writeFileSync(tmp, JSON.stringify(impulses, null, 2), 'utf8');
  // atomic rename
  const fs = require('node:fs') as typeof import('node:fs');
  fs.renameSync(tmp, poolFile());
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
//   calibrationWindow: a blind-calibration sample list (which dispatches are graded, under which seed,
//   where the labels go). Its writer chooses what the calibration measures, so the node's own key (the
//   autonomous lane, node-self with scopes ["node"]) cannot create it or change it by id.
//   scriptRunnerAllowlist: the repo scripts local-tools-vessel's script runner may execute with
//   METABOB_API_KEY injected, each pinned to an approved git blob hash. A row is a grant to run code with
//   the fleet credential; the runner accepts only rows carrying this writer's operator attestation.
export const TRUST_ROOT_POOL_SHAPES: ReadonlySet<string> = new Set(['substrateNodes', 'autonomyScope', 'spendEnvelope', 'calibrationWindow', 'scriptRunnerAllowlist']);
/** key_id: the validated credential's key id (identity's identifier, never derived from the secret).
 *  evaluator: set only by in-process code (the HTTP route builds auth from the Authorization header alone, and a
 *  pointer field of that name is never read), naming the accepted evaluator making the write. */
export type PoolWriteAuth = { operator: boolean; key_id?: string | null; why?: string; evaluator?: string };
/**
 * THE ACCEPTED EVALUATOR'S GRANT (scope earn-in, 2026-10-05). The user ruled 10-02 that limits change when the
 * system's evidence supports it, applied only by the previously ACCEPTED evaluator, never by the proposer and never
 * by an operator approval step (REALIGNMENT §7 step 9). One trust-root shape, one evaluator: autonomyScope may also be
 * written by scope_earn_in_apply (scope-earn-in.ts), which re-runs the criterion itself before writing. Every other
 * trust-root shape still needs the operator credential, and so does every other evaluator name.
 */
export const EVALUATOR_TRUST_ROOT_WRITERS: Readonly<Record<string, string>> = { autonomyScope: 'scope_earn_in_apply' };
/** The trust-root shape a write would create or modify (by its own shape, or the shape of the row its id names), or null. */
export function trustRootWriteShape(pointer: { id?: string; shape?: string }): string | null {
  if (typeof pointer.shape === 'string' && TRUST_ROOT_POOL_SHAPES.has(pointer.shape)) return pointer.shape;
  if (typeof pointer.id === 'string') {
    const existing = loadImpulses().find((imp) => imp.id === pointer.id);
    if (existing && TRUST_ROOT_POOL_SHAPES.has(existing.shape)) return existing.shape;
  }
  return null;
}
/** Whether `authHeader` carries an operator credential: identity-vessel's /v1/auth/resolve (the contract
 *  discovery-vessel's auth middleware and activity-api's validateApiKeyWithFallback use) answers it
 *  authenticated WITH the "admin" scope. Anything else, including an unreachable identity, is not.
 *  Asked fresh every time (no cache): a trust-root write is rare and must see a revocation at once. */
export async function operatorCredential(authHeader: string | undefined): Promise<PoolWriteAuth> {
  const cred = await identityCredential(authHeader, { cache: false });
  if (!cred.authenticated) return { operator: false, why: cred.why };
  return cred.scopes.includes('admin') ? { operator: true, key_id: cred.keyId ?? null } : { operator: false, why: 'credential lacks the admin scope' };
}

/** A body as stored: any `attested` key a caller put inside it is dropped (copied, never mutated). The
 *  attestation lives outside body and only the server writes it, so a body-level one is a forgery. */
function stripCallerAttestation(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !Object.prototype.hasOwnProperty.call(body, 'attested')) return body;
  const { attested: _forged, ...rest } = body as Record<string, unknown>;
  return rest;
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
  /** Caller-supplied attestation: NEVER stored. The row's `attested` is the server's stamp or absent. */
  attested?: unknown;
}, auth?: PoolWriteAuth): { shape: string; body: { ok: boolean; id: string; conflict?: boolean; current_updated_at?: string | null; error?: string; hint?: string } } {
  const trustRoot = trustRootWriteShape(pointer);
  const evaluatorGrant = !!trustRoot && auth?.operator !== true && typeof auth?.evaluator === 'string' && EVALUATOR_TRUST_ROOT_WRITERS[trustRoot] === auth.evaluator;
  if (trustRoot && auth?.operator !== true && !evaluatorGrant) {
    console.warn(`[pool] REFUSED ${trustRoot} write (id=${String(pointer.id ?? '(new)')}): operator credential required${auth?.why ? ` (${auth.why})` : ''}`);
    return { shape: 'poolImpulse_write', body: { ok: false, id: String(pointer.id ?? ''), error: `operator_credential_required: ${trustRoot} is a trust-root pool shape${auth?.why ? `; ${auth.why}` : ''}` } };
  }
  const all = loadImpulses();
  const now = new Date().toISOString();
  const id = pointer.id ?? randomUUID();
  const idx = all.findIndex((imp) => imp.id === id);
  // TRUST-ROOT MEMBERSHIP IS NOT EDITABLE IN PLACE. An update that names a different shape than the row's
  // own is refused, operator or not, when either shape is a trust root: out of one would drop the row from
  // this gate while keeping its id, into one would make a row anyone wrote a trust root. Retire and create.
  if (trustRoot && idx >= 0 && pointer.shape !== undefined && pointer.shape !== all[idx]!.shape) {
    const from = all[idx]!.shape;
    console.warn(`[pool] REFUSED reshape of ${id} from ${from} to ${pointer.shape}: trust-root membership is immutable`);
    return { shape: 'poolImpulse_write', body: { ok: false, id, error: `trust_root_shape_immutable: ${id} is ${from}; a write may not change it to ${pointer.shape}`, hint: 'retire this row and create a new one instead' } };
  }
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
  // SERVER-SIDE ATTESTATION. Reaching here with trustRoot set means the operator check above passed, so
  // this write is stamped; every other write carries no attestation (a previous stamp is not carried
  // forward either: it attests the write that made it). pointer.attested is never read.
  const attestation: PoolAttestation | null = !trustRoot ? null
    : evaluatorGrant ? { by: 'evaluator', evaluator: auth!.evaluator!, key_id: null, at: now }
    : { by: 'operator', key_id: auth?.key_id ?? null, at: now };
  // Signed over the row exactly as stored (below). The key is read here, at write time, never from a
  // value frozen at import. No key: stamp unsigned and say so (refusing would lock the operator out;
  // a reader fails closed on a missing sig anyway).
  const sign = (stored: StandingImpulse): StandingImpulse => {
    if (!stored.attested) return stored;
    const key = process.env['METABOB_API_KEY'] ?? '';
    if (!key) {
      console.warn(`[pool] ${stored.shape} ${stored.id} stamped unsigned: this node has no METABOB_API_KEY, so readers will refuse it`);
      return stored;
    }
    return { ...stored, attested: { ...stored.attested, sig: attestationSig(key, stored, stored.attested.key_id, stored.attested.at) } };
  };
  if (idx >= 0) {
    const existing = all[idx]!;
    all[idx] = sign({
      id,
      shape: pointer.shape ?? existing.shape,
      body: stripCallerAttestation(pointer.body !== undefined ? pointer.body : existing.body),
      source: pointer.source ?? existing.source,
      status: pointer.status ?? existing.status,
      injected_at: existing.injected_at,
      updated_at: now,
      ...(attestation ? { attested: attestation } : {}),
    });
  } else {
    const entry: StandingImpulse = {
      id,
      shape: pointer.shape ?? '',
      body: stripCallerAttestation(pointer.body ?? null),
      source: pointer.source ?? '',
      status: pointer.status ?? 'open',
      injected_at: pointer.injected_at ?? now,
      updated_at: now,
      ...(attestation ? { attested: attestation } : {}),
    };
    all.push(sign(entry));
  }
  saveImpulses(all);
  return { shape: 'poolImpulse_write', body: { ok: true, id } };
}
