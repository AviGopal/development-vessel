# development-vessel

The meta-vessel that creates, develops, debugs, and registers other
vessels. Consumes `@avigopal/ias-executor-ts` as a library; runs
activities fetched from activity-api through its own resolvers to
perform development operations (git, fs, code introspection, activity
template CRUD, vessel registration, judgment propagation).

> **Read first:** [`docs/CASES_AND_FLOWS.md`](docs/CASES_AND_FLOWS.md)
> defines the four failure cases the vessel handles, the four flows
> (execute / repair / register / inspect), and the RBAC scoping rules.
> Everything in this README is operational; the doc is conceptual.

## Topology

```
caller (CLI / autonomous loop / workbench / another vessel)
   │ HTTP POST /v2/impulses/resolve  OR  direct in-process call
   ▼
development-vessel  (this package)
   │ composes
   ▼
@avigopal/ias-executor-ts  ← library, not runtime
   ExecutionRuntime + ActivityExecutor + ResolverRegistry
```

Resolvers (13, all declared in `src/config.ts` `discovery.shapes`):
`git_status` · `git_add` · `git_commit` · `git_diff` · `git_log` ·
`fs_read` · `fs_write` · `fs_edit` · `activity_fetch` ·
`activity_create_variant` · `vessel_register_passthrough` ·
`code_introspect` · `propagate_judgment`.

## CLI verbs

```bash
# Execute an activity template fetched by id from activity-api.
bun run cli run-activity <templateId> '{"var1":"value"}'

# Upload the bootstrap templates (ship-change, branch-health,
# release-change, add-resolver-to-vessel, propagate-judgment) to
# activity-api under the caller's write-scope auth. Idempotent.
bun run cli seed-templates

# Invoke a single resolver in-process. Used by tests + the autonomous
# loop driver.
bun run cli call-resolver '{"type":"git_status","cwd":"/path"}'
```

Stdout = JSON impulses. Stderr = the trace summary. Exit codes:
0 = ok, 1 = degraded report, 2 = vessel error.

## HTTP service

```bash
bun run start              # serves on $PORT (default 8090)
bun run dev                # hot-reload variant
curl http://localhost:8090/health
curl -X POST http://localhost:8090/v2/impulses/resolve \
  -H "Content-Type: application/json" \
  -d '{"pointer":{"type":"git_status","cwd":"/path"}}'
```

The server registers with discovery-vessel on boot (non-blocking;
failure logs but doesn't crash). Heartbeat every 60s with exponential
backoff on failure.

## Environment variables

| Variable | Default | Required | Description |
|-|-|-|-|
| `PORT` | `8090` | no | HTTP listen port |
| `HOST` | `0.0.0.0` | no | Bind address |
| `VESSEL_ID` | `development-vessel-${HOSTNAME}` | no | Unique vessel id |
| `METABOB_API_KEY` | — | yes for activity-api/judgment calls | Write-scope key |
| `METABOB_ENDPOINT` | `https://activity.metabob.com` | no | activity-api base URL |
| `DISCOVERY_ENDPOINT` | `https://discovery.metabob.com` | no | discovery-vessel base URL |
| `WORKSPACE_ROOT` | `process.cwd()` | no | Guard root for fs_* resolvers |

## Bootstrap order

1. Conventional commit lands this vessel's source (already done; from
   here on, every commit to this codebase should route through the
   vessel's `ship-change` activity).
2. Operator runs `bun run cli seed-templates` against the canary
   activity-api ONCE. This uploads each bootstrap template as a
   variant under the caller's org/account. Idempotent on re-run.
   Bootstraps 7 templates:
   - `ship-change` — commit staged changes
   - `branch-health` — probe working-tree state  
   - `release-change` — commit then validate
   - `add-resolver-to-vessel` — add resolver to vessel source
   - `propagate-judgment` — fold validation into Thompson posterior
   - `scaffold-new-vessel` — create new vessel from scratch (capability C)
   - `release-and-validate` — cross-vessel composition (capability D)
3. Subsequent ticks fetch templates by id from activity-api via
   `activity_fetch` and execute them through `run-activity`.

## Development

```bash
bun install                # local file: dep on ../ias-executor-ts
bun test                   # full test suite (target: ≥ 13 resolver
                           # test files + integration + cli + seed)
bun run typecheck          # tsc --noEmit
bun run lint               # chains typecheck + shape-dispatch-check;
                           # CI gate. R1.5 + R8.4 in the openspec
                           # spec require both pass before merge.
```

Lint enforces that every advertised shape in `src/config.ts`
`discovery.shapes` has a matching `case` in `src/routes/impulses.ts`
and vice versa.

## What lives where

| Concern | Location |
|-|-|
| Resolver implementations | `src/resolvers/<name>.ts` |
| HTTP dispatch | `src/routes/impulses.ts` |
| Shape contract | `src/config.ts` `discovery.shapes` |
| Bootstrap templates (TS — uploaded to activity-api by `seed-templates`) | `src/seed/<name>.ts` |
| Irreducible template (boot-fetch — lives in code because needed *before* activity-api access) | `src/templates/boot-fetch-template.ts` |
| CLI entry | `src/cli.ts` |
| HTTP entry | `src/index.ts` |
| Per-resolver tests | `test/resolvers/<name>.test.ts` |
| Integration tests | `test/vessel-integration.test.ts` |

> Note: activity templates other than `boot-fetch-template` MUST NOT
> live as JSON files or TS constants in this repo. They live in
> activity-api, fetched by id. See `docs/CASES_AND_FLOWS.md` "What
> lives where" for the rationale.

## Related

- [`docs/CASES_AND_FLOWS.md`](docs/CASES_AND_FLOWS.md) — concept doc
- [`docs/VERIFY_2026_05_21.md`](docs/VERIFY_2026_05_21.md) — most recent
  VERIFY-stage assessment
- [`../../openspec/changes/2026-05-21-development-vessel/`](../../openspec/changes/2026-05-21-development-vessel/) — spec
- [`../../docs/architecture/TYPESCRIPT_VESSEL_TEMPLATE.md`](../../docs/architecture/TYPESCRIPT_VESSEL_TEMPLATE.md) — canonical vessel structure
- [`../../docs/architecture/IMPULSE_ACTIVITY_FOUNDATION.md`](../../docs/architecture/IMPULSE_ACTIVITY_FOUNDATION.md) — primitives
