import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * goal-shape-pre-check — deterministic pre-flight gate before template dispatch.
 *
 * Before executing any template, verify that its output_shapes intersect with
 * the goal's expected_output_shapes. Zero LLM cost for the intersection check
 * itself (a single cheap llm call to parse JSON fields and compute the set
 * intersection is acceptable vs re-implementing JSON parsing in a resolver).
 *
 * If the caller has no expected_output_shapes constraint (empty or null), the
 * verdict is 'no_constraint' and the gate always passes — this preserves
 * composability when the caller hasn't declared its shape requirements.
 *
 * If the intersection is empty the emit_result task produces a JSON body
 * containing `"verdict":"fail"` and the forbiddenPattern guard fires, propagating
 * a verifier_negative failure_mode that Thompson Sampling can credit against the
 * selected template.
 *
 * Composes cleanly with goal-execution-with-retry:
 *   Step 1: goal-shape-pre-check (gate — fast, deterministic)
 *   Step 2: execute goal if gate passes
 *   Step 3: recover-from-goal-failure if execution fails
 */
export const GOAL_SHAPE_PRE_CHECK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:goal-shape-pre-check",
  name: "goal-shape-pre-check",
  description:
    "Pre-flight gate: fetches a template's output_shapes from activity-api, computes " +
    "intersection with the caller's expected_output_shapes, and emits a " +
    "shapeContractCheckResult. Verdict 'no_constraint' when expected_output_shapes is " +
    "empty/null (gate always passes). Verdict 'fail' when intersection is empty — the " +
    "emit_result task's forbiddenPattern guard converts this to a verifier_negative " +
    "failure_mode for Thompson Sampling credit. Zero network hops for the intersection " +
    "logic itself; one GET to activity-api to fetch the template contract.",
  inputShapes: [],
  outputShapes: ["shapeContractCheckResult"],
  tags: ["goal-execution", "validation", "pre-check", "deterministic"],
  variables: [
    {
      name: "template_id",
      description: "ID of the activity template to validate against the shape contract",
    },
    {
      name: "expected_output_shapes",
      description:
        "JSON array of shape names the caller requires (e.g. '[\"fileChange\",\"commitSha\"]'). " +
        "Pass empty string or '[]' to skip the constraint check (verdict = no_constraint).",
    },
  ],
  tasks: [
    {
      id: "fetch_template_contract",
      description:
        "Fetch the activity template's full JSON from activity-api so the next task can " +
        "read its outputShapes (or output_shapes) field. Returns the raw template JSON " +
        "as templateContract.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        url: "http://127.0.0.1:8080/v2/activities/templates/{{template_id}}",
        method: "GET",
        headers: { Accept: "application/json" },
        timeoutMs: 5000,
      },
      outputShapes: ["templateContract"],
    },
    {
      id: "check_shape_intersection",
      description:
        "Compute the intersection of the template's output_shapes (from templateContract) " +
        "and the caller's expected_output_shapes. Returns a JSON object: " +
        "{ intersects, intersection, template_output_shapes, expected, verdict } where " +
        "verdict is 'pass', 'fail', or 'no_constraint'.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt:
          "You are a precise JSON comparator. Given a template contract and a list of " +
          "expected output shapes, compute their intersection.\n\n" +
          "## Template contract (from activity-api)\n\n" +
          "{{fetch_template_contract_content}}\n\n" +
          "## Expected output shapes (caller constraint)\n\n" +
          "{{expected_output_shapes}}\n\n" +
          "## Instructions\n\n" +
          "1. Extract the template's output_shapes array from the template contract JSON " +
          "   (field may be 'outputShapes' or 'output_shapes' — check both).\n" +
          "2. Parse the expected_output_shapes as a JSON array. If the value is empty " +
          "   string, null, '[]', or the array is empty — set verdict to 'no_constraint'.\n" +
          "3. Compute the intersection (shapes present in both arrays).\n" +
          "4. Set verdict: 'pass' if intersection is non-empty, 'fail' if intersection is " +
          "   empty AND expected is non-empty, 'no_constraint' if expected is empty/null.\n\n" +
          "Output ONLY the JSON object below — no markdown fences, no prose:\n\n" +
          "{\n" +
          '  "intersects": <boolean>,\n' +
          '  "intersection": ["<shape1>", "..."],\n' +
          '  "template_output_shapes": ["<shape1>", "..."],\n' +
          '  "expected": ["<shape1>", "..."],\n' +
          '  "verdict": "pass" | "fail" | "no_constraint"\n' +
          "}",
        model: "auto",
        max_tokens: 400,
      },
      outputShapes: ["shapeContractCheckResult"],
    },
    {
      id: "emit_result",
      description:
        "Pass-through task that surfaces the shape contract check result as the template's " +
        "primary output. The forbiddenPattern guard on this task converts a 'fail' verdict " +
        "into a verifier_negative failure_mode, which Thompson Sampling credits against " +
        "the selected template. 'pass' and 'no_constraint' verdicts flow through cleanly.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt:
          "Echo the following shape contract check result as-is. Output ONLY the JSON — " +
          "no prose, no fences:\n\n{{check_shape_intersection_content}}",
        model: "auto",
        max_tokens: 400,
      },
      outputShapes: ["shapeContractCheckResult"],
      // Fail this task — and propagate verifier_negative — if the verdict is 'fail'.
      // 'pass' and 'no_constraint' contain neither '"verdict":"fail"' nor '"verdict": "fail"'
      // so the pattern never fires for healthy checks.
      // INERT — the engine never reads `task.validation` (no reference in
      // ias-executor-ts/src/engine.ts), and pattern mode is out of scope even in the
      // validation resolver (resolvers/validation.ts:15). This assertion has never
      // fired. Kept as a statement of INTENT until task-level assertions exist; do not
      // read it as a gate.
      validation: {
        forbiddenPatterns: ['"verdict":"fail"', '"verdict": "fail"'],
      },
    },
  ],
};

/**
 * goal-shape-pre-check, VARIANT V6 (reach conditions 1+2: the right predicate, recorded before acting).
 *
 * The same pre-run activity, asked a wider question: not only "does the chosen template's output intersect the expected
 * shapes" but "what will count as this goal being reached" — the reach judge's own completion-state question
 * (goal-host reach-grounding.ts COMPLETION_STATE_QUESTION) asked BEFORE anything runs, with no output in front of it.
 * Its answer (completion shapes, a checkable criterion, kind, subject, and optionally a check in this vessel's gap
 * falsifier grammar) is frozen on the dispatch and every verdict of that dispatch is graded against it. It emits the
 * family's shapeContractCheckResult, with `expected` = the recorded completion shapes.
 *
 * The prompt is goal-host's (goal-spec.ts buildGoalSpecPrompt), handed in as one variable, so the question has ONE
 * text, and goal-host asks it through THIS row's task prompt: goal-host picks the compile variant from this family by
 * Thompson over the family's graded α/β (any variant whose prompt takes {{goal_spec_prompt}}), so a better variant
 * replaces this one with no code change. goal-host records each run's trace under the chosen id with no reach tag; a
 * compile that did not complete is persisted failed with no tasks and therefore carries the β withhold
 * (beta_withheld:true), since activity-api's insert would otherwise blame it. NO WRITER GRADES THIS VARIANT YET from
 * an independent verdict on the dispatch: until one exists the variant is ungraded (filed with D3b-1), never graded by
 * the verdict it shapes.
 *
 * LAW 4 TENSION, NAMED: this row is DECLARED, not earned. A check on the judge cannot be extracted from the judge's own
 * reached executions before it exists (the same reason verdict-corpus-runner is seeded). Its replacement is planned by
 * extraction: once independent verdicts grade this variant, a ribosome-extracted variant of goal-shape-pre-check that
 * reaches more often replaces it, and this declared row is retired.
 */
export const GOAL_SHAPE_PRE_CHECK_V6_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:goal-shape-pre-check:v6-completion-state",
  name: "goal-shape-pre-check (V6: completion state recorded before the run)",
  description:
    "Variant of goal-shape-pre-check. Records a goal's acceptance predicate BEFORE the run: the reach judge's completion-" +
    "state question asked with no output in front of it. Emits shapeContractCheckResult whose `expected` is the recorded " +
    "completion shapes, plus the criterion, kind, subject and an optional check in the gap falsifier grammar.",
  inputShapes: [],
  outputShapes: ["shapeContractCheckResult"],
  tags: ["goal-execution", "validation", "pre-check", "reach-condition"],
  // A variant of the family, not a new activity.
  variant_of: "development-vessel:goal-shape-pre-check",
  variables: [
    {
      name: "goal_spec_prompt",
      description: "The completion-state question for one goal, built by goal-host (goal-spec.ts buildGoalSpecPrompt).",
    },
  ],
  tasks: [
    {
      id: "compile_spec",
      description:
        "Ask the completion-state question before the run. Returns { completion_shapes, criterion, kind, subject, check }.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt: "{{goal_spec_prompt}}",
        model: "auto",
        max_tokens: 400,
      },
      outputShapes: ["shapeContractCheckResult"],
    },
  ],
} as ActivityTemplate;
