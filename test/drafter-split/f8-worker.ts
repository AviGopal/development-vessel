// F8's worker (test setup, not a test file): runs one open entry point on one facts object and reports the time.
// It runs in a Worker so the test can terminate a module that never returns (a hang is otherwise unbounded).
import { assembleDrafterContext, planDrafterReads } from "../../src/drafter/index.ts";

declare const self: Worker;
self.onmessage = (ev: MessageEvent<{ fn: "planDrafterReads" | "assembleDrafterContext" | "__never"; facts: unknown }>) => {
  if (ev.data.fn === "__never") return; // the control: a worker that never answers
  const t0 = performance.now();
  try {
    const out = ev.data.fn === "planDrafterReads" ? planDrafterReads(ev.data.facts as never) : assembleDrafterContext(ev.data.facts as never);
    self.postMessage({ ok: true, ms: performance.now() - t0, bytes: JSON.stringify(out).length });
  } catch (err) {
    self.postMessage({ ok: false, ms: performance.now() - t0, error: String((err as Error)?.message ?? err) });
  }
};
