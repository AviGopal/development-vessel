import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * resolver-author — the meta-cognition keystone (2026-06-05).
 *
 * Consumes a capability_gap_audit-emitted substrateGap (category=
 * missing_capability), reads ONE existing resolver as a pattern reference and
 * the three-place-rule guidance from development-vessel/CLAUDE.md, then
 * dispatches an LLM call to author a complete 4-file resolver patch set:
 *
 *   1. src/resolvers/<name>.ts            — new file: resolver implementation
 *   2. test/resolvers/<name>.test.ts      — new file: per-resolver test
 *   3. src/config-patched.ts              — staged full content for config.ts
 *   4. src/impulses-patched.ts            — staged full content for impulses.ts
 *
 * The LLM emits a JSON `new_files[]` payload. apply_proposal_as_patch's
 * multifile branch picks it up, stages all 4 files into a mitosis dir, and
 * writes mitosis-pending.json. The downstream mitosis-tick → cutover chain
 * applies them via the existing host-sync intent path with no further LLM
 * involvement.
 *
 * Boredom goal[29] dispatches this; if no capability_gap_audit substrateGap
 * is open the chain returns dispatched=null (a normal idle trace).
 *
 * Closes the last operator-extension required for the substrate to grow its
 * own capability surface. After this lands, "we tried X, no resolver" becomes
 * a substrate-authored resolver.
 */
export const RESOLVER_AUTHOR_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:resolver-author",
  name: "resolver-author",
  description:
    "Read an open capability_gap_audit substrateGap, read one existing resolver " +
    "as a pattern reference + the three-place-rule guidance, then LLM-author a " +
    "4-file resolver patch (src/resolvers/<name>.ts + test + config-patched + " +
    "impulses-patched). Writes the proposal as new_files[] JSON so " +
    "apply_proposal_as_patch's multifile branch stages all four into a mitosis " +
    "dir for the existing cutover machinery.",
  inputShapes: [],
  outputShapes: ["activityTemplateProposal", "structuredError"],
  tags: [
    "intent:author_resolver",
    "phase:author",
    "lift.autonomous.loop",
    "boredom_target_template",
    "meta_cognition_bootstrap",
  ],
  variables: [],
  tasks: [
    {
      id: "read_gap",
      description:
        "Load the newest open substrateGap with category=missing_capability. " +
        "The dev-vessel substrateGap resolver filters by category server-side.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: "http://127.0.0.1:8090/v2/impulses/resolve",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          impulse: {
            pointer: {
              type: "substrateGap",
              category: "missing_capability",
              status: "open",
              limit: 1,
            },
          },
        }),
        timeoutMs: 5000,
      },
      outputShapes: ["substrateGapQueryResult"],
    },
    {
      id: "read_existing_resolver_example",
      description:
        "Load one existing resolver as a pattern reference. posterior-consistency-audit " +
        "is small (~150 LOC) and shows the canonical pattern: typed pointer, HTTP " +
        "fetch from activity-api, deterministic aggregation, substrateGap emission.",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "/vessels/development-vessel/src/resolvers/posterior-consistency-audit.ts",
      },
      outputShapes: ["fileContent"],
    },
    {
      id: "read_three_place_rule",
      description:
        "Load the three-place-rule section from development-vessel/CLAUDE.md so " +
        "the LLM's output complies with the lint gate (config.ts + impulses.ts + " +
        "per-resolver test).",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "/vessels/development-vessel/CLAUDE.md",
      },
      outputShapes: ["fileContent"],
    },
    {
      id: "read_config_current",
      description:
        "Load current src/config.ts so the LLM can produce a full-content patched " +
        "version (apply_proposal_as_patch's multifile branch writes full files; the " +
        "host-sync poller diffs against the live HEAD).",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "/vessels/development-vessel/src/config.ts",
      },
      outputShapes: ["fileContent"],
    },
    {
      id: "read_impulses_current",
      description:
        "Load current src/routes/impulses.ts for the same reason as read_config_current.",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "/vessels/development-vessel/src/routes/impulses.ts",
      },
      outputShapes: ["fileContent"],
    },
    {
      id: "llm_author_resolver",
      description:
        "LLM authors the 4-file patch. Inputs: capability_gap details, existing " +
        "resolver pattern, three-place-rule, current config.ts + impulses.ts. " +
        "Output: JSON with required_code_modifications[] (for skip-loop pre-flight) " +
        "AND new_files[] (the actual patch payload the multifile branch consumes).",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        system_prompt:
          "You are a TypeScript resolver author. Output ONLY a JSON object with no " +
          "markdown fences and no prose. Every file you produce must be a complete, " +
          "compilable TypeScript file. Do not truncate. Do not summarise.",
        prompt:
          "## Capability gap (from substrateGap)\n" +
          "{{read_gap_text}}\n\n" +
          "## Existing resolver as pattern reference (posterior-consistency-audit.ts)\n" +
          "{{read_existing_resolver_example_text}}\n\n" +
          "## Three-place rule (from development-vessel/CLAUDE.md)\n" +
          "{{read_three_place_rule_text}}\n\n" +
          "## Current src/config.ts (you must produce a full patched version adding the new shape)\n" +
          "{{read_config_current_text}}\n\n" +
          "## Current src/routes/impulses.ts (you must produce a full patched version adding the import + case)\n" +
          "{{read_impulses_current_text}}\n\n" +
          "## Your task\n\n" +
          "Author a new resolver that fills the capability gap above. Follow the three-place rule:\n" +
          "1. Implement in src/resolvers/<resolver_name>.ts (new file, full content).\n" +
          "2. Add the shape to discovery.shapes in src/config.ts (produce FULL patched file).\n" +
          "3. Add the import + case in src/routes/impulses.ts (produce FULL patched file).\n" +
          "4. Author a per-resolver test in test/resolvers/<resolver_name>.test.ts (new file, full content; at least 4 cases).\n\n" +
          "## Output schema (JSON only — no markdown, no prose)\n\n" +
          "{\n" +
          "  \"capability_gap_id\": \"<from substrateGap.id>\",\n" +
          "  \"required_code_modifications\": [\n" +
          "    { \"file\": \"repos/development-vessel/src/resolvers/<resolver_name>.ts\", \"description\": \"new resolver implementation\" }\n" +
          "  ],\n" +
          "  \"new_files\": [\n" +
          "    { \"path\": \"repos/development-vessel/src/resolvers/<resolver_name>.ts\", \"content\": \"<FULL TypeScript source>\" },\n" +
          "    { \"path\": \"repos/development-vessel/test/resolvers/<resolver_name>.test.ts\", \"content\": \"<FULL test source>\" },\n" +
          "    { \"path\": \"repos/development-vessel/src/config.ts\", \"content\": \"<FULL patched config.ts adding the new shape inside discovery.shapes>\" },\n" +
          "    { \"path\": \"repos/development-vessel/src/routes/impulses.ts\", \"content\": \"<FULL patched impulses.ts adding the new import + case>\" }\n" +
          "  ]\n" +
          "}\n\n" +
          "## Hard constraints\n\n" +
          "- Resolver pointer type MUST match the proposed_resolver_name from the gap (snake_case).\n" +
          "- Resolver MUST emit ResolverResult with a typed output_shape.\n" +
          "- new_files[].path MUST start with `repos/development-vessel/`.\n" +
          "- Patched config.ts and impulses.ts MUST be the FULL current file content with your additions inserted in place — do not abbreviate, do not write 'rest of file unchanged'.\n" +
          "- test file MUST use bun:test, mock fetch where needed, and contain at least 4 `it(...)` cases.\n" +
          "- Output ONLY the JSON object. No markdown fences. No commentary.",
        model: "auto",
        max_tokens: 16000,
      },
      outputShapes: ["resolverAuthorDraft"],
    },
    {
      id: "write_proposal",
      description:
        "Persist the LLM-drafted resolver patch as a proposal report at " +
        "/workspace/proposals/auto-resolver-<timestamp>-report.json so the " +
        "apply_proposal_as_patch multifile branch picks it up on the next tick.",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "/workspace/proposals/auto-resolver-{{scenario_id}}-report.json",
        content: "{{llm_author_resolver_text}}",
      },
      outputShapes: ["activityTemplateProposal"],
    },
  ],
};
