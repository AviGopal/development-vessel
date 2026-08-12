// Pins the vacuous-edit gate.
//
// THE OBSERVED CASE: a correctly-routed repair goal produced a diff whose entire
// content was `const tenant = c.get('tenant');` — never referenced, wrong key,
// target write untouched. tsc passed (noUnusedLocals is not set), the verdict was
// FAVORABLE, the stage was accepted, and the attempt ENDED. Refusing it lets the
// existing escalation (patch_with_tools) take a turn.
import { describe, test, expect } from "bun:test";
import { vacuousEditReason, nonTerminatingEditReason, deadStoreEditReason, truncatingRewriteReason } from "./vacuous-edit";

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

describe("nonTerminatingEditReason — a self-call bound to a local is the same defect", () => {
  // 75427eea landed exactly this shape into gap-to-feature.ts and hung the vessel;
  // the detector missed it because it matched only `return f(...)`. Reverted as
  // f836134. These pin the widened collection site.
  const before = "function verifyGapCondition(gap) {\n  return 'present';\n}";

  test("the two-statement form is caught, not just the returned one", () => {
    const after =
      "function verifyGapCondition(gap) {\n" +
      "  const conditionStatus = verifyGapCondition(gap);\n" +
      "  if (conditionStatus !== 'present') { return conditionStatus; }\n" +
      "  return 'present';\n}";
    const reason = nonTerminatingEditReason(before, after);
    expect(reason).not.toBeNull();
    expect(reason).toContain("verifyGapCondition");
    // The symptom differs from the returned form and the explanation must say so:
    // a bound call is not in tail position, so it grows the stack instead of looping.
    expect(reason).toContain("grows the stack");
  });

  test("the returned form still reports tail-position looping", () => {
    const after = "function verifyGapCondition(gap) {\n  return verifyGapCondition(gap);\n}";
    expect(nonTerminatingEditReason(before, after)).toContain("tail position");
  });

  test("an awaited bound self-call is caught too", () => {
    const b = "async function drain(queue) {\n  return 1;\n}";
    const a = "async function drain(queue) {\n  const r = await drain(queue);\n  return r;\n}";
    expect(nonTerminatingEditReason(b, a)).not.toBeNull();
  });

  // CONTROLS — widening a refusal filter is only safe if these keep passing.
  test("CONTROL: binding a call to a DIFFERENT function is ordinary code", () => {
    const a = "function f(x) {\n  const y = compute(x);\n  return y;\n}";
    expect(nonTerminatingEditReason("function f(x) {\n  return 1;\n}", a)).toBeNull();
  });

  test("CONTROL: genuine recursion on a derived argument still passes", () => {
    const b = "function walk(node) {\n  return null;\n}";
    const a = "function walk(node) {\n  if (!node) return null;\n  const rest = walk(node.next);\n  return rest;\n}";
    expect(nonTerminatingEditReason(b, a)).toBeNull();
  });

  test("CONTROL: a bound self-call whose argument is reassigned still passes", () => {
    const b = "function f(n) {\n  return n;\n}";
    const a = "function f(n) {\n  n = n - 1;\n  const r = f(n);\n  return r;\n}";
    expect(nonTerminatingEditReason(b, a)).toBeNull();
  });
});

describe("deadStoreEditReason — an assignment the next statement erases", () => {
  // 8eb660a landed exactly this into substrate-gap.ts, closed its gap, and had no
  // behavioural effect. Reverted as 5a04b21.
  const before =
    "function f(gaps, classKey) {\n" +
    "  let existingIdx = -1;\n" +
    "  if (existingIdx < 0) {\n" +
    "    existingIdx = gaps.findIndex((g) => ok(g) && key(g.id) === classKey);\n" +
    "  }\n" +
    "  return existingIdx;\n}";

  test("the overwritten assignment is refused", () => {
    const after = before.replace(
      "    existingIdx = gaps.findIndex((g) => ok(g) && key(g.id) === classKey);",
      "    existingIdx = gaps.findIndex((g) => key(g.id) === classKey);\n" +
        "    existingIdx = gaps.findIndex((g) => ok(g) && key(g.id) === classKey);",
    );
    const reason = deadStoreEditReason(before, after);
    expect(reason).not.toBeNull();
    expect(reason).toContain("existingIdx");
    expect(reason).toContain("dead store");
  });

  test("vacuousEditReason consumes it — a gate with no reader is not a gate", () => {
    const after = before.replace(
      "    existingIdx = gaps.findIndex((g) => ok(g) && key(g.id) === classKey);",
      "    existingIdx = gaps.findIndex((g) => key(g.id) === classKey);\n" +
        "    existingIdx = gaps.findIndex((g) => ok(g) && key(g.id) === classKey);",
    );
    expect(vacuousEditReason(before, after)).toContain("dead store");
  });

  // CONTROLS — a refusal gate is only safe if real work keeps passing.
  test("CONTROL: accumulation passes — the second assignment READS the binding", () => {
    const b = "function f() {\n  let x = 1;\n  return x;\n}";
    const a = "function f() {\n  let x = 1;\n  x = 2;\n  x = x + 3;\n  return x;\n}";
    expect(deadStoreEditReason(b, a)).toBeNull();
  });

  test("CONTROL: a real statement between the two assignments passes", () => {
    const b = "function f() {\n  let x = 1;\n  return x;\n}";
    const a = "function f() {\n  let x = 1;\n  x = 2;\n  send(x);\n  x = 3;\n  return x;\n}";
    expect(deadStoreEditReason(b, a)).toBeNull();
  });

  test("CONTROL: two assignments to DIFFERENT bindings pass", () => {
    const b = "function f() {\n  let x = 1;\n  let y = 1;\n  return x + y;\n}";
    const a = "function f() {\n  let x = 1;\n  let y = 1;\n  x = 2;\n  y = 3;\n  return x + y;\n}";
    expect(deadStoreEditReason(b, a)).toBeNull();
  });

  test("CONTROL: an unrelated added statement passes", () => {
    const b = "function f() {\n  return 1;\n}";
    const a = "function f() {\n  doThing();\n  return 1;\n}";
    expect(deadStoreEditReason(b, a)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE INPUT FORM THE RUNTIME CALLER ACTUALLY PASSES.
//
// deadStoreEditReason was landed (671ce88) and validated by replaying the real
// harmful commit 8eb660a as FULL FILE CONTENTS. Its only runtime caller passed
// `vacuousEditReason(op.old_string, op.new_string)` — the raw edit-op strings.
// For an anchored insertion the op's new_string stops at the inserted line, so
// the statement that ERASES the store is not in `after` and the detector cannot
// see it. `git show 8eb660a --stat` is `1 file changed, 2 insertions(+)`: a pure
// insertion, i.e. exactly this form.
//
// These tests pin BOTH halves — that the op form is genuinely undetectable, and
// that simulating against the file catches it — so the fix cannot be undone by
// re-pointing the call site at the op strings again.
// ---------------------------------------------------------------------------
describe("deadStoreEditReason — op-string form vs simulated-file form (8eb660a)", () => {
  const FILE_BEFORE = [
    "function pick(gaps, classKey) {",
    "  let existingIdx = -1;",
    "  if (existingIdx < 0) {",
    '    existingIdx = gaps.findIndex((g) => hasClassifiableId(g) && g.status !== "closed" && gapClassKey(g.id) === classKey);',
    "  }",
    "  return existingIdx;",
    "}",
  ].join("\n");

  // The anchored insertion, as an edit op: anchor line + the added line.
  const OLD_STRING = "  if (existingIdx < 0) {";
  const NEW_STRING =
    "  if (existingIdx < 0) {\n" +
    "    existingIdx = gaps.findIndex((g) => gapClassKey(g.id) === classKey);";

  test("the RAW OP STRINGS cannot show the dead store — this is why the gate was inert", () => {
    // Not a bug in the detector: the overwriting statement is genuinely absent
    // from `after`. Nothing readable at this granularity can decide it.
    expect(deadStoreEditReason(OLD_STRING, NEW_STRING)).toBeNull();
    expect(vacuousEditReason(OLD_STRING, NEW_STRING)).toBeNull();
  });

  test("SIMULATED AGAINST THE FILE, the same op is refused", () => {
    const after = FILE_BEFORE.replace(OLD_STRING, NEW_STRING);
    expect(after).not.toBe(FILE_BEFORE); // the anchor must actually match
    const reason = deadStoreEditReason(FILE_BEFORE, after);
    expect(reason).not.toBeNull();
    expect(reason).toContain("dead store");
    expect(reason).toContain("existingIdx");
  });

  test("CONTROL: a genuine anchored insertion, simulated the same way, still passes", () => {
    // Same file, same simulation path, an added line that is NOT erased — this is
    // what proves the gate refuses the defect rather than refusing insertions.
    const newReal =
      "  if (existingIdx < 0) {\n" +
      "    logger.debug(`no row for ${classKey}`);";
    const after = FILE_BEFORE.replace(OLD_STRING, newReal);
    expect(after).not.toBe(FILE_BEFORE);
    expect(deadStoreEditReason(FILE_BEFORE, after)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE CALL SITE IS THE THING THAT WAS WRONG, SO THE CALL SITE IS WHAT IS PINNED.
//
// The tests above prove the DETECTOR behaves correctly in both input forms. They
// would all still pass if feature-compose stopped simulating and went back to
// handing it raw op strings — which is precisely the state that made 671ce88
// inert for a day. A source-level assertion is crude, but the failure it guards
// against is a silent reversion at a call site, and nothing else here can see it.
// ---------------------------------------------------------------------------
describe("feature-compose wires the dead-store gate to the SIMULATED file", () => {
  test("the simulated call exists on the tree-reading path", async () => {
    const src = await Bun.file(new URL("./resolvers/feature-compose.ts", import.meta.url)).text();
    // POSITIVE CONTROL FIRST: the sibling call this one was modelled on must be
    // findable by the same query. If the control misses, the assertion below is
    // measuring the query, not the code.
    expect(src).toContain("nonTerminatingEditReason(current, current.replace(oldS, newS))");
    expect(src).toContain("deadStoreEditReason(current, current.replace(oldS, newS))");
  });

  test("CONTROL: a string that is NOT in the file is not found", async () => {
    const src = await Bun.file(new URL("./resolvers/feature-compose.ts", import.meta.url)).text();
    expect(src).not.toContain("deadStoreEditReason(zzqqxx, zzqqxx)");
  });
});

// ---------------------------------------------------------------------------
// The guard that would have stopped the 160-byte write over feature-compose.ts.
// ---------------------------------------------------------------------------
describe("truncatingRewriteReason", () => {
  test("REFUSES the production incident: 160 bytes over a ~190KB file", () => {
    const before = "x".repeat(190_000);
    const after = "y".repeat(160);
    const r = truncatingRewriteReason(before, after, "feature-compose.ts");
    expect(r).not.toBeNull();
    expect(r).toContain("truncating rewrite");
    expect(r).toContain("160 bytes");
  });

  test("the OLD absolute floor would have allowed it — this is why the guard is relative", () => {
    // The rule this replaced was `body.length < 8`. 160 clears it comfortably.
    expect(160 < 8).toBe(false);
    expect(truncatingRewriteReason("x".repeat(190_000), "y".repeat(160))).not.toBeNull();
  });

  test("CONTROL: growth is never refused — a real repair adds an import or a type", () => {
    const before = "import a from 'a';\nexport const x = 1;\n";
    const after = "import a from 'a';\nimport b from 'b';\nexport const x: number = 1;\n";
    expect(truncatingRewriteReason(before, after)).toBeNull();
  });

  test("CONTROL: a modest shrink is allowed — deleting dead code is a real repair", () => {
    const before = "x".repeat(1000);
    const after = "y".repeat(800);   // 80%, above the floor
    expect(truncatingRewriteReason(before, after)).toBeNull();
  });

  test("CONTROL: an empty original cannot be truncated", () => {
    expect(truncatingRewriteReason("", "anything")).toBeNull();
  });

  test("boundary: exactly half is allowed, a byte under is not", () => {
    const before = "x".repeat(1000);
    expect(truncatingRewriteReason(before, "y".repeat(500))).toBeNull();
    expect(truncatingRewriteReason(before, "y".repeat(499))).not.toBeNull();
  });
});
