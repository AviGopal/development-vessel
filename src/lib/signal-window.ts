/**
 * Shared, fail-closed helpers for detectors and closers that reason over WINDOWED failure-signal
 * counts (slice Y): the verdict-class gap builder (resolvers/verdict-class-gap.ts) and the
 * condition-gone close verdict (resolvers/condition-gone.ts). One place for the three things both
 * need, so the two cannot drift apart:
 *
 *  1. MEASURED COUNTS. A count is usable only when its read said `measured: true` and the value is
 *     a finite, non-negative number. Anything else (a failed query, a dead table, a NaN, a missing
 *     field) is `null` = unknown, and unknown never reads as zero. "Unknown → allow" is the
 *     recurring bug this exists to make unrepresentable: a silent zero would file nothing that
 *     should be filed, or close a gap whose condition was never measured.
 *
 *     ADDRESSES: where a count was read (signature filter hash + org); counts are comparable only
 *     through the same address.
 *
 *  2. WINDOWS. Hours since an ISO instant, capped at the trace store's useful horizon. An
 *     unparseable or future instant is `null`, never 0 and never "all of history".
 *
 *  3. SHAPED POLICY. Thresholds are a shaped policy read at USE time (law 1), not env and not
 *     constants: `<live super-repo clone>/policies/<name>.json`, the one directory goal-host's
 *     shaped policies already live in, located by write-containment's own containmentZones. That
 *     clone is the zone containWrite refuses ALWAYS (no grant opens it), so no tool, and so no walk,
 *     can loosen a threshold. web-resource's webResourceAllowlist
 *     reads through the same readPolicyFile and keeps its own fallback (its bootstrap list).
 *       - no clone on this node, or no file      → the documented defaults, and the answer says so;
 *       - a file that is unreadable, unparseable, carries an unknown key, or a field out of its
 *         range, or a name that is not a policy name → `ok: false`. The caller must then do NOTHING
 *         (file no gap, close no gap). Falling back to defaults over a broken operator file would
 *         be fail-open: the operator's intent is unknown, so nothing is decided.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { containmentZones } from "../resolvers/write-containment.js";

// ── 1. measured counts ─────────────────────────────────────────────────────────────────────────

/** One windowed count as traceAggregateReport / trace_failure_pattern_report answer it. */
export interface MeasuredCount {
  matched_total: number | null;
  measured: boolean;
}

/** A finite, non-negative number, else null (unknown). Never coerces strings or booleans. */
export function knownCount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** The value of a windowed read, or null when the read is not KNOWN to have measured it. */
export function measuredValue(w: Partial<MeasuredCount> | null | undefined): number | null {
  if (!w || typeof w !== "object" || w.measured !== true) return null;
  return knownCount(w.matched_total);
}

/**
 * WHERE a count was read: the signature's filter (its input with the window, paging and output
 * keys removed, hashed canonically) and the org the read was scoped to. Two counts are
 * comparable only when their addresses are equal: a zero through another org, or a baseline
 * recorded for a different filter, says nothing about this signature.
 */
export interface SignalAddress {
  input_hash: string;
  org: string;
}

/** Keys that move a read in time or shape its output, never what it counts. */
const NON_SIGNATURE_KEYS = new Set(["window_hours", "until_hours_ago", "limit", "max_count", "emit_gap", "mode"]);

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function signalAddress(input: Record<string, unknown>, org: string): SignalAddress {
  const sig: Record<string, unknown> = {};
  for (const k of Object.keys(input ?? {})) if (!NON_SIGNATURE_KEYS.has(k)) sig[k] = input[k];
  return { input_hash: `sha256:${createHash("sha256").update(canonical(sig)).digest("hex")}`, org: String(org ?? "") };
}

/** Equal, non-empty addresses. Anything missing or malformed is NOT the same address. */
export function sameAddress(a: unknown, b: unknown): boolean {
  const ok = (x: unknown): x is SignalAddress =>
    !!x && typeof x === "object" && typeof (x as SignalAddress).input_hash === "string" && (x as SignalAddress).input_hash.length > 0 &&
    typeof (x as SignalAddress).org === "string" && (x as SignalAddress).org.length > 0;
  return ok(a) && ok(b) && a.input_hash === b.input_hash && a.org === b.org;
}

// ── 2. windows ─────────────────────────────────────────────────────────────────────────────────

/** The longest window any signal read asks for: about the trace store's retained horizon. */
export const MAX_WINDOW_HOURS = 720;

/** An ISO-8601 instant with a time and an explicit zone: the only form a window may anchor on. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Whole hours from `iso` to `now`, rounded UP (a window must cover the instant), capped at
 * MAX_WINDOW_HOURS. Null when `iso` is not an ISO instant with time and zone (Date.parse reads
 * "0" as the year 2000 and a bare date as local midnight), or lies in the future.
 */
export function hoursSince(iso: unknown, now: number = Date.now()): number | null {
  if (typeof iso !== "string" || !ISO_INSTANT.test(iso.trim())) return null;
  const t = Date.parse(iso.trim());
  if (!Number.isFinite(t) || t > now) return null;
  return Math.min(MAX_WINDOW_HOURS, Math.max(1, Math.ceil((now - t) / 3_600_000)));
}

// ── 3. shaped policy ───────────────────────────────────────────────────────────────────────────

export type PolicyField =
  | { kind: "int"; min: number; max: number }
  | { kind: "globs"; max_items: number };

export type PolicySpec<T> = { [K in keyof T]: PolicyField };

/** A token glob: the canonical verdict-token alphabet (lowercase alphanumerics, `_`, `-`) plus `*`. */
const GLOB = /^[a-z0-9_*-]{1,64}$/;

function fieldOk(v: unknown, f: PolicyField): boolean {
  if (f.kind === "int") return typeof v === "number" && Number.isInteger(v) && v >= f.min && v <= f.max;
  return Array.isArray(v) && v.length <= f.max_items && v.every((g) => typeof g === "string" && GLOB.test(g));
}

/** Keys an operator may add for the record; never read as behaviour. */
const NOTE_KEYS = new Set(["reason", "note"]);

/**
 * Validates a policy object against its spec, filling ABSENT fields from `defaults`.
 * Fails closed: a non-object, an unknown key (a typo would otherwise silently keep a default),
 * or any present field outside its range refuses the whole policy.
 */
export function validatePolicy<T extends object>(raw: unknown, defaults: T, spec: PolicySpec<T>): { ok: true; policy: T } | { ok: false; why: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, why: "policy is not an object" };
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!Object.hasOwn(spec, k) && !NOTE_KEYS.has(k)) return { ok: false, why: `unknown policy key "${k}"` };
  }
  const out = { ...defaults } as Record<string, unknown>;
  for (const k of Object.keys(spec) as Array<keyof T & string>) {
    const f = spec[k];
    if (!Object.hasOwn(o, k)) {
      if (!fieldOk(out[k], f)) return { ok: false, why: `default for "${k}" is out of range` };
      continue;
    }
    if (!fieldOk(o[k], f)) return { ok: false, why: `policy field "${k}" is out of range or of the wrong type` };
    out[k] = Array.isArray(o[k]) ? [...(o[k] as unknown[])] : o[k];
  }
  return { ok: true, policy: out as T };
}

export type ShapedPolicy<T> =
  | { ok: true; policy: T; source: "policy" | "default"; path: string | null; note?: string }
  | { ok: false; why: string; path: string | null };

const POLICY_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** `<live super-repo clone>/policies/<name>.json`, or null when this node has no such clone or the name is not a policy name. */
export function shapedPolicyPath(name: string, env: Record<string, string | undefined> = process.env): string | null {
  if (!POLICY_NAME.test(name)) return null;
  const superRepo = containmentZones(env).supers[0];
  return superRepo ? join(superRepo, "policies", `${name}.json`) : null;
}

/**
 * What is on the volume for the shaped policy `name`, BEFORE any caller decides what an absent or
 * broken file means. The one reader both fallback choices build on: web-resource falls back to its
 * bootstrap list on anything but `parsed`; the slice-Y policies fail closed on `unreadable` /
 * `unparseable` / `bad_name`.
 */
export type PolicyFile =
  | { state: "bad_name"; path: null }
  | { state: "no_clone"; path: null }
  | { state: "absent"; path: string }
  | { state: "unreadable"; path: string; why: string }
  | { state: "unparseable"; path: string }
  | { state: "parsed"; path: string; value: unknown };

export async function readPolicyFile(name: string, env: Record<string, string | undefined> = process.env): Promise<PolicyFile> {
  if (!POLICY_NAME.test(name)) return { state: "bad_name", path: null };
  const path = shapedPolicyPath(name, env);
  if (!path) return { state: "no_clone", path: null };
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { state: "absent", path };
    return { state: "unreadable", path, why: (err as Error).message };
  }
  try {
    return { state: "parsed", path, value: JSON.parse(raw) as unknown };
  } catch {
    return { state: "unparseable", path };
  }
}

/** Reads and validates the shaped policy `name` at use time, failing closed (see the header). */
export async function readShapedPolicy<T extends object>(
  name: string,
  defaults: T,
  spec: PolicySpec<T>,
  env: Record<string, string | undefined> = process.env,
): Promise<ShapedPolicy<T>> {
  const f = await readPolicyFile(name, env);
  const fromDefaults = (note: string): ShapedPolicy<T> => {
    const v = validatePolicy({}, defaults, spec);
    return v.ok ? { ok: true, policy: v.policy, source: "default", path: f.path, note } : { ok: false, why: v.why, path: f.path };
  };
  switch (f.state) {
    case "bad_name": return { ok: false, why: `"${name}" is not a policy name`, path: null };
    case "no_clone": return fromDefaults(`no live super-repo clone on this node to hold a ${name} policy; the defaults apply`);
    case "absent": return fromDefaults(`no ${name} policy file; the defaults apply`);
    // Present but unreadable or broken: the operator's intent is unknown, so nothing is decided.
    case "unreadable": return { ok: false, why: `${name} policy unreadable: ${f.why}`, path: f.path };
    case "unparseable": return { ok: false, why: `${name} policy is not valid JSON`, path: f.path };
    case "parsed": {
      const v = validatePolicy(f.value, defaults, spec);
      return v.ok ? { ok: true, policy: v.policy, source: "policy", path: f.path } : { ok: false, why: `${name}: ${v.why}`, path: f.path };
    }
  }
}
