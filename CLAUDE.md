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

## Variant-first repair (RBAC consequence)

`METABOB_API_KEY` is write-scope, not admin-scope. The vessel
**CAN** create variants of existing templates (write-scope). The
vessel **CANNOT** mutate an existing template in place
(admin-scope; operator-gated).

When a template needs a fix, create a variant. Never call
`activityTemplate_update` or `_deprecate` from this vessel — they
will 403. Thompson sampling promotes the better variant. See
`docs/CASES_AND_FLOWS.md` §"RBAC scope of operations" for the full
table.

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

## Related

- [`README.md`](README.md) — operations
- [`docs/CASES_AND_FLOWS.md`](docs/CASES_AND_FLOWS.md) — concepts
- [`docs/VERIFY_2026_05_21.md`](docs/VERIFY_2026_05_21.md) — latest
  VERIFY pass + gap punch list
- Super-repo spec:
  [`openspec/changes/2026-05-21-development-vessel/`](../../openspec/changes/2026-05-21-development-vessel/)
- Memory anchor for the loop discipline:
  `feedback_autonomous_loop_alternates_dev_verify.md` in the auto-
  memory store; cites the four-stage cycle and the
  "use ias-executor-ts to replace conventional software" pivot.
