# development-vessel — guidelines for Claude (and any agent)

This vessel is the meta-vessel: it creates, develops, debugs, and
registers other vessels via activities. It IS the substrate's
self-application surface. Hold the rules below; the substrate's
integrity depends on them.

> If `README.md` is the operational manual, this is the discipline
> document. Read both before adding to this repo.

## Three-layer discipline

The same three layers govern every change here:

1. **TypeScript** — deterministic resolver implementations + HTTP +
   CLI. Versioned, testable. **No business decisions** beyond
   dispatch live in TS.
2. **Activities** — JSON impulse-of-shape-`activity_template`,
   **fetched from activity-api by id**. They compose resolver calls
   and ARE the orchestration layer.
3. **LLMs** — only invoked via an `llm-prompt`-tier resolver
   dispatched from an activity. **Never inline in vessel code.**

A vessel that contains an LLM call inside its TS surface violates
the layering and breaks audit-ability. The dev-vessel currently
ships zero LLM-tier resolvers; if you add one, register it as a
resolver and dispatch via an activity, never as a hidden call.

## Activities live in activity-api, not source

There is exactly **one** bootstrap template in TypeScript:
`src/templates/boot-fetch-template.ts`. It exists only because it
must be available *before* activity-api can be reached.

Every other activity template:
- Lives in activity-api as a variant under the caller's auth scope.
- Is uploaded once by `bun run cli seed-templates` (sources live in
  `src/seed/*.ts` — those are TypeScript constants whose **only**
  purpose is to be uploaded; they are not consumed at runtime).
- Is fetched by id via `activity_fetch` at execution time.

**Creating new vessels:** Use the `scaffold-new-vessel` activity
(canonical bootstrap template) to generate vessel scaffolds. This
template lives in activity-api after `seed-templates` uploads it —
never inline vessel scaffolding logic in source code.

If you find yourself adding a new TS constant that the vessel will
read at runtime and call `executor.execute(template, …)` on, **stop
and reconsider**. Either:
- Upload it to activity-api as a variant and fetch by id, OR
- Add a new resolver that does the same work without a stored
  template (rare and lower-leverage).

Just because we can render activities as JSON doesn't mean we
should bake them into source.

## Variant-first repair (evidence-gated lifecycle, 2026-06-04)

> **Policy change.** `activityTemplate_update` and `_deprecate` are
> no longer admin-scope-only. Activity-API now accepts those
> impulses from write-scope callers when the request body carries
> auditable evidence (Thompson posteriors for `_deprecate`,
> reason string for `_update`). Admin scope still works as the
> override path. See `repos/metabob-activity-api/src/routes/impulses.ts`
> `validateEvidenceGate` for the gate logic and default thresholds
> (`MIN_SAMPLES=10`, `MIN_DELTA=0.15` posterior-mean difference).

**Variant-first is still preferred.** Mint a new variant before
calling `_deprecate` on the parent. The order matters:

1. Detect a weak family (low Thompson posterior + ≥10 samples).
2. Mint an improved variant via `activity_create_variant`.
3. Let Thompson Sampling allocate traffic to the variant.
4. When the variant's posterior dominates the parent's by ≥0.15
   over ≥10 loser samples, call `variant_promote` (which issues
   `_update` to mark the winner canonical AND `_deprecate` on the
   losers, both with the Thompson evidence body).
5. The substrate is now in charge of its own template lifecycle.
   Operator role narrows to anchor maintenance + adversarial probing
   (per IAL §27.S.5).

**Why the gate, not raw RBAC.** The vessel-mitosis cutover already
uses evidence-based gating (FAVORABLE typecheck verdict). Template
lifecycle uses the same shape — the substrate's own Thompson
posteriors over real workload are the natural safety mechanism for
promote/deprecate. Operator-only gates are appropriate for
provisioning, billing, secret rotation, and other operations whose
correctness cannot be re-derived from substrate state.

**Three-place rule applies.** The `variant_promote` resolver is in
`src/resolvers/variant-promote.ts`, registered in `src/config.ts`,
dispatched in `src/routes/impulses.ts`. Per-resolver test lives in
`test/resolvers/variant-promote.test.ts`.

See `repos/metabob-activity-api/src/routes/impulses.ts` for the
canonical evidence-gate implementation. The gate fields are:

```ts
evidence: {
  reason: string,                  // required (audit trail)
  winner_alpha?, winner_beta?,     // required for _deprecate
  loser_alpha?, loser_beta?,       // required for _deprecate
  loser_samples?,                  // default α+β-2, must be ≥ 10
  confidence_threshold?,           // default 0.15
  source_trace_ids?: string[],     // optional provenance
}
```

## Shape-dispatch agreement is enforced

`bun run lint` runs `tsc --noEmit` AND
`scripts/check-shape-dispatch.ts`. The latter verifies that every
entry in `src/config.ts` `discovery.shapes` has a matching `case`
in `src/routes/impulses.ts` and vice versa.

**Adding a resolver: do all three places in one commit:**
1. Implement in `src/resolvers/<name>.ts`.
2. Add to `discovery.shapes` in `src/config.ts`.
3. Add the `case` in `src/routes/impulses.ts`.

If you forget one, lint fails. This is intentional.

## Tests are per-resolver

Spec R8.1: one test file per resolver. Don't rely on integration
tests to catch regressions — a per-resolver test pins the resolver's
input/output contract directly. The integration test catches
multi-resolver chain bugs; per-resolver tests catch single-resolver
contract drift.

`test/resolvers/<name>.test.ts` is the home. Use scripted
`ProcessPort` / fake fetch for HTTP-touching resolvers — no real
network in tests.

## Four-stage loop

This vessel was built and is maintained under a four-stage loop:

```
VERIFY → DEBUG → SPEC → DEV → VERIFY → ...
```

- **VERIFY** runs tests + probes against current state; identifies
  gaps.
- **DEBUG** isolates each gap to a specific resolver, contract, or
  activity. No code yet.
- **SPEC** encodes the fix in openspec
  (`openspec/changes/<date>-<slug>/`). No code lands without a spec.
- **DEV** implements the spec. Stays in scope.

Artifacts of each VERIFY+DEBUG cycle land in
`repos/development-vessel/docs/VERIFY_<date>.md`. When adding work
here, identify which stage you're in. If it's not in the current
spec, write the spec first.

## Commits route through the vessel (when possible)

Once the bootstrap is in place, commits to this codebase should
ideally use the `ship-change` activity (fetched from activity-api,
executed by this vessel) rather than raw `git add` + `git commit`.
The vessel's `gitCommitResult` impulse becomes the durable record.

For commits BEFORE `seed-templates` has run (i.e. the activity isn't
in activity-api yet), conventional `git` is the path of last resort.
After bootstrap, every commit should produce a trace.

## CI gate

CI must run:

```bash
bun install
bun run lint        # typecheck + shape-dispatch-check
bun test            # all suites green
```

Both must pass. No exceptions.

## Upcoming: topology-discovery loop (Phase 26+)

This vessel is the implementation site for the three-phase spec chain
that leads to IAL Phase 27 (lift):

1. **`2026-05-23-single-container-substrate`** (Phase 26) — Dockerfile +
   systemd units for the single-container substrate. All vessels including
   this one run as units; inter-vessel calls are localhost. Gate: all units
   healthy within 60s, harness smoke passes at `localhost:8080`.

2. **`2026-05-23-harness-as-lifecycle-participant`** (gated on Phase 26) —
   adds `failure_mode_matrix_score` resolver + `harness-run-matrix` seed
   template + lifecycle observer (`lifecycle:execution:succeeded` of
   `draft-gap-closing-activity` → `harness-run-matrix`). The observer
   makes the harness a pull loop rather than a push script; it emits
   `activityRegistryChange` on completion to trigger the next phase.

3. **`2026-05-23-topology-discovery-loop`** (gated on 1+2) — 6 new
   activities in 2 layers, plus two aggregators:
   - **Measurement** (3): `learned-topology-snapshot`,
     `reachable-unlearned-report`, `unknown-shape-report`
   - **Probing** (3): `probe-reachable-unlearned`,
     `probe-untraversed-edge`, `escalate-unknown-shape`
   - **Aggregators** (2): `coverage-tick` emitting `coverageReport`
     (cell-count progress in the 4-cell table) and
     `substrate-health-tick` emitting `substrateHealthReport`
     (posterior confidence, graph stability, optimality).
   The observer fires the full chain on every
   `activityRegistryChange`. Lift = three consecutive `coverageReport`
   impulses with `coverage_progress=true` from natural activity AND
   `substrateHealthReport.health_verdict.overall_passing=true` on the
   most recent emission AND an operator-written
   `validation/state/lift-status.json`. The substrate-measured halves
   (coverage + health) feed the operator's hand-over decision; the
   decision itself is separate (IAL Phase 27). This describes the
   S1 → S2 transition only (operator-authored, supervised →
   substrate-authored, supervised). S2 → S3 (distributed-stable,
   adversarial-resistant) is the substrate's own roadmap, not a
   development-vessel concern: see IAL §27.S.5 for the post-lift
   agenda the substrate authors via its own propose-spec pipeline,
   and §27.S.6 for S3 readiness measured by active push-away rather
   than by a gate.

**Shape budget after topology-discovery-loop:**
- Current: 19 shapes / 19 dispatch cases (after Phase 21)
- After harness-lifecycle: 20 shapes (`failureModeMatrixScore` + `activityRegistryChange`)
- After topology-discovery-loop: 23 shapes / 23 dispatch cases
  (+ 3 measurement shapes + `coverageReport` + `substrateHealthReport`)
- Coverage-tick shape: `coverageReport` (emitted by `coverage-tick` resolver)
- Substrate-health-tick shape: `substrateHealthReport` (emitted by `substrate-health-tick` resolver)

When adding resolvers for the above specs, follow the three-place rule
(resolver file + `config.ts` shape + `impulses.ts` case) and keep lint
green at every commit boundary.

## Related

- [`README.md`](README.md) — operations
- [`docs/CASES_AND_FLOWS.md`](docs/CASES_AND_FLOWS.md) — concepts
- [`docs/VERIFY_2026_05_21.md`](docs/VERIFY_2026_05_21.md) — latest
  VERIFY pass + gap punch list
- Super-repo spec:
  [`openspec/changes/2026-05-21-development-vessel/`](../../openspec/changes/2026-05-21-development-vessel/)
- Substrate spec: [`openspec/changes/2026-05-23-single-container-substrate/`](../../openspec/changes/2026-05-23-single-container-substrate/)
- Harness-lifecycle spec: [`openspec/changes/2026-05-23-harness-as-lifecycle-participant/`](../../openspec/changes/2026-05-23-harness-as-lifecycle-participant/)
- Topology-discovery spec: [`openspec/changes/2026-05-23-topology-discovery-loop/`](../../openspec/changes/2026-05-23-topology-discovery-loop/)
- Substrate developer guide: [`docs/SUBSTRATE.md`](../../docs/SUBSTRATE.md)
- Memory anchor for the loop discipline:
  `feedback_autonomous_loop_alternates_dev_verify.md` in the auto-
  memory store; cites the four-stage cycle and the
  "use ias-executor-ts to replace conventional software" pivot.
