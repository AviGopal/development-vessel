/**
 * comprehensibility_check never throws on a non-string evaluator reply.
 *
 * The gate crashed with "text.replace is not a function": the LLM vessel answered with a structured
 * reply (an object), and the reply went straight into the fence-stripping JSON cleaner. A string is
 * still scored as before; the string in a reply's text / content / output field is scored the same
 * way; a reply with no string is a typed refusal (failure_mode "non_string_reply"), not a throw.
 */
import { describe, expect, test } from "bun:test";
import { resolveComprehensibilityCheck } from "../../src/resolvers/comprehensibility-check.js";

const template = {
  id: "t1",
  name: "save_edit",
  description: "Edit a file and save it",
  tasks: [{ id: "a", resolver: "fs_edit", description: "apply the edit" }],
};
const answer = JSON.stringify({ what: "edit a file and save it", why: "t1 save edit", when_useful: "apply the edit" });
const run = (reply: unknown) =>
  resolveComprehensibilityCheck({
    type: "comprehensibility_check",
    template_json: template,
    floor: 0.5,
    _similarityFn: (a, b) => (a.length > 0 && b.length > 0 ? 1 : 0),
    _llmFn: async () => reply as never,
  });

describe("comprehensibility_check: the evaluator reply's form", () => {
  test("MUST-FAIL: an object reply with no string field is a typed refusal, not a throw", async () => {
    const r = await run({ what: 1, choices: [] });
    expect(r.shape).toBe("structuredError");
    const body = r.body as Record<string, unknown>;
    expect(body["failure_mode"]).toBe("non_string_reply");
    expect(String(body["detail"])).toContain("object");
  });

  test("MUST-FAIL: the string in a structured reply's content field is scored like the string itself", async () => {
    const direct = await run(answer);
    for (const k of ["text", "content", "output"]) {
      const r = await run({ [k]: answer });
      expect(r.shape).toBe("comprehensibilityScore");
      expect((r.body as Record<string, unknown>)["raw_answers"]).toEqual((direct.body as Record<string, unknown>)["raw_answers"]);
    }
  });

  test("CONTROL: a string reply is scored as before", async () => {
    const r = await run(answer);
    expect(r.shape).toBe("comprehensibilityScore");
    const body = r.body as Record<string, unknown>;
    expect(body["passed"]).toBe(true);
    expect(body["overall_score"]).toBe(1);
    expect(body["raw_answers"]).toEqual({ what: "edit a file and save it", why: "t1 save edit", when_useful: "apply the edit" });
  });
});
