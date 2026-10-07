// CHECK-FIRST: A LANDING CANNOT GRADE ITSELF BY EDITING THE CHECK THAT GRADES IT.
//
// The independent landing verdict re-runs a test_suite gap's own check at the landing's parent and at the landed
// sha (test-suite.ts BASE-TREE RUN: a detached worktree of each commit). The landed-sha run therefore uses the
// LANDED copy of the check: a landing that weakens its own check file, or a helper, fixture or mock that file
// imports, reads red at the parent and green at the landing and is grounded. feature_compose refuses such drafts
// (strayTestEdits, the static expect count); the patch_with_tools escalation and the apply_proposal_as_patch paths
// do not, and the verdict is what grants the close.
//
// So the verdict reads the landing's changed files (parent..sha) and the check's import closure AT THE PARENT
// (what the armed check depended on), keeps the closure's non-src members (src/ is where the fix belongs), and
// records an UNGROUNDED label when the two meet. Changed files it cannot read: no label (fail closed). A landing
// that ADDS an unrelated test is not tampering.
import { describe, expect, it } from "bun:test";
import * as g2f from "../../src/resolvers/gap-to-feature.js";

type Verdict = "present" | "absent" | "pending" | "unknown";
type Label = { grounded: boolean; sha: string; parent: string; reason?: string };
type Deps = {
  parentOf: (sha: string) => string | null;
  runAt: (gap: Record<string, unknown>, ref: string) => Promise<Verdict>;
  changedFiles?: (sha: string, parent: string) => string[] | null;
  readAt?: (ref: string, path: string) => string | null;
};
const verdict = g2f.independentLandingVerdict as unknown as (gap: Record<string, unknown>, sha: string, deps: Deps) => Promise<{ label: Label | null; reason: string }>;

const SHA = "b".repeat(40);
const PARENT = "a".repeat(40);
const CHECK = "test/resolvers/thing-check.test.ts";
const gap = {
  id: "tamper-fixture",
  classification_metadata: {
    falsifier_class: "class2",
    evidence_resolve: { shape: "test_suite", input: { vessel: "repos/development-vessel", test_file: CHECK, only_tests: ["the thing works"] }, zero_field: "requested_not_passing" },
  },
};

// The armed check at the parent imports a helper (which imports a fixture), a src module, and a package.
const PARENT_TREE: Record<string, string> = {
  [CHECK]: [
    `import { expect, test } from "bun:test";`,
    `import { fakeStore } from "./helpers/fake-store.js";`,
    `import { thing } from "../../src/resolvers/thing.js";`,
    `test("the thing works", async () => { expect(await thing(fakeStore())).toBe(true); });`,
  ].join("\n"),
  "test/resolvers/helpers/fake-store.ts": `import rows from "../fixtures/rows.json";\nexport const fakeStore = () => rows;`,
  "test/resolvers/fixtures/rows.json": `[]`,
  "src/resolvers/thing.ts": `export const thing = async () => false;`,
};
const readAt = (ref: string, path: string): string | null => (ref === PARENT ? PARENT_TREE[path] ?? null : null);
const deps = (changed: string[] | null): Deps => ({
  parentOf: () => PARENT,
  runAt: async (_g, ref) => (ref === PARENT ? "present" : "absent"), // red at the parent, green at the landing
  changedFiles: () => changed,
  readAt,
});

describe("independent landing verdict: a landing that edits its own check is not grounded", () => {
  it("MUST-FAIL: a landing that modifies the check file itself is recorded ungrounded", async () => {
    const r = await verdict(gap, SHA, deps(["src/resolvers/thing.ts", CHECK]));
    expect(r.label).not.toBeNull();
    expect(r.label!.grounded).toBe(false);
    expect(String(r.label!.reason)).toContain("the landing modified its own check");
    expect(String(r.label!.reason)).toContain(CHECK);
  });

  it("MUST-FAIL: a landing that modifies a helper the check imports is recorded ungrounded, naming the helper", async () => {
    const r = await verdict(gap, SHA, deps(["src/resolvers/thing.ts", "test/resolvers/helpers/fake-store.ts"]));
    expect(r.label?.grounded).toBe(false);
    expect(String(r.label?.reason)).toContain("test/resolvers/helpers/fake-store.ts");
  });

  it("MUST-FAIL: a fixture reached through the helper (transitive import) counts too", async () => {
    const r = await verdict(gap, SHA, deps(["src/resolvers/thing.ts", "test/resolvers/fixtures/rows.json"]));
    expect(r.label?.grounded).toBe(false);
    expect(String(r.label?.reason)).toContain("test/resolvers/fixtures/rows.json");
  });

  it("MUST-FAIL: the landing's changed files cannot be read, so tampering cannot be ruled out: no label (fail closed)", async () => {
    const r = await verdict(gap, SHA, deps(null));
    expect(r.label).toBeNull();
    expect(r.reason).toContain("changed files");
  });

  it("CONTROL: a landing that changes only src is grounded, including the src module the check imports", async () => {
    const r = await verdict(gap, SHA, deps(["src/resolvers/thing.ts", "src/resolvers/other.ts"]));
    expect(r.label?.grounded).toBe(true);
  });

  it("CONTROL: a landing that ADDS an unrelated test file (not in the check's closure) is still grounded", async () => {
    const r = await verdict(gap, SHA, deps(["src/resolvers/thing.ts", "test/resolvers/thing-extra.test.ts"]));
    expect(r.label?.grounded).toBe(true);
  });

  it("CONTROL: a check that stays red at the landing is ungrounded for that reason, not for tampering", async () => {
    const d = deps(["src/resolvers/thing.ts"]);
    d.runAt = async () => "present";
    const r = await verdict(gap, SHA, d);
    expect(r.label?.grounded).toBe(false);
    expect(String(r.label?.reason)).not.toContain("modified its own check");
  });
});
