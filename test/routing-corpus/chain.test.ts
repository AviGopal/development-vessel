// PROTECTED: the routing corpus's MANIFEST.jsonl and cases/ are self-consistent (DESIGN §3.3), in canonical bytes, and
// at least MIN_CASES long. Append-only across commits is the admission glue's check (a diff against the parent and the
// accepted pins); this file checks what one tree can: contiguous lines, every link recomputing, every case_sha256
// matching its file, every file listed exactly once, no listed file missing.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, verifyChain } from "./runner";

/** FROZEN: may only rise (closed file). An operator append act raises it with the cases it appends. */
const MIN_CASES = 14;
const DIR = import.meta.dir;

describe("routing corpus chain", () => {
  const chain = verifyChain(DIR);
  test("the manifest and cases/ verify with no problem", () => {
    expect(chain.problems).toEqual([]);
  });
  test(`at least MIN_CASES (${MIN_CASES}) cases are chained`, () => {
    expect(chain.n).toBeGreaterThanOrEqual(MIN_CASES);
  });
  test("every case file is in canonical bytes (a whitespace-only edit is a hash change)", () => {
    for (const l of chain.lines) {
      const bytes = readFileSync(join(DIR, l.path), "utf8");
      expect(canonical(JSON.parse(bytes))).toBe(bytes);
    }
  });
});
