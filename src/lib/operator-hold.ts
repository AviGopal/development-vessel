// operator-hold: the in-process reader of operatorHold pool records, and the live-tree predicate the
// patch_with_tools entry gate uses with it.
//
// A HOLD FAILS CLOSED. The record is an operator-attested pool row (pool-impulse.ts: operatorHold is a
// trust-root shape, so only an admin credential writes one and the writer signs it under this node's key).
// The reader answers held unless the newest LOCAL open row for the id is a valid hold body with
// active:false AND an operator stamp whose signature verifies here:
//   absent / retired ........... held ("hold record absent: default held")
//   unreadable / throws ........ held
//   malformed / wrong scope .... held
//   active:true ................ held
//   active:false, unattested, evaluator-stamped, unsigned, forged, or no node key to verify with
//                                held, and the ignored lift is logged
//   active:false + operator stamp that verifies ...... lifted
// The record is read FRESH on every call (one local JSON read): a lift is never cached, so a re-hold takes
// effect on the next call. Only the journal line is rate-limited: one line per (id, decision), repeated at
// most every 30 s, and always on a change of decision.
//
// A LEAF MODULE. It imports only the pool store, the vendored write-containment zones and node:, so the
// patch_with_tools import graph stays as it was (nothing from gap-to-feature / feature-compose).
import { timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { resolvePoolImpulse, attestationSig, operatorHoldProblems, type StandingImpulse } from "../resolvers/pool-impulse.js";
import { containmentZones, zoneOf, realLocation, type Zones } from "../resolvers/write-containment.js";

export interface OperatorHoldDecision {
  held: boolean;
  why: string;
  /** The row the decision was made from, when one was found. */
  record?: StandingImpulse;
}

const LOG_EVERY_MS = 30_000;
const lastLog = new Map<string, { decision: string; at: number }>();
/** Tests only: forget the rate-limited log state. */
export function __resetOperatorHoldLogForTests(): void { lastLog.clear(); }

function logDecision(holdId: string, found: boolean, d: OperatorHoldDecision): void {
  const decision = `${d.held ? "held" : "lifted"} (${d.why})`;
  const prev = lastLog.get(holdId);
  const now = Date.now();
  if (prev && prev.decision === decision && now - prev.at < LOG_EVERY_MS) return;
  lastLog.set(holdId, { decision, at: now });
  console.log(`[operator-hold] ${holdId}: record ${found ? "found" : "ABSENT"} → ${decision}`);
}

/** Whether a row's attestation is an operator stamp this node can verify: by === 'operator', signed, and the
 *  signature recomputed under this node's METABOB_API_KEY (read now, as the writer reads it) matches. */
export function verifyOperatorAttestation(row: StandingImpulse): { ok: true } | { ok: false; why: string } {
  const a = row.attested;
  if (!a) return { ok: false, why: "unattested" };
  if (a.by !== "operator") return { ok: false, why: `attested by ${String(a.by)}, not by an operator` };
  if (typeof a.sig !== "string" || a.sig.length === 0) return { ok: false, why: "operator stamp is unsigned" };
  const key = process.env["METABOB_API_KEY"] ?? "";
  if (!key) return { ok: false, why: "no node key to verify the operator stamp with" };
  const expected = attestationSig(key, row, a.key_id ?? null, a.at);
  const got = Buffer.from(a.sig, "utf8");
  const want = Buffer.from(expected, "utf8");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, why: "operator stamp signature does not verify" };
  return { ok: true };
}

/**
 * The hold named `holdId`, read in process from this node's pool store. `opts.scope`, when given, must equal the
 * body's scope (a row written for a different hold cannot lift this one). Never throws.
 */
export function readOperatorHold(holdId: string, opts: { scope?: string } = {}): OperatorHoldDecision {
  let row: StandingImpulse | undefined;
  try {
    row = resolvePoolImpulse({ type: "poolImpulse", id: holdId, shape: "operatorHold", status: "open", limit: 1 }).body.impulses[0];
  } catch (err) {
    const d = { held: true, why: `hold record unreadable (${String((err as Error)?.message ?? err)}): default held` };
    logDecision(holdId, false, d);
    return d;
  }
  if (!row) {
    const d = { held: true, why: "hold record absent: default held" };
    logDecision(holdId, false, d);
    return d;
  }
  const decide = (): OperatorHoldDecision => {
    const problems = operatorHoldProblems(holdId, row!.body);
    if (problems.length > 0) return { held: true, why: `hold record malformed (missing or invalid ${problems.join(", ")}): default held`, record: row };
    const b = row!.body as Record<string, unknown>;
    if (opts.scope !== undefined && b.scope !== opts.scope) return { held: true, why: `hold record scope ${String(b.scope)} is not ${opts.scope}: default held`, record: row };
    if (b.active === true) return { held: true, why: `active since ${String(b.at)} by ${String(b.by)}; lift: ${String(b.lift)}`, record: row };
    const v = verifyOperatorAttestation(row!);
    if (!v.ok) {
      console.warn(`[operator-hold] ${holdId}: active:false IGNORED (${v.why}); only an operator-attested lift lifts a hold`);
      return { held: true, why: `lift ignored: ${v.why}`, record: row };
    }
    return { held: false, why: `operator-attested lift at ${String(row!.attested!.at)} (key ${String(row!.attested!.key_id ?? "-")})`, record: row };
  };
  let d: OperatorHoldDecision;
  try { d = decide(); } catch (err) { d = { held: true, why: `hold record unreadable (${String((err as Error)?.message ?? err)}): default held`, record: row }; }
  logDecision(holdId, true, d);
  return d;
}

// ---------------------------------------------------------------------------------------------------------------
// THE LIVE-TREE PREDICATE for a vessels_root. Classified by where the root really lives (realpath; a not-yet-
// existing root by its nearest existing ancestor), with the same zones write-containment uses:
//   compose (COMPOSE_WS_DIR, /workspace/git/compose) ..... "compose": an isolated worktree, writable while held
//   runtime (MITOSIS_RUNTIME_DIR, /vessels) .............. "live": gated by the hold
//   under no zone, under the OS temp dir ................. "sandbox": a test sandbox, writable while held. The
//       resolve route already refuses any vessels_root outside the runtime and compose roots, so this is
//       reachable only by in-process callers, and nothing under it is a running vessel.
//   anything else (push clones, the super-repo clone, any other path) ... "live": the fail-closed default
// Zones are tested before the sandbox, so a runtime or compose root that itself lies under the temp dir keeps
// its zone.
// ---------------------------------------------------------------------------------------------------------------
export type VesselsRootClass = { kind: "live" | "compose" | "sandbox"; real: string; zone: string | null };

let zonesOverride: Zones | null = null;
/** Tests only: the zones the predicate classifies against (null: the process's own settings). */
export function __setLiveTreeZonesForTests(z: Zones | null): void { zonesOverride = z; }

function within(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function classifyVesselsRoot(vesselsRoot: string): VesselsRootClass {
  const real = realLocation(vesselsRoot) ?? resolve(vesselsRoot);
  let zones: Zones;
  try { zones = zonesOverride ?? containmentZones(process.env); } catch { return { kind: "live", real, zone: null }; }
  const z = zoneOf(real, zones);
  if (z?.zone === "compose") return { kind: "compose", real, zone: "compose" };
  if (z) return { kind: "live", real, zone: z.zone };
  let tmp: string;
  try { tmp = realpathSync(tmpdir()); } catch { tmp = resolve(tmpdir()); }
  if (tmp !== "/" && within(real, tmp)) return { kind: "sandbox", real, zone: null };
  return { kind: "live", real, zone: null };
}
