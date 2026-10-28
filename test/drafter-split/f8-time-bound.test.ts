// F8 (MUST-FAIL): EACH OPEN ENTRY POINT COMPLETES ON EVERY FIXTURE, INCLUDING ADVERSARIAL-SIZE INPUTS, WITHIN 2 s.
//
// A module that never returns is isolated from the compose in a terminable Worker. This pin bounds
// planDrafterReads and assembleDrafterContext
// (the only two functions the core calls; every other open function runs under them) are each run, in a Worker the
// test terminates at the bound, on
//   - the facts every corpus fixture produced (captured through resolveFeatureCompose), and
//   - adversarial-size facts built from them: a 256 KB spec of distinct identifiers, a 1 MB target dense with those
//     identifiers, 400 listed files with 40 KB each, 500 lineage lessons, a 400-line lesson tail of 8 KB lines.
// RUNTIME hangs are bounded by the production Worker cap, separately pinned in f8-runtime-time-bound.test.ts.
// This pin catches a module that is slow or non-terminating on these inputs before it lands.
// CONTROL: a worker that spins forever is terminated at the bound and read as a failure (the bound is real).
// MUTANT (seen red): a spin loop in assembleDrafterContext on a large spec.
import { afterAll, describe, expect, it } from "bun:test";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("drafter-f8", { superRepo: true, who: "test/drafter-split/f8-time-bound.test.ts" });
const { createHarness, CORPUS } = await import("./harness.js");
const H = createHarness(ROOT, RUNTIME);
const workerProto = Worker.prototype as unknown as { postMessage(this: Worker, message: unknown): void };
const realPostMessage = workerProto.postMessage;
afterAll(() => { workerProto.postMessage = realPostMessage; H.restore(); });

const BOUND_MS = 2000;
type Facts = Record<string, any>;

function runBounded(fn: string, facts: unknown): Promise<{ ok: boolean; ms: number; error?: string }> {
  return new Promise((resolve) => {
    const w = new Worker(new URL("./f8-worker.ts", import.meta.url).href);
    const t0 = performance.now();
    const timer = setTimeout(() => { w.terminate(); resolve({ ok: false, ms: performance.now() - t0, error: `no answer within ${BOUND_MS} ms (terminated)` }); }, BOUND_MS);
    w.onmessage = (ev: MessageEvent<{ ok: boolean; ms: number; error?: string }>) => { clearTimeout(timer); w.terminate(); resolve(ev.data); };
    w.onerror = (ev) => { clearTimeout(timer); w.terminate(); resolve({ ok: false, ms: performance.now() - t0, error: String((ev as ErrorEvent).message ?? ev) }); };
    w.postMessage({ fn, facts });
  });
}

function adversarial(base: Facts, withRegion: boolean): Facts {
  const ids = Array.from({ length: 4000 }, (_, i) => `adversarialIdentifier${i}_${(i * 7919) % 10007}`);
  const spec = ids.map((id) => `- change ${id} so that it ${id.slice(0, 12)} works (\`${id}(x)\`)`).join("\n").slice(0, 256 * 1024);
  const target = String(base.targets.files[0] ?? "repos/demo-vessel/src/compute.ts");
  const lines: string[] = [];
  for (let i = 0, n = 0; n < 1024 * 1024 && i < 40_000; i++) {
    const l = `export const v${i} = ${ids[i % ids.length]} + ${ids[(i * 13) % ids.length]}; // ${ids[(i * 31) % ids.length]}`;
    lines.push(l);
    n += l.length + 1;
  }
  const big = lines.join("\n");
  const vessel = target.split("/").slice(0, 2).join("/");
  const files = Array.from({ length: 400 }, (_, i) => `src/gen/f${i}.ts`);
  const contents: Record<string, string> = { [target]: big };
  for (const f of files) contents[`${vessel}/${f}`] = `// ${f}\n` + lines.slice(0, 300).join("\n").slice(0, 40_000);
  const lesson = (i: number) => ({ at: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00.000Z`, class: i % 2 ? "anchor_not_found" : "semantic_reject", reason: `adversarial lesson ${i} ${ids[i % ids.length]}`, stage: "apply", edited_spans: [{ path: target, start: i, end: i + 2, base: "b", text_sha: "t" }], no_effect_vs_parent: i % 3 === 0, constraints: [{ kind: "must_be_called", symbol: `sym${i}`, introduced_in: target }], own_check: { test_file: "test/x.test.ts", failing: [{ name: `t${i}`, expected: "Expected: 1", received: "Received: 2", diff: "- a\n+ b" }] } });
  return {
    ...base,
    spec,
    gapSummary: spec.slice(0, 20_000),
    gapMeta: { ...base.gapMeta, matched_excerpt: spec.slice(0, 4000), failure_lessons: Array.from({ length: 200 }, (_, i) => lesson(i)), semantic_gate_reason: "x".repeat(10_000) },
    // With a region the window centres at once; without one every probe misses and the rarity-weighted cluster
    // step runs over every hint token's occurrences (the slow path).
    regionHint: withRegion ? ids[17]! : "",
    verifyVessels: [vessel],
    listing: { [vessel]: [target.split("/").slice(2).join("/"), ...files] },
    contents,
    lineageLessons: Array.from({ length: 500 }, (_, i) => lesson(i)),
    lessonSource: "jsonl",
    lessonJsonlTail: Array.from({ length: 400 }, (_, i) => JSON.stringify({ class: `c${i % 30}`, reason: "r".repeat(8000) })),
    fileLessonsTail: Array.from({ length: 80 }, (_, i) => JSON.stringify({ at: "x", files: [target], tsc: "e".repeat(4000), kind: i % 2 ? "attempt_consequence" : undefined })),
  };
}

describe("F8: each open entry point completes within the bound on every fixture", () => {
  const captured: Array<{ name: string; facts: Facts }> = [];
  it("captures the facts of every corpus fixture", async () => {
    H.install();
    let current = "";
    workerProto.postMessage = function (message: unknown): void {
      if (message && typeof message === "object" && (message as { entry?: unknown }).entry === "assembleDrafterContext") {
        captured.push({ name: current, facts: structuredClone((message as { facts: Facts }).facts) });
      }
      return realPostMessage.call(this, message);
    };
    let seq = 0;
    for (const fx of CORPUS) {
      current = fx.name;
      const fc = await import(`../../src/resolvers/feature-compose.ts?drafter-f8=${++seq}`);
      await H.run(fc, fx);
    }
    expect(captured.length).toBe(CORPUS.length);
  }, 120_000);
  it("CONTROL: a worker that never answers is terminated at the bound and fails", async () => {
    const r = await runBounded("__never", {});
    expect(r.ok).toBe(false);
  }, 10_000);
  for (const fn of ["planDrafterReads", "assembleDrafterContext"]) {
    it(`${fn}: every corpus fixture`, async () => {
      for (const c of captured) {
        const r = await runBounded(fn, c.facts);
        expect({ fixture: c.name, ok: r.ok, within: r.ms < BOUND_MS, error: r.error ?? null }).toEqual({ fixture: c.name, ok: true, within: true, error: null });
      }
    }, 120_000);
    for (const withRegion of [true, false]) it(`${fn}: adversarial-size facts (${withRegion ? "region literal present" : "no region, every probe misses"})`, async () => {
      const base = captured.find((c) => c.name.includes("own check present, imports added")) ?? captured[0]!;
      const r = await runBounded(fn, adversarial(base.facts, withRegion));
      process.stderr.write(`[f8] ${fn} adversarial (region ${withRegion}): ${r.ok ? "ok" : "FAILED"} in ${r.ms.toFixed(0)} ms${r.error ? ` (${r.error})` : ""}\n`);
      expect({ ok: r.ok, within: r.ms < BOUND_MS, error: r.error ?? null }).toEqual({ ok: true, within: true, error: null });
    }, 30_000);
  }
});
