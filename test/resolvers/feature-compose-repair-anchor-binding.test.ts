// THE REPAIR ROUND'S old_string IS BOUND TO THE FILE AS IT IS NOW (agf_4ukvuyt3mad9).
//
// fc-repair refused every old_string that was not a byte-for-byte substring of the file. A round that copied the right
// lines from a numbered window but re-indented them, or wrapped them, wrote nothing and the repair stopped. The anchor is
// now bound to the bytes read in the round: verbatim, or the ONE place it matches when only whitespace differs.
//
//   [MUST-FAIL] a multi-line anchor with the wrong indentation binds to its one real place, and the edit applies there.
//   [MUST-FAIL] an LF anchor binds in a CRLF file.
//   [CONTROL]   a genuinely wrong anchor is still refused: the real 2026-10-26 refusal `resolved === false` against a file
//               reading `p["resolved"] === false`, a quote-style variant of an import, and a single token.
//   [CONTROL]   an anchor that matches two places modulo whitespace is refused, never guessed.
//   [CONTROL]   a verbatim anchor is used as it is.
//   [MUST-FAIL] wiring: the fc-repair edit writes the bound anchor, not the model's text.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

await isolateRuntimeRoot("fc-repair-anchor-binding", { who: "feature-compose-repair-anchor-binding.test.ts" });
const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;

const FILE = [
  `import { describe, expect, test } from "bun:test";`,
  `export function answerOutcome(p: Record<string, unknown>) {`,
  `  const r = { ...(p["resolved"] === false ? { resolvedFalse: true as const } : {}) };`,
  `    if (p["resolved"] === false && p["dispatch_budget_exhausted"] === true) {`,
  `      return { ok: false, refusal: "budget_exhausted" };`,
  `    }`,
  `  return { ok: true, ...r };`,
  `}`,
].join("\n");

describe("the repair round's anchor is bound to the file's current bytes", () => {
  it("[MUST-FAIL] a re-indented multi-line anchor binds to its one place and the edit applies there", () => {
    const old = `  if (p["resolved"] === false && p["dispatch_budget_exhausted"] === true) {\n    return { ok: false, refusal: "budget_exhausted" };`;
    const b = fc["resolveRepairAnchor"]?.(FILE, old);
    expect(b?.via).toBe("whitespace");
    expect(FILE.split(b.anchor).length - 1).toBe(1);
    expect(b.anchor.startsWith(`    if (p["resolved"]`)).toBe(true);
    expect(b.anchor.endsWith(`refusal: "budget_exhausted" };`)).toBe(true);
    const next = FILE.replace(b.anchor, () => `    if (p["dispatch_budget_exhausted"] === true) {\n      return { ok: false, refusal: "budget_exhausted" };`);
    expect(next).toContain(`    if (p["dispatch_budget_exhausted"] === true) {\n      return { ok: false, refusal: "budget_exhausted" };\n    }`);
  });

  it("[MUST-FAIL] an LF anchor binds in a CRLF file", () => {
    const crlf = FILE.replace(/\n/g, "\r\n");
    const b = fc["resolveRepairAnchor"]?.(crlf, `export function answerOutcome(p: Record<string, unknown>) {\n  const r = {`);
    expect(b?.via).toBe("whitespace");
    expect(b.anchor).toBe(`export function answerOutcome(p: Record<string, unknown>) {\r\n  const r = {`);
  });

  it("[CONTROL] a genuinely wrong anchor is still refused", () => {
    expect(fc["resolveRepairAnchor"](FILE, "resolved === false")).toEqual({ refused: "repair_anchor_absent", hits: 0 });
    expect(fc["resolveRepairAnchor"](FILE, `import { describe, expect, test } from 'bun:test';`)).toEqual({ refused: "repair_anchor_absent", hits: 0 });
    expect(fc["resolveRepairAnchor"](FILE, "export {}")).toEqual({ refused: "repair_anchor_absent", hits: 0 });
    expect(fc["resolveRepairAnchor"](FILE, "  answerOutcomeX  ")).toEqual({ refused: "repair_anchor_absent", hits: 0 });
  });

  it("[CONTROL] two matches modulo whitespace are refused, never guessed", () => {
    expect(fc["resolveRepairAnchor"](FILE, `p["resolved"]  ===  false`)).toEqual({ refused: "repair_anchor_non_unique", hits: 2 });
  });

  it("[CONTROL] a verbatim anchor is used as it is", () => {
    expect(fc["resolveRepairAnchor"](FILE, `return { ok: true, ...r };`)).toEqual({ anchor: `return { ok: true, ...r };`, via: "verbatim" });
  });

  it("[MUST-FAIL] wiring: the fc-repair edit writes the bound anchor", () => {
    const src = readFileSync(new URL("../../src/resolvers/feature-compose.ts", import.meta.url), "utf8");
    const branch = src.slice(src.indexOf("if (fix?.old_string && efAbs) {"), src.indexOf("repair round threw for"));
    expect(branch).toContain("resolveRepairAnchor(curContent, String(fix.old_string))");
    expect(branch).toContain(`callTool(toolsEndpoint, "fs_edit", { path: efAbs, old_string: osAnchor,`);
    expect(branch).toContain("old_string not found in the file's current content");
  });
});
