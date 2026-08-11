// Pins the vacuous-edit gate.
//
// THE OBSERVED CASE: a correctly-routed repair goal produced a diff whose entire
// content was `const tenant = c.get('tenant');` — never referenced, wrong key,
// target write untouched. tsc passed (noUnusedLocals is not set), the verdict was
// FAVORABLE, the stage was accepted, and the attempt ENDED. Refusing it lets the
// existing escalation (patch_with_tools) take a turn.
import { describe, test, expect } from "bun:test";
import { vacuousEditReason, nonTerminatingEditReason } from "./vacuous-edit";

const BEFORE = `async function createGoalPath(c) {
  const goalHash = hashGoal(validated.goal_text);
  const pathSignature = hashPath(validated.path_activities);
  return c.json({ ok: true });
}`;

describe("vacuousEditReason — refuses the no-op", () => {
  test("the exact live diff is refused", () => {
    const after = BEFORE.replace(
      "  const pathSignature = hashPath(validated.path_activities);",
      "  const pathSignature = hashPath(validated.path_activities);\n  const tenant = c.get('tenant');",
    );
    const r = vacuousEditReason(BEFORE, after);
    expect(r).not.toBeNull();
    expect(r).toContain("tenant");
  });

  test("several unused declarations are still vacuous", () => {
    const after = BEFORE.replace("  return c.json", "  const a = f();\n  const b = g();\n  return c.json");
    expect(vacuousEditReason(BEFORE, after)).not.toBeNull();
  });
});

describe("vacuousEditReason — must NOT refuse real work", () => {
  test("a declaration that IS used passes", () => {
    const after = BEFORE.replace(
      "  return c.json({ ok: true });",
      "  const tenant = c.get('orgId');\n  return c.json({ ok: true, tenant });",
    );
    expect(vacuousEditReason(BEFORE, after)).toBeNull();
  });

  test("adding a real statement passes", () => {
    const after = BEFORE.replace("  return c.json", "  record.org_id = auth.orgId;\n  return c.json");
    expect(vacuousEditReason(BEFORE, after)).toBeNull();
  });

  test("modifying an existing line passes", () => {
    const after = BEFORE.replace("{ ok: true }", "{ ok: true, org_id: auth.orgId }");
    expect(vacuousEditReason(BEFORE, after)).toBeNull();
  });

  test("a pure DELETION passes — removing code can be the right repair", () => {
    const after = BEFORE.replace("  const pathSignature = hashPath(validated.path_activities);\n", "");
    expect(vacuousEditReason(BEFORE, after)).toBeNull();
  });

  test("comment-only and whitespace churn passes", () => {
    expect(vacuousEditReason(BEFORE, BEFORE.replace("  return", "  // explain\n  return"))).toBeNull();
    expect(vacuousEditReason(BEFORE, BEFORE)).toBeNull();
  });

  test("non-string input is inert rather than throwing", () => {
    expect(vacuousEditReason(undefined as never, "x")).toBeNull();
    expect(vacuousEditReason("x", null as never)).toBeNull();
  });
});

describe("vacuousEditReason — references inside string literals do not count", () => {
  test("a name appearing only as a string key is still unused", () => {
    // The live diff's shape: `const tenant = c.get('tenant')`. A naive count sees
    // two occurrences and calls the binding used — backwards, since a key passed
    // as DATA is not a use of the binding.
    const before = "function f(c) {\n  return 1;\n}";
    const after = "function f(c) {\n  const tenant = c.get('tenant');\n  return 1;\n}";
    expect(vacuousEditReason(before, after)).not.toBeNull();
  });

  test("but a genuine code reference still counts as used", () => {
    const before = "function f(c) {\n  return 1;\n}";
    const after = "function f(c) {\n  const tenant = c.get('tenant');\n  return tenant;\n}";
    expect(vacuousEditReason(before, after)).toBeNull();
  });
});

describe("vacuousEditReason — a TYPE-ONLY edit cannot be the requested change", () => {
  test("the `as const` that actually landed in production is refused", () => {
    // A repair goal about a missing tenant column produced, and LANDED via
    // mitosis cutover, exactly this — in the CORRECT file. `as const` is erased
    // by the compiler, so the emitted program is byte-identical.
    const before = "      message: `Child path produces shapes [${v}]`,";
    const after = "      message: `Child path produces shapes [${v}]` as const,";
    expect(vacuousEditReason(before, after)).toContain("type-only");
  });

  test("`satisfies` is caught too", () => {
    expect(vacuousEditReason("const a = { x: 1 };", "const a = { x: 1 } satisfies Foo;"))
      .toContain("type-only");
  });

  test("a REAL change alongside a type assertion still passes", () => {
    // The assertion must not launder a genuine edit into a refusal. Uses an
    // ASSIGNMENT, not a declaration: a one-line `const a = ...` fragment would
    // also trip the unused-binding arm, which is a fixture artifact of testing a
    // fragment in isolation — at the call site, guard 2 consults the whole file.
    const before = "record.org_id = null;";
    const after = "record.org_id = auth.orgId as string;";
    expect(vacuousEditReason(before, after)).toBeNull();
  });

  test("adding a type ANNOTATION that changes nothing else is still type-only", () => {
    expect(vacuousEditReason("record.x = g();", "record.x = g() as string;")).toContain("type-only");
  });

  test("unrelated real edits are untouched", () => {
    expect(vacuousEditReason("record.org_id = null;", "record.org_id = auth.orgId;")).toBeNull();
  });
});

describe("nonTerminatingEditReason — the regression the SUBSTRATE landed and deployed", () => {
  // 2026-08-11, commit d96e2ae, authored autonomously and cut over live:
  //
  //   - return best ?? pool[0];
  //   + return pickSatisfierProducer(pool);
  //
  // It typechecked, the semantic judge approved it, the mitosis verdict was
  // FAVORABLE, the dispatch was graded reached:true, and it shipped. The module
  // had no test, so nothing ever EXECUTED the function — and a typecheck cannot
  // tell "returns the best producer" from "calls itself forever". In tail position
  // it loops rather than overflowing, so the vessel HANGS while reporting healthy.
  const BEFORE = [
    "export function pickSatisfierProducer(",
    "  producers: SatisfierProducer[],",
    "): SatisfierProducer | undefined {",
    "  if (producers.length === 0) return undefined;",
    "  const pool = producers.some(isPinned) ? producers.filter(isPinned) : producers;",
    "  let best;",
    "  let bestScore = -Infinity;",
    "  for (const p of pool) { if (0 > bestScore) { best = p; } }",
    "  return best ?? pool[0];",
    "}",
  ].join("\n");

  test("fires on the exact landed diff", () => {
    const after = BEFORE.replace("return best ?? pool[0];", "return pickSatisfierProducer(pool);");
    const r = nonTerminatingEditReason(BEFORE, after);
    expect(r).not.toBeNull();
    expect(r).toContain("pickSatisfierProducer");
  });

  test("vacuousEditReason surfaces it too — the gate feature_compose actually calls", () => {
    // A predicate nothing consults is this session's most repeated defect.
    const after = BEFORE.replace("return best ?? pool[0];", "return pickSatisfierProducer(pool);");
    expect(vacuousEditReason(BEFORE, after)).not.toBeNull();
  });

  test("a base case that can never be REACHED is still non-terminating", () => {
    // Rule 1 (no base case) does not catch this: the real function opens with
    // `if (producers.length === 0) return undefined`. The base case is genuine and
    // unreachable for every non-empty input, which is every real input.
    const b = "function q(a, b) {\n  return a;\n}";
    const a = "function q(a, b) {\n  if (!a) return b;\n  return q(a, b);\n}";
    expect(nonTerminatingEditReason(b, a)).not.toBeNull();
  });

  test("a function with NO base case at all", () => {
    expect(nonTerminatingEditReason("function z(n) {\n  return n;\n}", "function z(n) {\n  return z(n);\n}")).not.toBeNull();
  });
});

describe("nonTerminatingEditReason — must NOT refuse ordinary recursion", () => {
  // A gate that refused all self-calls would be far worse than the defect it
  // prevents. Recursion is ordinary and correct; only NON-PROGRESS is the defect.
  test("recursion on a property makes progress", () => {
    expect(
      nonTerminatingEditReason("function walk(n) {\n  return n;\n}", "function walk(n) {\n  if (!n.next) return n;\n  return walk(n.next);\n}"),
    ).toBeNull();
  });

  test("recursion with arithmetic makes progress", () => {
    expect(
      nonTerminatingEditReason("function f(n) {\n  return 1;\n}", "function f(n) {\n  if (n <= 0) return 1;\n  return f(n - 1);\n}"),
    ).toBeNull();
  });

  test("a reassigned binding moves, so non-progress cannot be claimed", () => {
    expect(
      nonTerminatingEditReason("function g(xs) {\n  return xs;\n}", "function g(xs) {\n  if (!xs.length) return xs;\n  xs = xs.slice(1);\n  return g(xs);\n}"),
    ).toBeNull();
  });

  test("calling a DIFFERENT function is not self-recursion", () => {
    expect(nonTerminatingEditReason("function a(x) {\n  return x;\n}", "function a(x) {\n  return b(x);\n}")).toBeNull();
  });

  test("an unrelated edit is untouched", () => {
    expect(nonTerminatingEditReason("function h() {\n  return 1;\n}", "function h() {\n  return 2;\n}")).toBeNull();
  });

  test("nullish / identical input is safe", () => {
    expect(nonTerminatingEditReason("x", "x")).toBeNull();
    expect(nonTerminatingEditReason(undefined as unknown as string, "y")).toBeNull();
  });
});

describe("vacuousEditReason — a diagnostic-only edit is not a change", () => {
  // bc0ba3f3, authored autonomously, graded reached:true, verdict FAVORABLE,
  // LANDED on origin/dev and deployed. The entire diff removed one tap() call.
  // The `if (verdict === "BUSY")` block and its return were untouched, so
  // behaviour was identical — and it deleted an honest diagnostic, making the
  // condition it reported harder to see.
  //
  // Every gate passed it: deleting a log line typechecks, keeps shape-dispatch
  // agreement, breaks no test. The semantic judge recorded that the patch
  // "removes the suppression of byte-anchored escalation" — a change not in the
  // diff. The added-lines arm could not catch it because a pure deletion returns
  // null on the principle that deleting CODE can be the right repair.
  const BEFORE = [
    '            if (verdict === "BUSY") {',
    "              tap(`[goal-host-vessel] capacity-refused for ${editFile} — still BUSY`);",
    "              return {",
    "                result: null,",
    "              };",
    "            }",
  ].join("\n");

  test("fires on the landed hollow diff", () => {
    const after = BEFORE.replace(/\n\s*tap\(.*\n/, "\n");
    const r = vacuousEditReason(BEFORE, after);
    expect(r).not.toBeNull();
    expect(r).toContain("diagnostic-only");
  });

  test("adding only a log line is equally hollow", () => {
    expect(
      vacuousEditReason("function f() {\n  return 1;\n}", 'function f() {\n  console.log("here");\n  return 1;\n}'),
    ).not.toBeNull();
  });
});

describe("vacuousEditReason — diagnostic gate must not swallow real work", () => {
  test("DELETING REAL CODE still passes — a deletion can be the right repair", () => {
    // The load-bearing control. Narrowing to logging is what keeps the original
    // pure-deletion principle intact.
    expect(
      vacuousEditReason("function f() {\n  doThing();\n  return 1;\n}", "function f() {\n  return 1;\n}"),
    ).toBeNull();
  });

  test("a logic change beside a log line is real work", () => {
    expect(
      vacuousEditReason('if (x) {\n  console.log("a");\n  return 1;\n}', 'if (x && y) {\n  console.log("b");\n  return 2;\n}'),
    ).toBeNull();
  });

  test("adding a real statement passes", () => {
    expect(
      vacuousEditReason("function f() {\n  return 1;\n}", "function f() {\n  const y = compute();\n  return y;\n}"),
    ).toBeNull();
  });
});
