// AN OBSERVE COMPOSE NEVER LANDS AND WRITES NO LEARNED STATE.
//
// goal-host's observe dispatch (body learning_mode "observe") hands an edit-intent goal here with
// `learning_mode: "observe"` on the feature_compose pointer (and, so no deployment order can make it land,
// land:false + skip_push:true). Measured before this: an observe probe's compose grounded, planned, drafted and ran
// the suite, and only an admission refusal stood between it and a commit. An observe compose is ADMITTED exactly as
// the landing compose it measures (same evidence, same decision), may ground, plan, draft and verify, and then:
//   - never lands, pushes or commits to a remote (land:false, skip_push:true; the landing lease is not taken);
//   - rolls its applied edits back even when FAVORABLE, keep_on_fail or not (nothing is left in a tree);
//   - writes neither the gap store nor the landing ledger: every gap-store write in feature-compose.ts passes
//     composeObserveSkip first (compose lessons, parked landings, dissent records, gate dispositions, baseline gaps);
//   - escalates nothing (the decompose/investigate path writes the gap, child gaps and dispatches a learn goal), mints
//     no activity (author_composed_capability), and writes none of the files a grader or learner reads: the compose
//     report, compose-file-lessons, the locality shadow log, busy-refusals; its refusal journal line is marked;
//   - returns the would-be ops with reason "observe: dry run, not landed".
// The mode is the pointer's structured field, never the spec's wording. The compose's own observation (its trace, the
// admission record, the [compose] attribution line) is kept: that is the measurement. Its traces carry
// learning_mode:"observe" (and the learning_mode:observe tag, and no metadata.reached), so no posterior is graded from them.
import { AsyncLocalStorage } from "node:async_hooks";

export const OBSERVE_DRY_RUN_REASON = "observe: dry run, not landed";

/** An observe compose: the pointer's own learning_mode field. */
export function isObserveCompose(pointer: unknown): boolean {
  return !!pointer && typeof pointer === "object" && (pointer as { learning_mode?: unknown }).learning_mode === "observe";
}

/** Whether the compose would land, for admission: a landing compose, or an observe compose (it measures one). */
export function admissionLandOf(pointer: { land?: boolean; learning_mode?: unknown }): boolean {
  return pointer.land !== false || isObserveCompose(pointer);
}

/** The pointer an observe compose runs with: whatever it asked, it does not land or push, and keeps no edit. */
export function observeComposePointer<P extends { land?: boolean; skip_push?: boolean; keep_on_fail?: boolean }>(pointer: P): P {
  return isObserveCompose(pointer) ? { ...pointer, land: false, skip_push: true, keep_on_fail: false } : pointer;
}

/** This compose's mode, for the writers it reaches (resolveFeatureCompose runs each compose inside its own). */
export const composeObserveContext = new AsyncLocalStorage<{ observe: boolean; announced: Set<string> }>();
/** Runs `fn` (the compose) inside its mode. run, never enterWith: the caller's continuation must not inherit it. */
export function runComposeObserve<T>(pointer: unknown, fn: (observe: boolean) => Promise<T>): Promise<T> {
  const observe = isObserveCompose(pointer);
  return composeObserveContext.run({ observe, announced: new Set() }, () => fn(observe));
}
export function composeObserveActive(): boolean {
  return composeObserveContext.getStore()?.observe === true;
}

/** Whether this write is skipped (an observe compose); recorded once per compose and kind of write. */
export function composeObserveSkip(what: string, record: (line: string) => void = (l) => console.log(l)): boolean {
  const s = composeObserveContext.getStore();
  if (s?.observe !== true) return false;
  if (!s.announced.has(what)) { s.announced.add(what); record(`[observe] skipped ${what} (compose observe)`); }
  return true;
}

/** A journal line a detector counts (the no-effect refusal line), as this compose writes it: an observe compose's is
 *  marked "[observe] ", so self-fact-reconcile's refusals-not-recorded check does not count it against lessons the
 *  observe compose never stored (REFUSAL_JOURNAL_GREP is anchored at the line start). */
export function observeJournalLine(line: string): string {
  return composeObserveActive() ? `[observe] ${line}` : line;
}

/** What an observe compose's trace and reach payloads carry, so activity-api records them ungraded: the body field and
 *  the dispatch's tag its execution-traces observe gate keys on. (The executions route keeps only metadata, and still
 *  counts the execution.) Empty for a learn compose. */
export function observeTraceFields(): { learning_mode?: "observe"; tags?: string[] } {
  return composeObserveActive() ? { learning_mode: "observe", tags: ["learning_mode:observe"] } : {};
}

/** The report fields an observe compose adds: not landed, why, and the ops it would have landed. */
export function observeReportFields(ops: ReadonlyArray<unknown>): { observe: true; landed: false; reason: string; would_be_ops: unknown[] } {
  return { observe: true, landed: false, reason: OBSERVE_DRY_RUN_REASON, would_be_ops: [...ops] };
}
