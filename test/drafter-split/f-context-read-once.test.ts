// PROTECTED (MUST-FAIL): THE CONTEXT CLAMP READS THE OPEN MODULE'S CONTEXT ONCE.
//
// The open drafter module (src/drafter/) returns a context; the closed clamp (feature-compose.ts validateDrafterContext,
// called by draftContextThroughOpenModule) validates it and builds the context the core drafts with. If the clamp reads
// the module's object more than once, the module controls what each read sees: a getter (or a Proxy) can show the
// validation the closed set and deliver something else. The clamp must validate and deliver ONE plain copy, taken once,
// and a context that is not plain data (a Proxy) must be refused, failing closed to the floor.
//   - a getter on netNewTargets / opBudgetHint that changes value after its first reads: what is delivered is what was
//     validated (or the context is refused);
//   - a Proxy context whose reads switch, and a Proxy whose every read throws, through draftContextThroughOpenModule:
//     refused, the floor drafts, nothing throws out of the call;
//   - CONTROL: a plain context is delivered as given, through both entries.
// MUTANT (seen red): a clamp that validates the module's object in place and builds the context by reading it again.
import { describe, expect, it } from "bun:test";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

await isolateRuntimeRoot("drafter-read-once", { superRepo: true, who: "test/drafter-split/f-context-read-once.test.ts" });
const fc = await import("../../src/resolvers/feature-compose.ts");

const CLOSED = ["repos/v/src/new.ts"];
const EXTRA = "repos/v/src/other.ts";
type Expect = Parameters<typeof fc.validateDrafterContext>[1];
const ex: Expect = { targets: [], netNew: CLOSED, targetContents: {}, ceiling: 24, prompts: () => ({ decompose: "", refine: "" }), mandatory: [], floorPrompt: "" };
const plain = (): Record<string, unknown> => ({ grounding: "g", priorFeedback: "", principles: "", composeLessons: "", version: "v1", journal: [], targetWindows: {}, netNewTargets: [...CLOSED], opBudgetHint: 8 });
/** A context whose `key` reads as `first` for `n` reads and as `later` after. */
function shifting(key: string, first: unknown, later: unknown, n = 1): Record<string, unknown> {
  const c = plain();
  delete c[key];
  let reads = 0;
  Object.defineProperty(c, key, { enumerable: true, configurable: true, get() { reads++; return structuredClone(reads <= n ? first : later); } });
  return c;
}
const run = (ctx: () => unknown): Parameters<typeof fc.draftContextThroughOpenModule>[0] => ({
  facts: { contents: {}, lessonHits: [] },
  scope: { verifyVessels: [], targets: [], checkPaths: [] },
  expect: ex,
  floorBudget: 24,
  readFile: async () => null,
  readGapRow: async () => null,
  lessonRows: async () => [],
  ancestorStart: "",
  selfId: "self",
  load: async () => ({ planDrafterReads: () => ({ reads: [], lessonQueries: [], ancestorDepth: 0 }), assembleDrafterContext: () => ctx() }),
});

describe("validateDrafterContext: what is delivered is what was validated", () => {
  for (const n of [1, 2]) {
    it(`netNewTargets reads as the closed set ${n}x, then with an extra file: refused or delivered as validated`, () => {
      const v = fc.validateDrafterContext(shifting("netNewTargets", CLOSED, [...CLOSED, EXTRA], n), ex);
      if (v.ok) expect(v.ctx.netNewTargets).toEqual(CLOSED);
    });
  }
  it("opBudgetHint reads as 8, then 999: the delivered hint is the one the budget clamp saw", () => {
    const v = fc.validateDrafterContext(shifting("opBudgetHint", 8, 999), ex);
    if (v.ok) { expect(v.ctx.opBudgetHint).toBe(8); expect(v.budget).toBe(8); }
  });
  it("journal reads as strings, then as a non-string: the delivered journal is a string array", () => {
    const v = fc.validateDrafterContext(shifting("journal", ["ok"], [{ toString: null }]), ex);
    if (v.ok) expect(v.ctx.journal).toEqual(["ok"]);
  });
  it("a Proxy context is refused (fails closed), even one whose every read is valid", () => {
    const v = fc.validateDrafterContext(new Proxy(plain(), {}), ex);
    expect(v.ok).toBe(false);
  });
  it("CONTROL: a plain context is delivered as given", () => {
    const v = fc.validateDrafterContext(plain(), ex);
    expect(v.ok).toBe(true);
    if (v.ok) expect({ ...v.ctx }).toEqual(plain() as never);
  });
});

describe("draftContextThroughOpenModule: a shape-shifting or Proxy context drafts with the floor", () => {
  it("a Proxy whose netNewTargets reads switch after validation: refused, the floor drafts", async () => {
    const proxyOf = () => { let reads = 0; return new Proxy(plain(), { get(t, k) { if (k === "netNewTargets") { reads++; return reads <= 2 ? [...CLOSED] : [...CLOSED, EXTRA]; } return Reflect.get(t, k); } }); };
    const r = await fc.draftContextThroughOpenModule(run(proxyOf));
    expect(r.ctx).toBeNull();
    expect(String(r.record.fell_back)).toMatch(/^context_refused: /);
  });
  it("a Proxy whose every read throws: refused, nothing throws out of the call", async () => {
    const hostile = () => new Proxy({}, { get() { throw new Error("hostile read"); }, ownKeys() { throw new Error("hostile keys"); }, getOwnPropertyDescriptor() { throw new Error("hostile descriptor"); } });
    const r = await fc.draftContextThroughOpenModule(run(hostile)).catch((e) => ({ threw: String(e) }));
    expect(r).not.toHaveProperty("threw");
    expect((r as { ctx: unknown }).ctx).toBeNull();
    expect(String((r as { record: { fell_back: unknown } }).record.fell_back)).toMatch(/^context_refused: /);
  });
  it("a getter context delivers what was validated", async () => {
    const r = await fc.draftContextThroughOpenModule(run(() => shifting("netNewTargets", CLOSED, [...CLOSED, EXTRA], 2)));
    if (r.ctx) expect(r.ctx.netNewTargets).toEqual(CLOSED);
  });
  it("CONTROL: a plain context is delivered as given (no fallback)", async () => {
    const r = await fc.draftContextThroughOpenModule(run(plain));
    expect(r.record.fell_back).toBeNull();
    expect({ ...r.ctx }).toEqual(plain() as never);
    expect(r.record.version).toBe("v1");
  });
});
