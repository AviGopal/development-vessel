// AN OBSERVE COMPOSE NEVER LANDS AND WRITES NO LEARNED STATE.
//
// goal-host's observe dispatch (body learning_mode "observe") hands an edit-intent goal here with
// `learning_mode: "observe"` on the feature_compose pointer (and, so no deployment order can make it land,
// land:false + skip_push:true). Measured before this: an observe probe's compose grounded, planned, drafted and ran
// the suite, and only an admission refusal stood between it and a commit. An observe compose is ADMITTED exactly as
// the landing compose it measures (same evidence, same decision), may ground, plan, draft and verify, and then:
//   - never lands, pushes or commits to a remote (land:false, skip_push:true; the landing lease is not taken);
//   - rolls its applied edits back even when FAVORABLE (nothing is left in a tree);
//   - writes neither the gap store nor the landing ledger: every gap-store write in feature-compose.ts passes
//     composeObserveSkip first (compose lessons, parked landings, dissent records, gate dispositions, baseline gaps);
//   - returns the would-be ops with reason "observe: dry run, not landed".
// The mode is the pointer's structured field, never the spec's wording. The compose's own observation (its trace, the
// admission record, the [compose] attribution line) is kept: that is the measurement.
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

/** The pointer an observe compose runs with: whatever it asked, it does not land or push. */
export function observeComposePointer<P extends { land?: boolean; skip_push?: boolean }>(pointer: P): P {
  return isObserveCompose(pointer) ? { ...pointer, land: false, skip_push: true } : pointer;
}

/** This compose's mode, for the writers it reaches (entered by resolveFeatureCompose, per compose). */
export const composeObserveContext = new AsyncLocalStorage<{ observe: boolean; announced: Set<string> }>();
export function enterComposeObserve(pointer: unknown): boolean {
  const observe = isObserveCompose(pointer);
  composeObserveContext.enterWith({ observe, announced: new Set() });
  return observe;
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

/** The report fields an observe compose adds: not landed, why, and the ops it would have landed. */
export function observeReportFields(ops: ReadonlyArray<unknown>): { observe: true; landed: false; reason: string; would_be_ops: unknown[] } {
  return { observe: true, landed: false, reason: OBSERVE_DRY_RUN_REASON, would_be_ops: [...ops] };
}
