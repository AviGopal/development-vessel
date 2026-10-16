// The author route's registration edits survive the file-scope gate. Measured 2026-10-15/16 (both compose nodes, 24 h):
// every missing-producer compose lost its config.ts / routes/impulses.ts edits there ("DROPPED 3 off-target edit op(s)"),
// because (1) the author spec named bare `src/...` paths, which composeTargetFiles never admits as targets, and (2) the
// sibling-wiring exception's symbol regex had no `async`, so the impulses.ts case arm calling a new `export async function`
// was not recognised as wiring it. The semantic gate then rejected the remaining module as dead code.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composeTargetFiles, fileScopeGate } from "../../src/resolvers/feature-compose";

const V = "repos/development-vessel";
describe("registration path R1", () => {
  test("[MUST-FAIL] an edit wiring a new `export async function` from an on-target created module is kept", () => {
    const ops = [
      { kind: "create_file", path: `${V}/src/resolvers/task-summary.ts`, content: "export async function resolveTaskSummary(pointer: unknown) { return pointer; }" },
      { kind: "edit", path: `${V}/src/routes/impulses.ts`, new_string: 'case "task_summary": return resolveTaskSummary(pointer);' },
    ];
    const r = fileScopeGate(ops, [`${V}/src/resolvers/task-summary.ts`]);
    expect(r.dropped_paths).toEqual([]);
    expect(r.ops.length).toBe(2);
  });
  test("[CONTROL] an off-target edit that wires nothing new is still dropped", () => {
    const ops = [
      { kind: "create_file", path: `${V}/src/resolvers/task-summary.ts`, content: "export async function resolveTaskSummary() {}" },
      { kind: "edit", path: `${V}/src/judge/gap-policy.ts`, new_string: "const unrelated = 1;" },
    ];
    expect(fileScopeGate(ops, [`${V}/src/resolvers/task-summary.ts`]).dropped_paths).toEqual([`${V}/src/judge/gap-policy.ts`]);
  });
  test("[MUST-FAIL] the author-route spec names the registration files as repos/<vessel>/ paths", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "gap-to-feature.ts"), "utf8");
    expect(src).toContain("repos/${vessel}/src/config.ts");
    expect(src).toContain("repos/${vessel}/src/routes/impulses.ts");
    expect(src).toContain("Create repos/${vessel}/src/resolvers/${kebab}.ts");
  });
  test("[CONTROL] with those paths in the spec, the compose's targets include both registration files", () => {
    const spec = `1. Create ${V}/src/resolvers/task-summary.ts …\n2. … ${V}/src/config.ts … ${V}/src/routes/impulses.ts … ${V}/test/resolvers/task-summary.test.ts.`;
    const t = composeTargetFiles({ edit_site: `${V}/src/resolvers/task-summary.ts` }, spec);
    expect(t).toContain(`${V}/src/config.ts`);
    expect(t).toContain(`${V}/src/routes/impulses.ts`);
    expect(t).toContain(`${V}/src/resolvers/task-summary.ts`);
  });
});
