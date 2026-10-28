import { describe, expect, it } from "bun:test";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

await isolateRuntimeRoot("drafter-f8-runtime", { superRepo: true, who: "test/drafter-split/f8-runtime-time-bound.test.ts" });
const fc = await import("../../src/resolvers/feature-compose.ts");

const ex: Parameters<typeof fc.validateDrafterContext>[1] = {
  targets: [], netNew: [], targetContents: {}, ceiling: 24,
  prompts: () => ({ decompose: "", refine: "" }), mandatory: [], floorPrompt: "",
};
const facts = { contents: {}, lessonHits: [] };
const completeFacts = {
  spec: "", gapSummary: "", directed: false, gapMeta: {}, regionHint: "", lineHint: null,
  targets: { files: [], ownCheckAdded: [], ownCheckReadonly: [], netNew: [] },
  verifyVessels: [], listing: {}, contents: {}, ownCheck: null, lineageLessons: [], ancestors: [], parentCheck: null,
  lessonSource: "none", lessonHits: [], lessonJsonlTail: [], fileLessonsTail: [], principles: "", contracts: "",
  existingSymbols: "", symbolDecls: "", safeAnchors: "", opCeiling: 24, opCeilingDeclared: false,
};

function nonReturningWorkerFactory(onTerminate: () => void): Worker {
  const actual = new Worker(new URL("./f8-worker.ts", import.meta.url).href);
  const facade = {
    set onmessage(handler: ((ev: MessageEvent) => void) | null) { actual.onmessage = handler as ((ev: MessageEvent) => unknown) | null; },
    set onerror(handler: ((ev: ErrorEvent) => void) | null) { actual.onerror = handler as ((ev: ErrorEvent) => unknown) | null; },
    postMessage(): void { actual.postMessage({ fn: "__never", facts: {} }); },
    terminate(): void { onTerminate(); actual.terminate(); },
  };
  return facade as unknown as Worker;
}

describe("draftContextThroughOpenModule runtime Worker bound (checklist 1.3)", () => {
  it("the shipped drafter loads and returns through the production Worker", async () => {
    const result = await fc.draftContextThroughOpenModule({
      facts: completeFacts,
      scope: { verifyVessels: [], targets: [], checkPaths: [] },
      expect: ex,
      floorBudget: 24,
      readFile: async () => null,
      readGapRow: async () => null,
      lessonRows: async () => [],
      ancestorStart: "",
      selfId: "self",
      variant: "drafter-v1",
      mode: "default",
      workerVariant: "drafter-v1",
    });
    expect(result.record.fell_back).toBeNull();
    expect(result.record.version).toBe("drafter-v1");
    expect(result.ctx).not.toBeNull();
  }, 10_000);

  it("a non-returning module Worker is terminated and recorded as timeout", async () => {
    const started = performance.now();
    let terminated = false;
    const result = await fc.draftContextThroughOpenModule({
      facts,
      scope: { verifyVessels: [], targets: [], checkPaths: [] },
      expect: ex,
      floorBudget: 24,
      readFile: async () => null,
      readGapRow: async () => null,
      lessonRows: async () => [],
      ancestorStart: "",
      selfId: "self",
      variant: "drafter-v-test-hang",
      mode: "named",
      workerVariant: "drafter-v-test-hang",
      workerFactory: () => nonReturningWorkerFactory(() => { terminated = true; }),
    });
    expect(result.ctx).toBeNull();
    expect(result.record.fell_back).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(fc.DRAFTER_WORKER_TIMEOUT_MS + 1000);
    expect(terminated).toBe(true);
  }, 10_000);
});
