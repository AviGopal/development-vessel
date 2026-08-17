import type { ResolverResult } from "./types.js";

/**
 * Resolver for the `test_suite` shape — runs a vessel's test suite INSIDE the container
 * and reports the outcome as a shaped impulse.
 *
 * WHY THIS SHAPE EXISTS (and why it is a repair, not a mint):
 * Post-landing verification of a substrate-authored change used to happen only out-of-band —
 * GitHub Actions (outside every vessel, untraced, outcome delivered by an env-gated webhook)
 * and `scripts/substrate/host-pull-sync.sh` (host-side, detection-only, writes an operator
 * log and emits nothing). Neither produces a shape or a trace, so no post-landing outcome
 * ever entered the substrate as something the learning loop could observe or grade — which
 * is precisely why the fitness of a landed change was not computable from activity outcomes.
 * External CI is an antipattern here unless it runs on a compliant container vessel.
 *
 * This resolver already existed but had never run: it was unadvertised, undispatchable, and
 * fetched `/api/test-store/summaries`, an endpoint that does not exist anywhere in the fleet.
 * It is repaired rather than replaced so the shape vocabulary does not gain a duplicate
 * producer (reuse before mint) — a second suite-reporting shape would split selection traffic
 * and start a fresh, uninformed posterior.
 *
 * Runs `bun test` through the shell tool — the same in-container primitive feature_compose
 * and vessel_mitosis_evaluate already use for their own verification — so the work happens
 * where the code lives and lands in a trace like any other activity execution.
 *
 * Pointer:
 *   vessel      (required) e.g. "repos/goal-host-vessel", or a bare vessel name
 *   landed_sha  (optional) the commit this outcome attributes to — the join key that makes
 *               change fitness computable; without it the report is a bare suite snapshot
 *   gap_id / proposal_id (optional) provenance carried through from the cutover
 *   timeout_ms  (optional) suite budget, default 240000
 */

const DISCOVERY_ENDPOINT = process.env.DISCOVERY_VESSEL_ENDPOINT ?? "http://127.0.0.1:8100";
const METABOB_API_KEY = process.env.METABOB_API_KEY ?? process.env.API_KEY ?? "";
// WHICH TREE TO VERIFY — this choice decides whether the verdict means anything.
// Three copies of a vessel's source coexist in the container and they DRIFT:
//   /workspace/git/vessels/<v>            pull-sync's per-vessel clone — tracks origin/dev
//   /workspace/git/super-repo/repos/<v>   a submodule of the super-repo — lags badly
//   /vessels/<v>                          the deployed runtime mirror, no repos/ prefix
// Measured while bringing this resolver up: the per-vessel clone was at a9742a9 (current)
// while the super-repo submodule was still at 42547b2 from two days earlier. Verifying the
// submodule reported 9 failures that no longer existed on the landed code — a confidently
// wrong post-landing verdict, which would have filed a regression gap against a commit that
// did not cause it. Prefer the per-vessel clone; fall back to the submodule only if absent.
const VESSEL_CLONES_ROOT = process.env.MITOSIS_VESSEL_CLONES ?? "/workspace/git/vessels";
const SUPER_REPO_ROOT = process.env.MITOSIS_REPO_ROOT ?? "/workspace/git/super-repo";
const DEFAULT_TIMEOUT_MS = 240_000;

async function discoverShellEndpoint(): Promise<string | null> {
  try {
    const r = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "shellResult" } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as {
      content?: { vessels?: Array<{ endpoint: string; resolve_endpoint?: string; health_score?: number }> };
    };
    const vs = (data.content?.vessels ?? []).sort((a, b) => (b.health_score ?? 0) - (a.health_score ?? 0));
    const best = vs[0];
    if (!best) return null;
    const ep = best.resolve_endpoint ?? "/resolve";
    return ep.startsWith("http") ? ep : `${best.endpoint.replace(/\/$/, "")}${ep.startsWith("/") ? ep : `/${ep}`}`;
  } catch {
    return null;
  }
}

/**
 * Parse bun's summary. Counts are read from the SUMMARY lines rather than by tallying
 * `(fail)` lines, because a suite that fails to load emits FEWER per-test lines, not more —
 * so a failure-only reading cannot distinguish "tests fixed" from "tests deleted or
 * module-load broken". `pass` is the number that catches coverage disappearing.
 */
export function parseBunSummary(raw: string): { total: number; pass: number; fail: number; skip: number; failingTests: string[] } {
  const lastNum = (label: string): number => {
    let out = 0;
    for (const line of raw.split("\n")) {
      const m = line.match(new RegExp(`^\\s*(\\d+)\\s+${label}\\b`));
      if (m && m[1]) out = parseInt(m[1], 10);
    }
    return out;
  };
  const pass = lastNum("pass");
  const fail = lastNum("fail");
  const skip = lastNum("skip");
  // Deduplicate: bun prints each failure twice (inline, then again in the summary block),
  // which doubled the list and made 9 real failures look like 18.
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!/^\s*\(fail\)/.test(line)) continue;
    seen.add(line.replace(/\s*\[[\d.]+m?s\]\s*$/, "").trim());
  }
  return { total: pass + fail + skip, pass, fail, skip, failingTests: [...seen] };
}

export async function resolveTestSuite(pointer: Record<string, unknown>): Promise<ResolverResult> {
  const rawVessel = typeof pointer.vessel === "string" ? pointer.vessel.trim() : "";
  if (!rawVessel) {
    return { shape: "structuredError", body: { resolver: "test_suite", detail: "vessel is required (e.g. 'repos/goal-host-vessel')" } };
  }
  // Accept both "repos/<v>" and a bare vessel name.
  const name = rawVessel.replace(/^repos\//, "");
  const rel = `repos/${name}`;
  const preferredRoot = `${VESSEL_CLONES_ROOT}/${name}`;
  const fallbackRoot = `${SUPER_REPO_ROOT}/repos/${name}`;
  const landedSha = typeof pointer.landed_sha === "string" ? pointer.landed_sha.trim() : undefined;
  const timeoutMs = typeof pointer.timeout_ms === "number" && pointer.timeout_ms > 0 ? pointer.timeout_ms : DEFAULT_TIMEOUT_MS;
  const budgetSec = Math.ceil(timeoutMs / 1000);

  const shellEndpoint = await discoverShellEndpoint();
  if (!shellEndpoint) {
    return { shape: "structuredError", body: { resolver: "test_suite", detail: "no shellResult producer in discovery — cannot run a suite in-container" } };
  }

  // `|| true` so a red suite returns its OUTPUT rather than an error: a failing suite is a
  // measurement, not a resolver fault. The timeout bounds a hanging suite.
  // Resolve the root in the shell so the existence check happens where the trees live, and
  // ECHO the chosen root + its HEAD into the output — a verdict about "the landed code" is
  // only readable if the trace says which tree and which commit was actually measured.
  const command =
    `ROOT=${JSON.stringify(preferredRoot)}; [ -d "$ROOT" ] || ROOT=${JSON.stringify(fallbackRoot)}; ` +
    `echo "VERIFIED_ROOT=$ROOT"; echo "VERIFIED_HEAD=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"; ` +
    `cd "$ROOT" && ([ -d node_modules ] || timeout 120 bun install >/dev/null 2>&1; timeout ${budgetSec} bun test 2>&1 || true)`;

  let raw = "";
  try {
    const res = await fetch(shellEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      // cwd is only the shell's starting directory; the command cd's to the resolved ROOT itself.
      body: JSON.stringify({ impulse: { pointer: { type: "shell", command, cwd: SUPER_REPO_ROOT } } }),
      signal: AbortSignal.timeout(timeoutMs + 30_000),
    });
    const j = (await res.json().catch(() => ({}))) as { stdout?: unknown; body?: { stdout?: unknown } };
    // The shell producer returns stdout at the TOP level of the response — that is what
    // feature_compose (the proven caller of this same tool) reads. Accept the nested form
    // too so a producer that wraps its payload does not silently yield an empty string,
    // which would surface as ran:false and read as "the suite is missing" rather than
    // "I called it wrong". Observed exactly that on first live probe.
    raw = String(j?.stdout ?? j?.body?.stdout ?? "");
  } catch (err) {
    return { shape: "structuredError", body: { resolver: "test_suite", vessel: rel, detail: `shell dispatch failed: ${(err as Error).message}` } };
  }

  const parsed = parseBunSummary(raw);
  // A suite that printed no summary at all did not run — do NOT report 0/0/0 as a clean
  // result, or "the suite is missing" becomes indistinguishable from "everything passed".
  const ran = /\d+\s+(pass|fail)\b/.test(raw);

  return {
    shape: "test_suite",
    body: {
      vessel: rel,
      // WHICH tree and commit were measured. Without these a suite result cannot be tied to
      // the code it describes, and a stale-tree verdict is indistinguishable from a real one.
      verified_root: raw.match(/^VERIFIED_ROOT=(.+)$/m)?.[1]?.trim() ?? null,
      verified_head: raw.match(/^VERIFIED_HEAD=(.+)$/m)?.[1]?.trim() ?? null,
      landed_sha: typeof pointer.landed_sha === "string" ? pointer.landed_sha : null,
      gap_id: typeof pointer.gap_id === "string" ? pointer.gap_id : null,
      proposal_id: typeof pointer.proposal_id === "string" ? pointer.proposal_id : null,
      ran,
      total: parsed.total,
      pass: parsed.pass,
      fail: parsed.fail,
      skip: parsed.skip,
      failingTests: parsed.failingTests.slice(0, 25),
      timestamp: new Date().toISOString(),
    },
  };
}
