# Drafter split: the closed pins

What the drafter is shown is assembled by the open, pure module in `src/drafter/`.
Everything that gates an edit, a write or a verdict stays in the closed
`src/resolvers/feature-compose.ts`, which also keeps today's assembly as the
**floor** (copy, not move). This directory is closed: a lane landing cannot
change these pins.

| File | Pins |
|---|---|
| `harness.ts` | The hermetic seams every pin drives `resolveFeatureCompose` through, and the fixture corpus. |
| `verdict-diff.golden.test.ts` + `verdict-diff.golden.json` | F5(b): with the open module forced to fail, every recording (verdict, stage, ops, applied, gap-store writes, fetches, prompt bytes, console) equals the tree before the split. Re-baselined only by an operator/qa act. |
| `f1-adversarial-module.test.ts` | F1: no open module reaches a cutover without verify, the own check, the judge, the refuter and (autonomous) the scope floor; a verify-red draft is never cut over. |
| `f2-f3-module-boundary.test.ts` | F2: `src/drafter/` is pure (no I/O, no ambient authority, declarations only at top level, no re-export of an outside name). F3: only `workers/drafter-module-worker.ts` imports it, by one allowlist-guarded dynamic import taking the two entry points. |
| `f4-clamps.test.ts` | F4: prompt-byte refusal (never truncation), the op-budget clamp, the read allowlist, schema refusal, target visibility on structured facts, prefixed journal lines. |
| `f-context-read-once.test.ts` | The context clamp reads the module's context once: a getter or a Proxy cannot show validation one value and deliver another; a context that is not plain data is refused (the floor drafts). |
| `f6-behaviour-preservation.test.ts` | F6: the shipped module drafts every corpus compose with no fallback, and every closed outcome is unchanged. |
| `f7-floor-self-repair.test.ts` | F7: a compose targeting `src/drafter/` drafts with the floor and never calls the module. |
| `f8-time-bound.test.ts` + `f8-worker.ts` + `f8-runtime-time-bound.test.ts` | F8: each entry point completes within 2 s on every fixture and on adversarial-size facts; production invokes the module through a terminable Worker, and timeout falls back with `fell_back: "timeout"`. |

The open module's own review instrument is `test/drafter/v1-prompts.test.ts`
with its data golden `src/drafter/golden/prompts.json`: a change to what the
drafter is shown changes that golden in the same compose.

## Follow-ups

- **phase-2: remove the duplicated assembly from feature-compose.ts** (the floor
  copy of focusedSlice, groundingFileBlock, the own-check and evidence renderers
  and the lesson renderers), leaving one closed floor that the open module is
  measured against. review_by 2026-10-18.
- phase-2: remove the duplicated floor assembly from the core remains open; runtime
  Worker timeout protection is implemented by `workers/drafter-module-worker.ts`.
- phase-2: carry `drafter.version` and `fell_back` on the structured attempt
  record (phase 1 carries them on the report and the `[fc-drafter]` journal line;
  the attempt-record writer sits in the post-assembly region F5(a) keeps
  byte-identical).
