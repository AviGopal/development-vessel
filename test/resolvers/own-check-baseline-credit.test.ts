// THE OWN-CHECK BASELINE'S CONTENT GRADE (src/resolvers/own-check-baseline-credit.ts): one consumer trace in the
// gap-outcome credit's shape (one deterministic task, the baseline's execution as the only composition_chain ancestor
// and the consumed producer), reached = AGREEMENT, posted once per (baseline execution, consumer).
//   - a code-reachable reading the compose used: the draft passes, or fails by assertion with a CHANGED failing set ->
//     agree (reached:true); the draft's red is a refused connection -> disagree (reached:false); a no-effect draft, the
//     same failing set, or a broken draft -> no post;
//   - a repeat of the same occasion is not posted again (the unconsumed re-measure case is in own-check-baseline.test.ts);
//   - the baseline's execution id is read from goal-host's dispatch record by the recorded dispatch id.
import { beforeEach, describe, expect, it } from "bun:test";

const credit = await import("../../src/resolvers/own-check-baseline-credit.js");
const { classifyCheckRun, checkRunVerdict } = await import("../../src/resolvers/retry-evidence.js");

const SHA = "e".repeat(40);
const baseline = (over: Record<string, unknown> = {}) => ({
  gap_id: "g1", vessel: "v", test_file: "test/a.test.ts", only_tests: ["a > b"], base_sha: SHA, verdict: "red_code_reachable",
  red: ["a > b"], failing: [{ name: "a > b", expected: "Expected: 2", received: "Received: 3" }], expect_count: 1,
  call_path: [], call_path_source: null, env_signals: [], env_policy: "policy", dispatch_id: "disp-1", measured_at: "2026-01-01T00:00:00Z", ...over,
}) as never;
const meta = (extra: Record<string, unknown> = {}) => ({ own_check_baseline_dispatches: [{ base_sha: SHA, dispatch_id: "disp-1" }], ...extra });
const verdictOf = (raw: string) => checkRunVerdict(classifyCheckRun(raw));
const PASS = "(pass) a > b [1.00ms]\n\n 1 pass\n 0 fail\nRan 1 test across 1 file.\n";
const assertionRed = (name: string) => `error: expect(received).toBe(expected)\n\nExpected: 2\nReceived: 4\n\n      at <anonymous> (/x/test/a.test.ts:3:9)\n(fail) ${name} [1.00ms]\n\n 0 pass\n 1 fail\nRan 1 test across 1 file.\n`;
const NETWORK = "error: Unable to connect. Is the computer able to access the url?\n      at <anonymous> (/x/test/a.test.ts:3:9)\n(fail) a > b [1.00ms]\n\n 0 pass\n 1 fail\nRan 1 test across 1 file.\n";
const LOAD_ERROR = "# Unhandled error between tests\n-------------------------------\nSyntaxError: Unexpected end of file\n-------------------------------\n\n 0 pass\n 1 fail\n 1 error\nRan 1 test across 1 file.\n";

let posts: Array<Record<string, any>>;
let paidWrites: Array<{ gap: string; keys: string[] }>;
const deps = () => ({
  post: async (t: Record<string, any>) => { posts.push(t); return 200; },
  executionIdOf: async (d: string) => (d === "disp-1" ? "exec-baseline-1" : null),
  markPaid: async (gap: string, keys: string[]) => { paidWrites.push({ gap, keys }); },
  nowIso: "2026-01-02T00:00:00Z",
});
beforeEach(() => { posts = []; paidWrites = []; credit.__resetBaselineCreditForTests(); });
const grade = (draftRaw: string, m: Record<string, unknown> = meta(), noEffect?: boolean) =>
  credit.creditOwnCheckBaseline({ gap_id: "g1", meta: m, baseline: baseline(), consumer: "compose", reached: credit.codeReachableAgreement(baseline(), verdictOf(draftRaw), noEffect), reason: "test" }, deps());

describe("the compose grades a code-reachable reading it used", () => {
  it("MUST-FAIL an agreeing draft (it passes) posts one consumer trace, reached:true, chained to the baseline's execution", async () => {
    const r = await grade(PASS);
    expect(r.posted).toBe(true);
    expect(posts).toHaveLength(1);
    const t = posts[0]!;
    expect(t.success).toBe(true);
    expect(t.tags).toContain("reached:true");
    expect(t.activity_id).toBe("development-vessel:own-check-baseline-credit");
    expect(t.composition_chain).toEqual(["exec-baseline-1"]);
    expect(t.tasks[0].resolver_tier).toBe("deterministic");
    expect(t.tasks[0].consumed_provenance[0].producer_execution_id).toBe("exec-baseline-1");
    expect(paidWrites).toEqual([{ gap: "g1", keys: ["exec-baseline-1:compose"] }]);
  });

  it("an assertion red with a CHANGED failing set agrees; the same failing set posts nothing", async () => {
    expect((await grade(assertionRed("a > other"))).posted).toBe(true);
    expect(posts[0]!.success).toBe(true);
    credit.__resetBaselineCreditForTests(); posts = [];
    expect((await grade(assertionRed("a > b"))).posted).toBe(false);
    expect(posts).toEqual([]);
  });

  it("MUST-FAIL a draft whose red is a refused connection disagrees: one post, reached:false", async () => {
    const r = await grade(NETWORK);
    expect(r.posted).toBe(true);
    expect(posts[0]!.success).toBe(false);
    expect(posts[0]!.tags).toContain("reached:false");
  });

  it("CONTROL a broken draft (load error) and a no-effect draft post nothing", async () => {
    expect((await grade(LOAD_ERROR)).posted).toBe(false);
    expect((await grade(PASS, meta(), true)).posted).toBe(false);
    expect(posts).toEqual([]);
  });

  it("CONTROL a repeat of the same occasion is not posted again (in process, and from the row's paid keys)", async () => {
    expect((await grade(PASS)).posted).toBe(true);
    expect((await grade(PASS)).posted).toBe(false);
    credit.__resetBaselineCreditForTests();
    expect((await grade(PASS, meta({ own_check_baseline_credit_paid: ["exec-baseline-1:compose"] }))).posted).toBe(false);
    expect(posts).toHaveLength(1);
  });

  it("CONTROL no execution id readable for the dispatch: nothing is posted", async () => {
    const r = await grade(PASS, { own_check_baseline_dispatches: [{ base_sha: SHA, dispatch_id: "unknown" }] });
    expect(r.posted).toBe(false);
    expect(posts).toEqual([]);
  });
});

describe("the re-measure's agreement with an environmental reading", () => {
  const env = (signals: string[]) => ({ verdict: "red_environmental", env_signals: signals }) as never;
  it("same signal class agrees; green or code-reachable disagrees; unrunnable says nothing", () => {
    expect(credit.remeasureAgreement(env(["S_live_import", "S_empty_received"]), env(["S_live_import", "S_empty_received", "S_count_expected"]))).toBe(true);
    expect(credit.remeasureAgreement(env(["S_precondition"]), env(["S_live_import", "S_empty_received"]))).toBeNull();
    expect(credit.remeasureAgreement(env(["S_precondition"]), { verdict: "green_at_parent", env_signals: [] } as never)).toBe(false);
    expect(credit.remeasureAgreement(env(["S_precondition"]), { verdict: "red_code_reachable", env_signals: [] } as never)).toBe(false);
    expect(credit.remeasureAgreement(env(["S_precondition"]), { verdict: "unrunnable", env_signals: [] } as never)).toBeNull();
  });
});
