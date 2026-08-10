// Pins the vacuous-edit gate.
//
// THE OBSERVED CASE: a correctly-routed repair goal produced a diff whose entire
// content was `const tenant = c.get('tenant');` — never referenced, wrong key,
// target write untouched. tsc passed (noUnusedLocals is not set), the verdict was
// FAVORABLE, the stage was accepted, and the attempt ENDED. Refusing it lets the
// existing escalation (patch_with_tools) take a turn.
import { describe, test, expect } from "bun:test";
import { vacuousEditReason } from "./vacuous-edit";

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
