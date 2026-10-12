import { join } from 'node:path';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { WORKSPACE_ROOT } from '../config.js';
import { identityCredential, isNodeSelfCredential, type CallerCredential } from '../lib/caller-credential.js';

const POOL_DIR = join(WORKSPACE_ROOT, 'pool');
const POOL_FILE = join(POOL_DIR, 'standing.json');
// Tests only: the store file. WORKSPACE_ROOT is captured when config.ts first loads, which under a multi-file
// `bun test` is whichever file imported it first (often a non-temp cwd), so a suite that writes the pool names its own.
let poolFileOverride: string | null = null;
export function __setPoolFileForTests(path: string | null): void { poolFileOverride = path; }
const poolFile = (): string => poolFileOverride ?? POOL_FILE;

/** Written ONLY by resolvePoolImpulseWrite, on a trust-root write it accepted with an operator credential (or, for
 *  autonomyScope alone, from the accepted evaluator: EVALUATOR_TRUST_ROOT_WRITERS), or on a verdictCorpusStatus write
 *  it admitted under the runner grant (by 'runner'; RUNNER_ONLY_POOL_SHAPES).
 *  key_id is identity's id for the validated key (null when identity's answer carried none); at equals the
 *  row's updated_at for that write. Unlike `source` (caller-supplied), a reader can rely on it. */
export interface PoolAttestation {
  /** 'operator': an admin-scoped credential. 'evaluator': the accepted in-process evaluator named in `evaluator`
   *  (EVALUATOR_TRUST_ROOT_WRITERS), which re-derived the change's evidence itself (no trust root as such: REALIGNMENT
   *  §7 step 9 / §10 item 1, 10-02 rulings). */
  by: 'operator' | 'evaluator' | 'runner';
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

/** This node's key (METABOB_API_KEY), read at use time: the stamp signs and verifies under it. */
const nodeKey = (): string => process.env['METABOB_API_KEY'] ?? '';

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
//   operatorHold: one operator hold per row (src/lib/operator-hold.ts reads it, fail-closed). A hold the
//   autonomous lane could write could also be LIFTED by it, which would be the lane lifting its own
//   containment, so it is operator-only: it is deliberately absent from EVALUATOR_TRUST_ROOT_WRITERS.
//   posteriorReplayAuthorization: the operator's go for activity-api's β-leak replay writes, naming the node and
//   the pinned list / eligibility shas. activity-api reads it from THIS node's route and trusts the
//   attested_verified verdict the poolImpulse read adds (routes/impulses.ts); it never holds the attestation key.
//   verdictCorpusWriter: kept operator-only so no one else can plant one; the runner grant (below) no longer reads it
//   (the identity scope VERDICT_CORPUS_WRITE_SCOPE is the authority).
export const TRUST_ROOT_POOL_SHAPES: ReadonlySet<string> = new Set(['substrateNodes', 'autonomyScope', 'spendEnvelope', 'calibrationWindow', 'scriptRunnerAllowlist', 'operatorHold', 'posteriorReplayAuthorization', 'verdictCorpusWriter']);
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

// THE VERDICT CORPUS RUNNER GRANT (closed). goal-host's credit stop withholds learning for every
// credit class a red verdict-corpus case names, and it reads which classes are held from the `verdictCorpusStatus`
// row of this store. A row anyone could write would let anyone clear every hold, so the shape has exactly one writer:
// goal-host's OWN principal, publishing a corpus run. Who is calling is derived by the server, never by the body:
//   - the request's Authorization credential, validated fresh by identity-vessel (identityCredential, cache:false, the
//     check operatorCredential makes), must carry the dedicated scope VERDICT_CORPUS_WRITE_SCOPE, which identity
//     issues only to goal-host's own key. Identity answers a key issued without scopes with the default read/write,
//     and an answer without scopes reads as none here, so no default ever satisfies the check;
//   - this node's own key (node-self) is never the runner (every vessel on the node holds it), and a credential with
//     the admin scope is never the runner either, even if it also carries the scope: operators are refused, so
//     clearing a hold needs a green run, which needs the judge to be right.
// The scope is the whole authority: no allowlist row is read (a verdictCorpusWriter row, if one exists, stays an
// operator-only trust-root record and grants nothing).
// The grant is a frozen object this module mints and remembers in a WeakSet, so it cannot arrive in JSON and an
// in-process caller that holds no grant (the generic poolImpulse_write case) is refused like any other.
// `source: 'verdictCorpusRun'` is required on the write. It is a LABEL naming the runner path, not authority: this
// vessel cannot see inside goal-host, so the grant narrows a forger to whatever holds goal-host's credential.
// Every refused write is RECORDED: a server-written `verdictCorpusWriteRefusal` row per principal (count, first/last
// time, last reason), readable like any pool row and never writable from outside. Reads of both shapes stay open.
export const VERDICT_CORPUS_STATUS_SHAPE = 'verdictCorpusStatus';
/** The one status row per store (goal-host reads it by this id). */
export const VERDICT_CORPUS_STATUS_ID = 'verdictCorpusStatus';
export const VERDICT_CORPUS_WRITER_SHAPE = 'verdictCorpusWriter';
/** The identity scope that makes a key the corpus runner (domain:action, as "verdict:human" and "operator:direct"). */
export const VERDICT_CORPUS_WRITE_SCOPE = 'verdict-corpus:write';
export const VERDICT_CORPUS_WRITER_PRINCIPAL = 'goal-host-vessel';
export const VERDICT_CORPUS_RUN_SOURCE = 'verdictCorpusRun';
export const VERDICT_CORPUS_REFUSAL_SHAPE = 'verdictCorpusWriteRefusal';
const VERDICT_CORPUS_REFUSAL_ID_PREFIX = 'verdictCorpusWriteRefusal:';
/** Shapes only the runner grant (status) or this module itself (refusals) writes. */
export const RUNNER_ONLY_POOL_SHAPES: ReadonlySet<string> = new Set([VERDICT_CORPUS_STATUS_SHAPE, VERDICT_CORPUS_REFUSAL_SHAPE]);

export interface VerdictCorpusWriterGrant { readonly key_id: string | null; readonly principal: string }
const runnerGrants = new WeakSet<object>();
function mintRunnerGrant(key_id: string | null, principal: string): VerdictCorpusWriterGrant {
  const g = Object.freeze({ key_id, principal });
  runnerGrants.add(g);
  return g;
}
/** Tests only: a grant without asking identity. Not reachable from any request. */
export function __mintVerdictCorpusWriterGrantForTests(key_id: string): VerdictCorpusWriterGrant {
  return mintRunnerGrant(key_id, VERDICT_CORPUS_WRITER_PRINCIPAL);
}

/** The caller as a refusal record names it: identity's key id, node-self, or unauthenticated. Nothing derived from a key. */
export function poolCallerLabel(cred: CallerCredential | null | undefined): string {
  if (!cred) return 'in-process';
  if (!cred.authenticated) return 'unauthenticated';
  if (isNodeSelfCredential(cred)) return 'node-self';
  return cred.keyId ? `key_id:${cred.keyId}` : `scopes:${[...cred.scopes].sort().join(',') || 'none'}`;
}

/** Whether `row` carries a stamp by `by` whose signature verifies under THIS node's key (operator-hold's check,
 *  kept here so the store does not import its readers). */
export function verifyPoolAttestation(row: StandingImpulse, by: 'operator' | 'runner'): { ok: true } | { ok: false; why: string } {
  const a = row.attested;
  if (!a) return { ok: false, why: 'unattested' };
  if (a.by !== by) return { ok: false, why: `attested by ${String(a.by)}, not by ${by}` };
  if (typeof a.sig !== 'string' || a.sig.length === 0) return { ok: false, why: 'stamp is unsigned' };
  const key = nodeKey();
  if (!key) return { ok: false, why: 'no node key to verify the stamp with' };
  const want = Buffer.from(attestationSig(key, row, a.key_id ?? null, a.at), 'utf8');
  const got = Buffer.from(a.sig, 'utf8');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, why: 'stamp signature does not verify' };
  return { ok: true };
}

/** The runner decision over a validated credential (pure): authenticated, not node-self, not admin, and carrying
 *  VERDICT_CORPUS_WRITE_SCOPE explicitly. */
export function verdictCorpusWriterDecision(cred: CallerCredential | null | undefined): { admit: true; key_id: string | null } | { admit: false; why: string } {
  if (!cred || cred.authenticated !== true) return { admit: false, why: cred?.why ? `not authenticated (${cred.why})` : 'not authenticated' };
  if (isNodeSelfCredential(cred)) return { admit: false, why: "this node's own key is never the corpus runner" };
  const scopes = Array.isArray(cred.scopes) ? cred.scopes : [];
  if (scopes.includes('admin')) return { admit: false, why: 'an operator (admin) credential is never the corpus runner' };
  if (!scopes.includes(VERDICT_CORPUS_WRITE_SCOPE)) return { admit: false, why: `credential lacks the ${VERDICT_CORPUS_WRITE_SCOPE} scope` };
  return { admit: true, key_id: cred.keyId ?? null };
}

/** The runner grant for the request's Authorization header, or null and why; `principal` names the caller for the
 *  refusal record. Asked fresh every time (a status write is rare and must see a revocation at once). */
export async function verdictCorpusWriterGrant(authHeader: string | undefined): Promise<{ grant: VerdictCorpusWriterGrant | null; principal: string; why?: string }> {
  const cred = await identityCredential(authHeader, { cache: false });
  const principal = poolCallerLabel(cred);
  const d = verdictCorpusWriterDecision(cred);
  return d.admit ? { grant: mintRunnerGrant(d.key_id, VERDICT_CORPUS_WRITER_PRINCIPAL), principal } : { grant: null, principal, why: d.why };
}

/** The runner-only shape a write would create or modify (its own shape, its reserved id, or the shape of the row its id
 *  names), or null. */
export function runnerOnlyWriteShape(pointer: { id?: string; shape?: string }): string | null {
  if (typeof pointer.shape === 'string' && RUNNER_ONLY_POOL_SHAPES.has(pointer.shape)) return pointer.shape;
  if (pointer.id === VERDICT_CORPUS_STATUS_ID) return VERDICT_CORPUS_STATUS_SHAPE;
  if (typeof pointer.id === 'string' && pointer.id.startsWith(VERDICT_CORPUS_REFUSAL_ID_PREFIX)) return VERDICT_CORPUS_REFUSAL_SHAPE;
  if (typeof pointer.id === 'string') {
    const existing = loadImpulses().find((imp) => imp.id === pointer.id);
    if (existing && RUNNER_ONLY_POOL_SHAPES.has(existing.shape)) return existing.shape;
  }
  return null;
}

/** Record a refused runner-only write: one row per caller, upserted (bounded by distinct authenticated principals). */
function recordRunnerRefusal(principal: string, why: string, attemptedId: string): void {
  try {
    const all = loadImpulses();
    const now = new Date().toISOString();
    const id = VERDICT_CORPUS_REFUSAL_ID_PREFIX + principal;
    const idx = all.findIndex((imp) => imp.id === id);
    const prev = (idx >= 0 && all[idx]!.body !== null && typeof all[idx]!.body === 'object' ? all[idx]!.body : {}) as Record<string, unknown>;
    const body = { principal, count: (typeof prev['count'] === 'number' ? prev['count'] : 0) + 1, first_at: typeof prev['first_at'] === 'string' ? prev['first_at'] : now, last_at: now, last_why: why, last_attempted_id: attemptedId };
    const row: StandingImpulse = { id, shape: VERDICT_CORPUS_REFUSAL_SHAPE, body, source: 'pool-impulse', status: 'open', injected_at: idx >= 0 ? all[idx]!.injected_at : now, updated_at: now };
    if (idx >= 0) all[idx] = row; else all.push(row);
    saveImpulses(all);
  } catch (err) {
    console.error(`[pool] could not record the refused verdictCorpusStatus write by ${principal}: ${String((err as Error)?.message ?? err)}`);
  }
}

/** What a verdictCorpusStatus body must carry for the reader to interpret it (credit-hold.ts holdView); [] when valid. */
export function verdictCorpusStatusProblems(body: unknown): string[] {
  const b = (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : null) as Record<string, unknown> | null;
  if (!b) return ['body'];
  const out: string[] = [];
  if (!isoString(b['run_at'])) out.push('run_at');
  if (!Array.isArray(b['holds'])) out.push('holds');
  return out;
}

/** The fields every operatorHold body carries (the gap store's operator_hold vocabulary: by/at/reason, plus what
 *  makes a hold reviewable): hold_id (== the row id), scope, active, by, at, reason, evidence, lift, review_by, harm. */
export const OPERATOR_HOLD_FIELDS: readonly string[] = ['hold_id', 'scope', 'active', 'by', 'at', 'reason', 'evidence', 'lift', 'review_by', 'harm'];
const nonEmptyString = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;
const isoString = (v: unknown): boolean => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));
/**
 * The operatorHold fields a body is missing or carries in the wrong form, in OPERATOR_HOLD_FIELDS order; [] when
 * valid. `rowId` is the id the row is stored under, which hold_id must equal (one record per hold, and a reader
 * that asks for a hold by id must get a body that names the same hold). Shared by the writer (refuses the write) and
 * the reader (src/lib/operator-hold.ts: a malformed row reads held).
 */
export function operatorHoldProblems(rowId: string | undefined, body: unknown): string[] {
  const b = (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const ok: Record<string, boolean> = {
    hold_id: nonEmptyString(b.hold_id) && b.hold_id === rowId,
    scope: nonEmptyString(b.scope),
    active: typeof b.active === 'boolean',
    by: nonEmptyString(b.by),
    at: isoString(b.at),
    reason: nonEmptyString(b.reason),
    evidence: nonEmptyString(b.evidence) || (Array.isArray(b.evidence) && b.evidence.length > 0 && b.evidence.every(nonEmptyString)),
    lift: nonEmptyString(b.lift),
    review_by: isoString(b.review_by),
    harm: typeof b.harm === 'boolean',
  };
  return OPERATOR_HOLD_FIELDS.filter((f) => !ok[f]);
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
}, auth?: PoolWriteAuth, runner?: { grant?: VerdictCorpusWriterGrant | null; principal?: string; why?: string }): { shape: string; body: { ok: boolean; id: string; conflict?: boolean; current_updated_at?: string | null; error?: string; hint?: string; missing?: string[] } } {
  // RUNNER-ONLY SHAPES (the verdict corpus runner grant above). Checked first: a runner-only write is never also a
  // trust-root write, and no operator credential admits one.
  const runnerShape = runnerOnlyWriteShape(pointer);
  const runnerGrant = runner?.grant && runnerGrants.has(runner.grant) ? runner.grant : null;
  if (runnerShape) {
    const principal = runner?.principal ?? (auth ? (auth.key_id ? `key_id:${auth.key_id}` : 'unidentified') : 'in-process');
    const attempted = String(pointer.id ?? '(new)');
    const refuse = (code: string, why: string, hint?: string) => {
      console.warn(`[pool] REFUSED ${runnerShape} write (id=${attempted}) by ${principal}: ${why}`);
      recordRunnerRefusal(principal, `${code}: ${why}`, attempted);
      return { shape: 'poolImpulse_write', body: { ok: false, id: String(pointer.id ?? ''), error: `${code}: ${why}`, ...(hint ? { hint } : {}) } };
    };
    if (runnerShape === VERDICT_CORPUS_REFUSAL_SHAPE) return refuse('runner_principal_required', `${VERDICT_CORPUS_REFUSAL_SHAPE} rows are written only by this store`);
    if (!runnerGrant) return refuse('runner_principal_required', `${VERDICT_CORPUS_STATUS_SHAPE} is written only by ${VERDICT_CORPUS_WRITER_PRINCIPAL}'s own principal publishing a corpus run${runner?.why ? `; ${runner.why}` : ''}`);
    if (pointer.shape !== VERDICT_CORPUS_STATUS_SHAPE || (pointer.id !== undefined && pointer.id !== VERDICT_CORPUS_STATUS_ID)) {
      return refuse('runner_shape_immutable', `the runner writes shape ${VERDICT_CORPUS_STATUS_SHAPE} under id ${VERDICT_CORPUS_STATUS_ID} only`, 'name both shape and id; no other id may hold this shape and this id holds no other shape');
    }
    const existing = loadImpulses().find((imp) => imp.id === VERDICT_CORPUS_STATUS_ID);
    if (existing && existing.shape !== VERDICT_CORPUS_STATUS_SHAPE) return refuse('runner_shape_immutable', `${VERDICT_CORPUS_STATUS_ID} is held by a ${existing.shape} row`);
    if (pointer.source !== VERDICT_CORPUS_RUN_SOURCE) return refuse('runner_principal_required', `a status write names source ${VERDICT_CORPUS_RUN_SOURCE} (the runner path)`);
    if (pointer.status !== undefined && pointer.status !== 'open') return refuse('runner_principal_required', 'the status record is never retired or consumed; a newer run replaces it');
    const missing = verdictCorpusStatusProblems(stripCallerAttestation(pointer.body));
    if (missing.length > 0) {
      console.warn(`[pool] REFUSED ${VERDICT_CORPUS_STATUS_SHAPE} write: invalid ${missing.join(', ')}`);
      return { shape: 'poolImpulse_write', body: { ok: false, id: VERDICT_CORPUS_STATUS_ID, error: `verdict_corpus_status_invalid: missing or invalid ${missing.join(', ')}`, missing, hint: 'a status body carries run_at (ISO) and holds (array)' } };
    }
    pointer = { ...pointer, id: VERDICT_CORPUS_STATUS_ID };
  }
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
  // OPERATOR HOLD SHAPE. Validated on the row as it WOULD be stored (an update keeps the existing body when it sends
  // none, so a status-only retire of a valid hold passes). A malformed hold is refused rather than stored: the reader
  // would read it held anyway, but a refused write tells the operator which fields to supply.
  if ((pointer.shape ?? (idx >= 0 ? all[idx]!.shape : undefined)) === 'operatorHold') {
    const effectiveBody = stripCallerAttestation(pointer.body !== undefined ? pointer.body : idx >= 0 ? all[idx]!.body : null);
    const missing = operatorHoldProblems(id, effectiveBody);
    if (missing.length > 0) {
      console.warn(`[pool] REFUSED operatorHold write (id=${id}): missing ${missing.join(', ')}`);
      return { shape: 'poolImpulse_write', body: { ok: false, id, error: `operator_hold_invalid: missing or invalid ${missing.join(', ')}`, missing, hint: `an operatorHold body carries ${OPERATOR_HOLD_FIELDS.join(', ')}; hold_id equals the row id, at and review_by are ISO timestamps, evidence is a non-empty string or array, active and harm are booleans` } };
    }
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
  // SERVER-SIDE ATTESTATION. Reaching here with trustRoot set means the operator check above passed, and with
  // runnerShape set means the runner grant did (stamped by 'runner' with the grant's key id), so this write is
  // stamped; every other write carries no attestation (a previous stamp is not carried
  // forward either: it attests the write that made it). pointer.attested is never read.
  const attestation: PoolAttestation | null = runnerShape && runnerGrant ? { by: 'runner', key_id: runnerGrant.key_id, at: now }
    : !trustRoot ? null
    : evaluatorGrant ? { by: 'evaluator', evaluator: auth!.evaluator!, key_id: null, at: now }
    : { by: 'operator', key_id: auth?.key_id ?? null, at: now };
  // Signed over the row exactly as stored (below). The key is read here, at write time, never from a
  // value frozen at import. No key: stamp unsigned and say so (refusing would lock the operator out;
  // a reader fails closed on a missing sig anyway).
  const sign = (stored: StandingImpulse): StandingImpulse => {
    if (!stored.attested) return stored;
    const key = nodeKey();
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
