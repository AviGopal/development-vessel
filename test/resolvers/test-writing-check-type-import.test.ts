// W2: A TYPE-ONLY IMPORT OF THE EDIT SITE DOES NOT COUNT (check-first, 2026-10-08).
//
// checkImportsEditSite (check-supply-admission.ts, used by feature_compose's test_writing verify AND gap-check-supply's
// arm step) requires the check to IMPORT the gap's edit site, so its red can only come from the module the gap names.
// It read the import through scope-earn-in.ts testImportsFile, whose `from "…"` match did not exclude type-only forms.
// A type-only import is erased by the transpiler (bun: `import type {…}`, `import type * as X`, `export type {…} from`,
// and an import whose EVERY inline specifier is `type` all leave the module unloaded; a mixed `{ type A, b }` loads it),
// so a check whose only link to the edit site is a type import cannot exercise it, yet W2 accepted it.
//
// The rule is W2's only: scope-earn-in's coverage caller keeps its semantics (a type-only importer there is a candidate
// killer that may load the target transitively; over-inclusion is conservative).
import { describe, expect, test } from "bun:test";

const csa = await import("../../src/resolvers/check-supply-admission.js") as Record<string, unknown>;
type EditSiteImport = { ok: boolean; stage?: string; edit_site: string | null; reason?: string };
const check = csa["checkImportsEditSite"] as (source: string, checkRel: string, editSite: unknown, srcExists: (rel: string) => boolean) => Promise<EditSiteImport>;

const CHECK = "test/checks/gap-drain-type.check.ts";
const SITE = "repos/development-vessel/src/services/gap-drain-observer.ts";
const SPEC = "../../src/services/gap-drain-observer";
const H = `import { expect, test } from "bun:test";\n`;
const exists = (rel: string) => rel === "src/services/gap-drain-observer.ts";
const body = `test("t", () => { expect(1).toBe(2); });\n`;

async function verdict(imports: string, editSite: unknown = SITE): Promise<EditSiteImport> {
  return check(H + imports + "\n" + body, CHECK, editSite, exists);
}

describe("W2: a type-only import of the edit site is erased at runtime, so it does not count", () => {
  const refused: Array<[string, string]> = [
    ["import type { T }", `import type { T } from "${SPEC}";`],
    ["import type * as m", `import type * as m from "${SPEC}";`],
    ["export type { T } from", `export type { T } from "${SPEC}";`],
    ["import { type A, type B } (every inline specifier is type)", `import { type A, type B } from "${SPEC}";`],
    ["import type Default", `import type Obs from "${SPEC}";`],
    ["multi-line import type { … }", `import type {\n  A,\n  B,\n} from "${SPEC}.ts";`],
  ];
  for (const [label, imports] of refused) {
    test(`[MUST-FAIL] ${label} is refused with test_writing_check_misses_edit_site`, async () => {
      const r = await verdict(imports);
      expect(r.ok).toBe(false);
      expect(r.stage).toBe("test_writing_check_misses_edit_site");
      expect(r.edit_site).toBe("src/services/gap-drain-observer.ts");
    });
  }

  test("[MUST-FAIL] no edit site: a check that only TYPE-imports an existing src module is not awarded it as the edit site", async () => {
    const r = await verdict(`import type { T } from "${SPEC}";`, null);
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("test_writing_check_misses_edit_site");
  });
});

describe("W2 controls: every runtime import of the edit site still counts", () => {
  const passing: Array<[string, string]> = [
    ["mixed import { type A, b }", `import { type A, b } from "${SPEC}";`],
    ["import * as mod", `import * as mod from "${SPEC}";`],
    ["named import", `import { observe } from "${SPEC}";`],
    ["dynamic import()", `const m = await import("${SPEC}");`],
    [".js-suffixed", `import * as mod from "${SPEC}.js";`],
    [".ts-suffixed", `import * as mod from "${SPEC}.ts";`],
    ["a type import PLUS a separate value import", `import type { T } from "${SPEC}";\nimport * as mod from "${SPEC}";`],
    ["default plus inline type", `import Obs, { type T } from "${SPEC}";`],
    ["bare side-effect import", `import "${SPEC}";`],
    ["empty braces (a side-effect import)", `import {} from "${SPEC}";`],
    ["a default binding literally named `type`", `import type from "${SPEC}";`],
    ["a type import of ANOTHER module before a value import of the edit site", `import type { X } from "../../src/other";\nimport * as mod from "${SPEC}";`],
    ["require()", `const m = require("${SPEC}");`],
  ];
  for (const [label, imports] of passing) {
    test(`[CONTROL] ${label} counts`, async () => {
      const r = await verdict(imports);
      expect(r).toEqual({ ok: true, edit_site: "src/services/gap-drain-observer.ts" });
    });
  }

  test("[CONTROL] no edit site: a value import of an existing src module still becomes the edit site", async () => {
    expect(await verdict(`import * as mod from "${SPEC}";`, null)).toEqual({ ok: true, edit_site: "src/services/gap-drain-observer.ts" });
  });

  test("[CONTROL] a one-level ../src/ specifier from test/checks/ still misses the edit site", async () => {
    const r = await verdict(`import * as mod from "../src/services/gap-drain-observer";`);
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("test_writing_check_misses_edit_site");
  });
});
