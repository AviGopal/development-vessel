import type { ResolverResult } from "./types.js";
import fs from "node:fs";

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

/**
 * NAMES ARE DATA, NEVER SHELL TEXT (2026-10-03). `only_tests` come from gap rows, which any gap writer
 * authors. They used to reach the shell command as ` -t ${JSON.stringify(pattern)}`: a DOUBLE-quoted
 * string, inside which sh still expands backticks and $VAR, so a test title carrying `systemctl restart x`
 * executed in the live container (as root: the shell producer's unit sets no User=). The shell producer
 * takes one command string and no caller env, so the pattern travels base64-encoded (alphabet
 * [A-Za-z0-9+/=], inert inside single quotes) and is decoded by the shell into ONE argv element:
 * `--test-name-pattern="$(printf %s '<b64>' | base64 -d)"`. The output of a quoted command substitution
 * is never re-expanded or split, and no byte of a name appears in the command text, so neither sh nor
 * the shell producer's lexical containment check ever reads a name as syntax. The `=` form keeps a
 * pattern that starts with '-' from being read as a flag.
 *
 * A name with a control character can never be a bun test title worth matching (and a newline would
 * split the pattern), and an absurd length or count is not a test selection: both are refused with a
 * structured error here and, through the same function, at arm time by substrateGap_write.
 */
export const ONLY_TESTS_MAX_NAMES = 500;
export const ONLY_TEST_NAME_MAX_LENGTH = 1024;
export function onlyTestsProblem(names: unknown): { field: string; detail: string } | null {
  if (!Array.isArray(names)) return null;
  if (names.length > ONLY_TESTS_MAX_NAMES) {
    return { field: "only_tests", detail: `only_tests names ${names.length} tests; at most ${ONLY_TESTS_MAX_NAMES} are accepted` };
  }
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (typeof n !== "string") continue; // ignored downstream, as before
    // eslint-disable-next-line no-control-regex
    const cc = /[\u0000-\u001f\u007f]/.exec(n);
    if (cc) {
      return { field: `only_tests[${i}]`, detail: `only_tests[${i}] contains control character 0x${cc[0].charCodeAt(0).toString(16).padStart(2, "0")}; a test title never does` };
    }
    if (n.length > ONLY_TEST_NAME_MAX_LENGTH) {
      return { field: `only_tests[${i}]`, detail: `only_tests[${i}] is ${n.length} characters; at most ${ONLY_TEST_NAME_MAX_LENGTH} are accepted` };
    }
  }
  return null;
}

/** bun's -t pattern for the named tests: escaped alternation, describe separator joined with a space. */
export function onlyTestsPattern(onlyTests: string[]): string {
  return onlyTests.map((t) => t.split(" > ").join(" ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

/** POSIX single-quoting: nothing inside '...' is special to sh. */
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * THE MUTATION RUNNER (scope earn-in, 2026-10-05). "Covered" means a mutation (WIRING 10-03): a regression class
 * counts as covered only if removing the shipped guard makes an armed test go red. The guard is the change a commit
 * made to one file (the landing that fixed the regression, or the revert that removed it), so the mutation is that
 * commit's diff on that file, REVERSE-APPLIED inside the detached base-tree worktree ($BW): never in the clone, and
 * only on a pinned tree. Prints MUTATION_APPLIED=1 when the file changed, MUTATION_FAILED=1 otherwise (the commit
 * did not touch the file, or its change no longer applies at the pinned tree). sha and file are validated by the
 * caller (MUTATE_SHA_RE / MUTATE_FILE_RE) before they reach this text.
 */
export const MUTATE_SHA_RE = /^[0-9a-f]{7,40}$/;
export const MUTATE_FILE_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
export function mutationRevertScript(sha: string, file: string): string {
  const d = `"$BW.mutation.diff"`;
  return `if git -C "$BW" diff --no-color ${sha}^ ${sha} -- ${shq(file)} > ${d} 2>/dev/null && [ -s ${d} ] && git -C "$BW" apply -R ${d} >/dev/null 2>&1; ` +
    `then echo "MUTATION_APPLIED=1"; else echo "MUTATION_FAILED=1"; fi; rm -f ${d}`;
}

export async function resolveTestSuite(pointer: Record<string, unknown>): Promise<ResolverResult> {
  const rawVessel = typeof pointer.vessel === "string" ? pointer.vessel.trim() : "";
  if (!rawVessel) {
    return { shape: "structuredError", body: { resolver: "test_suite", detail: "vessel is required (e.g. 'repos/goal-host-vessel')" } };
  }
  // Accept both "repos/<v>" and a bare vessel name. The name becomes a path in the shell command, so it
  // must be a plain name (the same rule the gap store uses for a check's vessel).
  const name = rawVessel.replace(/^repos\//, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.includes("..")) {
    return { shape: "structuredError", body: { resolver: "test_suite", failure_mode: "validation_rejected", field: "vessel", detail: "vessel must be a plain vessel name ([A-Za-z0-9_.-], no '..'), optionally prefixed with repos/" } };
  }
  const onlyTestsBad = onlyTestsProblem(pointer.only_tests);
  if (onlyTestsBad) {
    return { shape: "structuredError", body: { resolver: "test_suite", failure_mode: "validation_rejected", field: onlyTestsBad.field, detail: onlyTestsBad.detail } };
  }
  // mutate_revert {sha, file}: the mutation runner (mutationRevertScript). Only on a pinned tree (base_ref), and
  // refused outright when malformed: a mutation silently dropped would run the unmutated tree and read as "survives".
  const mutateRaw = pointer.mutate_revert as { sha?: unknown; file?: unknown } | undefined;
  let mutate: { sha: string; file: string } | null = null;
  if (mutateRaw !== undefined && mutateRaw !== null) {
    const sha = typeof mutateRaw.sha === "string" ? mutateRaw.sha.trim() : "";
    const file = typeof mutateRaw.file === "string" ? mutateRaw.file.trim() : "";
    const pinned = typeof pointer.base_ref === "string" && /^(HEAD|[0-9a-f]{7,40})$/.test(pointer.base_ref.trim());
    if (!pinned || !MUTATE_SHA_RE.test(sha) || !MUTATE_FILE_RE.test(file) || file.includes("..")) {
      return { shape: "structuredError", body: { resolver: "test_suite", failure_mode: "validation_rejected", field: "mutate_revert", detail: "mutate_revert needs base_ref (HEAD or a sha), a commit sha and a vessel-relative file path (no '..'); a mutation runs only on a pinned tree" } };
    }
    mutate = { sha, file };
  }
  const rel = `repos/${name}`;
  const preferredRoot = `${VESSEL_CLONES_ROOT}/${name}`;
  const fallbackRoot = `${SUPER_REPO_ROOT}/repos/${name}`;
  const landedSha = typeof pointer.landed_sha === "string" ? pointer.landed_sha.trim() : undefined;
  const timeoutMs = typeof pointer.timeout_ms === "number" && pointer.timeout_ms > 0 ? pointer.timeout_ms : DEFAULT_TIMEOUT_MS;
  const budgetSec = Math.ceil(timeoutMs / 1000);
  // PER-TEST TIMEOUT: bun defaults to 5000ms, which is a LOAD SENSOR, not a correctness one.
  //
  // Measured 2026-08-29 on this vessel's suite, five full runs at ONE commit with NO code
  // change: 94, 95, 96, 97, 97 failures, wall time 52s -> 325s as the container's load
  // average climbed to 12.75 (the substrate composes concurrently with its own gate). In one
  // run 10 of the 97 failures were literally "timed out after 5000ms" — phantom failures
  // that appear and disappear with ambient load.
  //
  // That is fatal for the caller this resolver exists to serve. precutover_regression stores
  // a baseline of failing tests and refuses when a staged tree adds any, so a baseline taken
  // on an idle container and compared against a staged run on a busy one MANUFACTURES
  // regressions the change did not cause — the false-refusal class fixed in 6d1562c.
  //
  // With 20000ms the same suite reports 94 failures and ZERO timeouts at load 11.6 AND at
  // load 24.4 — identical across a 20x load range, where the 5s default drifted by 3. This
  // does not hide slow tests: `timeout ${budgetSec}` still bounds the whole run, so a
  // genuinely hung test fails the suite rather than silently passing.
  const perTestTimeoutMs = typeof pointer.per_test_timeout_ms === "number" && pointer.per_test_timeout_ms > 0
    ? Math.floor(pointer.per_test_timeout_ms)
    : 20000;

  const shellEndpoint = await discoverShellEndpoint();
  if (!shellEndpoint) {
    return { shape: "structuredError", body: { resolver: "test_suite", detail: "no shellResult producer in discovery — cannot run a suite in-container" } };
  }

  // `|| true` so a red suite returns its OUTPUT rather than an error: a failing suite is a
  // measurement, not a resolver fault. The timeout bounds a hanging suite.
  // Resolve the root in the shell so the existence check happens where the trees live, and
  // ECHO the chosen root + its HEAD into the output — a verdict about "the landed code" is
  // only readable if the trace says which tree and which commit was actually measured.
  // ISOLATION RE-RUN (2026-08-29). `only_tests` narrows the run to named tests via bun's
  // -t filter. It exists for one caller: the precutover regression gate, which re-runs the
  // WHOLE suite to confirm a failure before refusing. A whole-suite re-run cannot
  // discriminate a LOAD-CORRELATED flake, because the second run happens under the same
  // load that produced the first — the confirmation reproduces the artefact and reads as a
  // regression. A test that fails in the full suite but PASSES when run alone is an
  // isolation/load artefact, not a regression the staged change caused. Re-running just
  // the named failures is both cheaper and the only form of that check that discriminates.
  //
  // Names are matched as an escaped alternation, so a title containing regex metacharacters
  // ("apply + gate = PASS") matches literally rather than silently matching nothing —
  // which would look like "it passed in isolation" and wave a real regression through.
  const onlyTests = Array.isArray(pointer.only_tests)
    ? (pointer.only_tests as unknown[]).filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    : [];
  // One test file (relative to the vessel root) instead of the whole suite: a failing-test gap is judged in
  // seconds rather than a suite that exceeds the budget. Path characters only; anything else is ignored.
  const testFile = typeof pointer.test_file === "string" && /^[A-Za-z0-9_./-]+$/.test(pointer.test_file.trim()) && !pointer.test_file.includes("..")
    ? pointer.test_file.trim()
    : "";
  // See onlyTestsPattern / NAMES ARE DATA above: the pattern reaches bun as one argv element decoded by
  // the shell, never as shell text.
  const testFilter = onlyTests.length > 0
    ? ` --test-name-pattern="$(printf %s ${shq(Buffer.from(onlyTestsPattern(onlyTests), "utf8").toString("base64"))} | base64 -d)"`
    : "";
  // BASE-TREE RUN (2026-09-30). `base_ref` ("HEAD" or a commit sha; anything else is ignored) runs the
  // same filtered suite on that COMMITTED tree instead of the clone's working tree, in a detached
  // worktree with the clone's node_modules linked: the uncommitted staged change is excluded by
  // construction and the clone's working tree is never touched (the same mechanism feature_compose uses
  // for its parent-tree runs). For the precutover gate, which must know whether a test an open gap tracks
  // as red was ALREADY red before the staged change. A missing node_modules or a failed worktree add
  // prints no summary, so the result reads ran:false and the caller subtracts nothing.
  const baseRef = typeof pointer.base_ref === "string" && /^(HEAD|[0-9a-f]{7,40})$/.test(pointer.base_ref.trim())
    ? pointer.base_ref.trim()
    : "";
  const bunRun = `env -i PATH="$PATH" HOME="$HOME" NODE_ENV=test TZ=UTC WORKSPACE_ROOT="$(mktemp -d)" timeout ${budgetSec} bun test${testFile ? " " + JSON.stringify(testFile) : ""} --timeout ${perTestTimeoutMs}${testFilter} 2>&1 || true`;
  const command = baseRef
    ? `ROOT=${shq(preferredRoot)}; [ -d "$ROOT" ] || ROOT=${shq(fallbackRoot)}; ` +
      `git -C "$ROOT" worktree prune >/dev/null 2>&1; BW="$(mktemp -d /tmp/test-suite-base-XXXXXX)"; ` +
      `if [ -d "$ROOT/node_modules" ] && git -C "$ROOT" worktree add -q --detach "$BW" ${baseRef} >/dev/null 2>&1; then ` +
      `ln -s "$ROOT/node_modules" "$BW/node_modules"; echo "VERIFIED_ROOT=$BW"; echo "VERIFIED_HEAD=$(git -C "$BW" rev-parse --short HEAD 2>/dev/null || echo unknown)"; ` +
      (mutate
        ? `MUT="$(${mutationRevertScript(mutate.sha, mutate.file)})"; echo "$MUT"; case "$MUT" in *MUTATION_APPLIED=1*) (cd "$BW" && ${bunRun});; esac; fi; `
        : `(cd "$BW" && ${bunRun}); fi; `) +
      `git -C "$ROOT" worktree remove --force "$BW" >/dev/null 2>&1; rm -rf "$BW"; git -C "$ROOT" worktree prune >/dev/null 2>&1; true`
    : `ROOT=${shq(preferredRoot)}; [ -d "$ROOT" ] || ROOT=${shq(fallbackRoot)}; ` +
      `echo "VERIFIED_ROOT=$ROOT"; echo "VERIFIED_HEAD=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"; ` +
      `cd "$ROOT" && ([ -d node_modules ] || timeout 120 bun install >/dev/null 2>&1; ${bunRun})`;

  let raw = "";
  try {
    const res = await fetch(shellEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      // cwd is only the shell's starting directory; the command cd's to the resolved ROOT itself.
      // timeout_sec: without it the shell kills the process group at 30s, before a suite longer than that prints its summary.
      body: JSON.stringify({ impulse: { pointer: { type: "shell", command, cwd: SUPER_REPO_ROOT, timeout_sec: Math.min(budgetSec + 30, 900) } } }),
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
  // Requested tests that did not pass: failing, missing, renamed or deleted all count. A failing-test gap
  // measured by `fail` alone reads a deleted test as fixed; this count stays >0 until the test itself passes.
  const passLines = raw.split("\n").filter((l) => /^\s*\(pass\)/.test(l));
  const requestedNotPassing = onlyTests.length > 0
    ? onlyTests.filter((t) => !passLines.some((l) => l.includes(t))).length
    : null;
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
      test_file: testFile || null,
      base_ref: baseRef || null,
      requested_not_passing: ran || onlyTests.length === 0 ? requestedNotPassing : null,
      // The mutation actually changed the pinned tree's file; a run without it measured nothing about coverage.
      ...(mutate ? { mutation: { sha: mutate.sha, file: mutate.file, applied: /^MUTATION_APPLIED=1$/m.test(raw) } } : {}),
      skip: parsed.skip,
      failingTests: parsed.failingTests.slice(0, 25),
      timestamp: new Date().toISOString(),
    },
  };
}
