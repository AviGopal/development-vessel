# VERIFY 2026-07-09 — autonomous parity: self-judgment, attribution, durability seams closed

Session goal: break the circular blockers that kept the operator load-bearing
(self-judgment, failure attribution, durable landing), then demonstrate the
loop completing non-trivial work end-to-end with `reached` verdicts issued by
the substrate itself.

## Root cause found: the self-interruption replay loop

The binding failure was one interlocking cycle, not three independent gaps:

1. An edit-intent dispatch routes to feature_compose, which lands FAVORABLE and
   runs vessel-mitosis-cutover.
2. Cutover's drain-before-restart waited for goal-host `in_flight <= 0` — but the
   **initiating dispatch is itself in flight for its own cutover**, so the wait
   deadlocked by construction, always expired at 90s, and the inline restart
   killed the very dispatch that landed the change.
3. The killed dispatch was marked `interrupted`; goal-host's boot-time resume
   replayed it (the `/edit repos\//` guard was too narrow to catch edit-intent
   goals), re-applying the same edit every ~3.5 min — 11 duplicate insertions of
   the declarative reach block landed on origin/dev, 48 replay-poisoned dispatch
   records accumulated, and every cutover restarted goal-host out from under
   unrelated in-flight work.
4. Because cutover commits the whole staged file from the runtime copy, each
   replay clobbered any newer upstream commits (including the operator's dedup)
   — which looked like "edit-intent skips durable commit" but was actually
   stale-runtime full-file re-push.

## Fixes landed (operator direct, justified: the loop's own landing path was the broken part)

- **goal-host `5530ab9`** — no-resume guard: edit-intent goals (same
  `repos/<vessel>/<file>` predicate as EDIT-INTENT routing) never auto-resume on
  boot; resume chains depth-capped via `resumed_from:` tag. 48 poisoned records
  suppressed in the dispatch store.
- **goal-host `2d962de` / `9a93e21`** — deduped the declarative reach branch from
  11 copies to the single canonical `else if` in the reach gate.
- **dev-vessel `7fb6d5f`** — Seam 2A: `runGitAwareCutover` wraps commit+push+
  restart in the maintenanceLease (holder `cutover:<vessel>`, 10 min TTL,
  released in `finally`); held lease → soft-refuse `env_change_window_held`.
  Goal-host restarts drain to `in_flight <= 1` and fire via a PID1-owned
  transient timer (30 s) so the initiating dispatch survives its own cutover.
  (pull-sync already deferred on a held lease — only the producer was missing.)

Result: replay loop dead (0 compose churn after suppression, previously every
3.5 min), goal-host stable through subsequent landings.

## Seam 1 — self-judgment (reach gate for pinned dispatches): VERIFIED

Gap `reach-gate-blind-to-template-dispatches-2026-07-09` closed. Verification
target met exactly as specified: pinned no-goal dispatch `195265f2` of
`development-vessel:trace-store-reconcile` was judged by the gate itself —

```
goal-reach(/run-goal) attempt 1/1: REACHED (declarative): template output_shapes ⊆ produced
completionShapes = [maintenanceLeaseWriteResult, traceStoreHealthReport]
executionId = exec_b7e9ldts   (oracle label lb6xiyzs)
```

No operator feedback involved in the verdict.

## Seam 2B — env-vs-fix attribution: LANDED THROUGH THE LOOP

Gap `env-vs-fix-failure-attribution-2026-07-09` closed by three
substrate-authored commits, each dispatched via `run_goal_async`, drafted,
typecheck-verified, landed and cut over by the substrate, judged `reached:true`
by its own gate, then diff-verified by the operator and oracle-labeled:

| commit | change | attempt history |
|---|---|---|
| `7ca65de8` | `classifyEnvironmentFailure` disjoint env detection before draft-blame | attempt 3 (1: typecheck reject + honest rollback; 2: plan-truncation) |
| `a98f3ac5` | `failure_kind: environment\|fix` on featureComposeReport | first try |
| `4cd15a68` | gap-to-feature skips `bumpFailedAttempts` credit burn on environment failures | first try |

The two rejected attempts are as load-bearing as the lands: the verify gate
caught a TS narrowing bug and a truncated plan, rolled back both, and reported
`reached:false` honestly. Compressed no-prose specs landed 3/3 afterwards.

## Honest-hollow evidence (the gate does not flatter)

Raw goal "produce shape recurringPatternCluster … author, register, verify a
producer" (dispatch `837408f2`): the walk consulted concept-db, inferred
targets, satisfied `trace_recurring_pattern_scan` via an existing resolver
(reuse-before-mint), and the reach judge then ruled **HOLLOW** — "ran a scan,
authored no producer, no registration" — `reached:false`, β-penalty. The
system did not claim success it didn't earn; closure was routed to the
capability-gap path instead.

## New gaps filed back (operator actions converted to system knowledge)

- `stale-running-dispatch-records-2026-07-09` — interrupted dispatch records
  can stay `status:running` forever; boot hydration must transition them.
- Hub degradation (138.197.116.56 activity-api pegged, 319 trace-spool files)
  is tracked by the existing `self-op-health:trace_spool_stale`; hub-side
  recovery needs host access the operator session did not have.

## Demonstration — arbitrary-scale work through the loop

### Demo A: new capability, end-to-end (gap → authored → discoverable → resolvable)

Target: `vessel-demand-recurringPatternCluster-2026-07-06`, a gap the system
filed for itself ("shape required by 5 templates, no producer"). Closed in 6
loop iterations, each failure converting to permanent harness knowledge:

1. Scaffold attempt → `bun run tsc: Script not found` (fresh vessel, no
   node_modules). **Harness fix through the loop**: `73648fc0` — runVerify
   bun-installs before typecheck.
2. Retry → real type error surfaced: test imports `vitest` (not installed).
   **Drafter knowledge through the loop**: `4067631c` — decompose prompt now
   states Bun vessels test with `bun:test`.
3. Retry → drafter slid to `@jest/globals`. **Prompt tightened through the
   loop**: `5a0b8908` — enumerated ban + "prefer no test file".
4. Retry → **FAVORABLE**: clean 3-file net-new vessel scaffold
   (`repos/recurring-pattern-cluster`, typecheck 0) — staged; net-new vessel
   *activation* (unit + registration) identified as a distinct missing
   mechanism.
5. Idiomatic closure per placement-by-data-locality: three-place resolver on
   development-vessel (where compose-lessons live) via one multi-file
   feature_compose — create resolver + config shape + dispatch case, 4 ops /
   3 files, typecheck + shape-dispatch (218 shapes / 221 cases) clean, landed
   `4c0d843`, cutover + self-restart.
6. **E2E verified**: discovery resolves `recurringPatternCluster` →
   development-vessel; a live resolve clusters 5 events into
   `timeout after <N>s` ×3 and `anchor not found line <N>` ×2.

### Demo B: escalate-not-bury (chronic failures route to investigation)

Target: `gap-failed-attempts-should-decompose-not-bury`. Landed `58638dbb` in
3 attempts — attempt 1 broke syntax (rolled back), attempt 2 was a hollow
reformat (caught by the **semantic gate**, rolled back), attempt 3 reached.
`bumpFailedAttempts` at `failed_attempts>=3` now dispatches
"investigate and decompose gap <id>" to goal-host (tagged
`escalated_from:<gap>`) alongside the narrowed child gap.

### The exploration idiom (recorded as concept_oI9cnaTEsZAR + gap)

Speculative exploration toward unknown targets = failure-typing gradient
descent: probe with the cheapest dispatch that could reach → read the
*specific* failure → convert it to a named class / harness knowledge / drafter
knowledge **through the loop** → retry. Convergence is guaranteed by the space
shrinking one named class per iteration; safety by the verify gate (rollback)
and the reach gate (no flattery). The identified next seam is
`uncertainty-routed-goal-target-inference-2026-07-09`: inference should return
{shapes, confidence, alternatives}, the walk should probe alternatives as
OR-targets, and below-threshold confidence should route to
investigate-and-decompose — LLM uncertainty as a structural branch, not a
hallucinated commitment.

## Environment note

The hub activity-api was effectively down throughout (20 s health timeouts).
Everything above landed against the local substrate regardless — template
fetches local-first, traces spooled, reach verdicts local. This is itself
evidence for the attribution seam: environment failures are now a named,
non-credit-burning class.
