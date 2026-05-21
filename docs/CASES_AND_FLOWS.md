# development-vessel: cases and flows

The development-vessel is the meta-vessel that creates and manages other
vessels. It consumes `@avigopal/ias-executor-ts` as a library, registers
its own resolvers with discovery-vessel, fetches activity templates from
activity-api by id, and runs them through the executor to perform
development operations (commit, branch-health, vessel-register, repair).

This doc enumerates the cases the vessel must handle and the flows that
handle them. It is the source of truth for what "works" means and how
breakage is diagnosed and repaired.

## RBAC scope of operations

The vessel operates at the caller's authentication rank. Three scopes
matter:

| Scope | Operations | Notes |
|-|-|-|
| `read`  | Fetch templates, read traces, read metrics | Always available |
| `write` | Record traces, create template **variants**, write impulse-relevance, write tool-usage | Canary + production user keys |
| `admin` | Mutate or deprecate existing templates in-place | Not currently issued; pending operator action |

**Key consequence:** the vessel **cannot** update a legacy template
in-place (the initial-bootstrap activities were stored without proper
account scoping and now require admin to mutate). What it **can** do is
create a new variant with the fix and let Thompson sampling promote it.
This is the canonical pattern in the codebase — variants are first-class.

## The four cases

### Case 1 — activity executes cleanly

- Every task returns `success: true`.
- The activity's declared `outputShapes` are present in the trace's
  `outputImpulseIds`.
- Trace recorded; Thompson α incremented for the variant.
- Per-task impulse ids land in `tasks[i].input_impulse_ids` /
  `output_impulse_ids` so co-occurrence learning has signal.

**Detection:** `trace.status === "completed"` ∧
`outputs ⊇ template.outputShapes` ∧ `report.degraded === false` for the
synthesizer-emitted impulse (when applicable).

**No action.** The variant is reinforced; future selection prefers it.

### Case 2 — resolver throws or returns non-zero

- A task's resolver throws (engine catches → `taskRecord.success = false`)
  OR the resolver succeeds but the wrapped command returned non-zero.
- The trace's per-task `error` carries the resolver-level message; the
  per-task `outputImpulseIds[0].content` carries the wrapped command's
  stderr.

**Detection:** `trace.tasks.some(t => !t.success)` OR the synthesizer's
`degraded === true` because its inputs flagged a non-zero exitCode.

**Sub-cases for diagnosis:**
- **2a — resolver code bug.** The resolver's implementation drifted from
  the activity's declared transformation. The fix lives in resolver
  source. The development-vessel's `code_repair_resolver` resolver reads
  the failing task, the resolver source, and the activity's task
  declaration, then proposes a code change.
- **2b — activity task config wrong.** Wrong cwd, wrong arguments, wrong
  shape names in inputShapes. The fix is a new variant of the activity
  with corrected task config. The vessel's `activity_create_variant`
  resolver builds it.
- **2c — upstream input missing.** A required shape never landed in the
  pool. The fix may be either: insert a producer task in a new variant,
  OR add a degraded-fallback synthesizer. Variant-first.
- **2d — external system failure.** Git not installed, network down,
  timeout. Not a code bug — surface to the operator. Do NOT create a
  variant; record the trace and emit a `degraded_external` note.

### Case 3 — tasks succeed but output shapes mismatch

- Every task has `success: true` but the activity's declared
  `outputShapes` are not all present in the produced impulses.
- The activity's contract is broken even though individual steps worked.

**Detection:** `trace.status === "completed"` ∧
`template.outputShapes ⊄ producedShapes`.

**Repair:** the synthesizer task is missing or wrong. Create a variant
that adds the synthesis step or fixes the shape declaration.

### Case 4 — budget exhausted or safety breach

- The engine threw a `BudgetExceededError` (cost / duration / task-count
  cap) or the lifecycle-subscriber refused for depth-cap.
- `failure_mode.type ∈ {"budget_exhausted", "safety_breach"}`.

**Detection:** `trace.status === "failed"` ∧ `failure_mode.type` matches.

**Repair:** budget-exhausted often means the task graph is too expensive
for the goal — create a variant that prunes optional tasks or moves them
to a deferred lifecycle. Safety-breach indicates a structural problem
(infinite recursion); the variant must break the cycle by changing the
task graph, not by raising the cap.

## The flows

### Flow A — execute (read path)

```
caller (CLI / workbench / another vessel)
    │  goal | templateId + vars
    ▼
development-vessel.execute resolver
    │
    ▼
fetch template from activity-api (by id, with write-scope key)
    │
    ▼
construct ExecutionRuntime, register local resolvers (git_*, fs_*, …)
    │
    ▼
ActivityExecutor.execute(template, { variables, impulses })
    │
    ▼
TraceSink → activity-api (writes trace with our org_id)
    │
    ▼
return { trace, outputs }
```

No JSON template ever lives in the vessel's source. Templates are
fetched by id; the vessel only owns the **resolver implementations**
that activities call.

### Flow B — repair (write path, variant-first)

```
caller surfaces a failing trace_id
    │
    ▼
development-vessel.repair resolver
    │
    ▼
fetch the trace via activity-api
    │
    ▼
classify failure → 2a / 2b / 2c / 2d / 3 / 4
    │
    ▼
for 2a (resolver code bug):
   - code_introspect the failing resolver
   - propose patch (LLM-assisted via llm-prompt resolver)
   - run unit test against the failing input
   - if green: commit via ship-change activity (which itself runs through this vessel)
   - increment local resolver version
for 2b / 2c / 3 (activity contract issue):
   - fetch source template
   - propose variant template (delta against source)
   - validate variant against a synthetic input
   - POST /v2/activities/templates (variant create — write-scope OK)
   - emit variant_created impulse with the new id; Thompson selects later
for 4 (budget/safety):
   - same as 2c — variant adjusts task graph
for 2d (external):
   - record + escalate; no code changes
```

### Flow C — register (passthrough)

```
caller wants to register a new vessel with discovery-vessel
    │
    ▼
development-vessel.register_vessel resolver
    │
    ▼
validate the registration payload (shapes declared, resolver contract OK)
    │
    ▼
POST /register on discovery-vessel
    │
    ▼
return { vessel_id, registration_id, expires_at }
```

The development-vessel doesn't OWN registrations; it brokers them so the
new vessel doesn't have to re-implement the registration protocol.

### Flow D — inspect (read-only debug)

```
caller wants to debug an activity
    │
    ▼
development-vessel.inspect resolver
    │
    ▼
fetch template (with current variant + ancestry from genealogy edges)
fetch recent traces (success + failure mix)
fetch resolver versions for each task's declared resolver
    │
    ▼
emit inspection_report shape with:
   { template, variant_genealogy, last_n_traces[],
     resolver_versions, shape_pool_at_each_task }
```

This shape is what a debugging UI (workbench, CLI) renders to give a
human-or-LLM the full context for diagnosis.

## Success criteria (the user's four)

| Criterion | How this vessel satisfies it |
|-|-|
| Create vessel-based environs for arbitrary objectives | Flow C registers them; Flow A executes them. |
| Detect when they work | Case 1 detection; trace status + shape coverage. |
| Detect when they don't | Cases 2 / 3 / 4 detection; structured failure_mode + per-task evidence. |
| Diagnose why + what to do | Flow B repair, classified by case; variant-first so admin scope isn't required. |

## What lives where

- **Resolver implementations** (`git_*`, `fs_*`, `code_*`, `activity_*`,
  `register_vessel`): TypeScript in this repo (`src/resolvers/`).
- **Activity templates** (the JSON contracts: `ship-change`,
  `branch-health`, `repair-resolver`, `inspect-activity`, …): live in
  activity-api, fetched by id. **Not** checked into `src/templates/` of
  this vessel beyond an irreducible bootstrap that's enough to fetch
  the rest.
- **Bootstrap state**: the absolute minimum to call activity-api and
  fetch the first real template. Probably one constant: an
  `activity_fetch` template id. Hard-coded only because we have to
  start somewhere.

## Bootstrap order (one conventional commit, then handoff)

1. Conventionally commit the development-vessel skeleton (this is the
   one and only conventional commit after the ship-change bootstrap).
2. Run the vessel locally; register with discovery-vessel.
3. Use the vessel's `activity_create_variant` resolver to upload the
   bootstrap templates (`ship-change`, `branch-health`,
   `repair-resolver`, etc.) to activity-api under our org/account.
4. From that point on: every change to the codebase is shipped through
   the `ship-change` activity, fetched by id from activity-api,
   executed by the development-vessel.

## What the user explicitly said (so we can re-anchor later)

- *"the host package should be a development-vessel, which should be
  able to run activities to create and manage vessels it develops and
  works as a passthrough for registering them"*
- *"we have a mechanism to repair the code when activities fail due to
  their resolver code being out of alignment with the activity's
  required transformation at that task"*
- *"update, debug, inspect, and create new activities using the same
  mechanism and ensure that we are preferentially using the activities
  in the database"*
- *"Just because we can render activities as json, doesn't mean we
  should"*
- *"the authentication is structural; when we initially bootstrapped the
  activities we did not consider the rbac and improperly stored them
  via auth. but we should be able to make variants and update them
  accordingly, it would just be scoped to our authentication rank"*
