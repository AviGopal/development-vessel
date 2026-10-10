// SHARED GATE-VERSION DEFAULT FOR THE CUTOVER SUITES (test setup, not a test file).
//
// The cutover refuses to land while the landing gate the process RUNS differs from the gate its
// clone ACCEPTED (gate_version_stale), and refuses when either cannot be measured
// (gate_version_unmeasurable) — see cutover-gate-version-stale.test.ts for that contract. A cutover
// unit test's fixture has no development-vessel clone and no real process start, so with the real
// readers every cutover test would refuse on the gate instead of testing its own subject.
//
// installGateVersionDefault() installs a fixed EQUAL pair (running == accepted ==
// FIXTURE_GATE_VERSION) on the cutover's DEFAULT layer (__setGateVersionDefaultForTests), which
// sits UNDER the per-test override layer (__setGateVersionDepsForTests): effective deps are
// real <- default <- override, key by key. So a test that sets a gate dep explicitly always wins
// (pinned by "MUST-FAIL (guard on the guard)" in cutover-gate-version-stale.test.ts), and clearing
// an override in afterEach falls back to this default, never to the real readers.
//
// installCutoverFetchGuard() calls installGateVersionDefault() and its restore() (and
// restoreCutoverFetch(), the afterAll backstop) call clearGateVersionDefault(), so every cutover
// file that installs the fetch guard per test gets the default with no per-file wiring.
//
// Reached optionally: on a tree without the default seam this is a no-op.
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";

export const FIXTURE_GATE_VERSION = "fixture-gate-version-equal";

type DefaultSeam = (d: Record<string, unknown> | null) => void;
const seam = (): DefaultSeam | undefined =>
  (cutoverMod as unknown as { __setGateVersionDefaultForTests?: DefaultSeam }).__setGateVersionDefaultForTests;

// THE AUTONOMY-SCOPE DEFAULT rides the same install/clear. The cutover refuses an undirected landing
// when the autonomy scope excludes a staged file or cannot be read (vessel-mitosis-cutover.ts
// AUTONOMY-SCOPE CHOKEPOINT); a cutover fixture has no pool to read one from, so every suite about
// another gate would refuse on this one. The default layer answers an explicitly unrestricted scope.
// cutover-autonomy-scope.test.ts, whose subject this gate is, clears it and reads the real scope.
type ScopeDefaultSeam = (r: (() => Promise<unknown>) | null) => void;
const scopeSeam = (): ScopeDefaultSeam | undefined =>
  (cutoverMod as unknown as { __setAutonomyScopeDefaultForTests?: ScopeDefaultSeam }).__setAutonomyScopeDefaultForTests;
export const FIXTURE_UNRESTRICTED_SCOPE = { excluded: [] as string[], readable: true, reason: "fixture: explicitly unrestricted (cutover test default)" };

export function installGateVersionDefault(): void {
  seam()?.({ running: () => FIXTURE_GATE_VERSION, accepted: () => FIXTURE_GATE_VERSION });
  scopeSeam()?.(async () => FIXTURE_UNRESTRICTED_SCOPE);
}

export function clearGateVersionDefault(): void {
  seam()?.(null);
  scopeSeam()?.(null);
}
