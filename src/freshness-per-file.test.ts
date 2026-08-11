// Pins the per-file freshness contract.
//
// THE DEFECT (2026-08-11, commit 2dbb4a6): the cutover verified ONE file — the
// sentinel — because `staged_base_sha` is a single hash. A mitosis staged from an
// older base touched two files; the sentinel was untouched so the gate passed, and
// applying it silently reverted 14 lines of newer work in the second file with no
// conflict raised. An autonomous commit undid an operator fix and nothing reported it.
//
// THE WRONG FIX (067b3f46, autonomous, landed and reverted): compare every staged
// file's live hash against `staged_base_sha`. That value is the SENTINEL's hash, so
// every other file mismatches by construction — it would have refused ALL multi-file
// cutovers. The missing information is per-file and must be recorded at staging.
//
// These tests pin the DECISION RULE both ways, because the failure modes are
// opposite: refusing nothing lets work be reverted; refusing everything halts
// multi-file self-development.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** The shipped decision, isolated: which staged files have drifted? */
function drifted(
  stagedFiles: readonly string[],
  recorded: Record<string, string> | undefined,
  live: Record<string, string | undefined>,
): string[] {
  if (!recorded || typeof recorded !== "object") return [];
  const out: string[] = [];
  for (const rel of stagedFiles) {
    const base = recorded[rel];
    if (typeof base !== "string" || base.length === 0) continue; // unknown
    const now = live[rel];
    if (now === undefined) continue;                              // absent -> net-new
    if (sha(now) !== base) out.push(rel);
  }
  return out;
}

describe("per-file freshness — catches the 2dbb4a6 case", () => {
  test("a non-sentinel file changed since staging IS drift", () => {
    const staged = ["src/index.ts", "src/resolvers/cutover.ts"];
    const recorded = { "src/index.ts": sha("A"), "src/resolvers/cutover.ts": sha("B") };
    // sentinel unchanged, second file edited since staging — the exact 2dbb4a6 shape
    const live = { "src/index.ts": "A", "src/resolvers/cutover.ts": "B-with-newer-work" };
    expect(drifted(staged, recorded, live)).toEqual(["src/resolvers/cutover.ts"]);
  });

  test("nothing changed means no drift", () => {
    const staged = ["a.ts", "b.ts"];
    const recorded = { "a.ts": sha("A"), "b.ts": sha("B") };
    expect(drifted(staged, recorded, { "a.ts": "A", "b.ts": "B" })).toEqual([]);
  });
});

describe("per-file freshness — must NOT refuse everything (the 067b3f46 trap)", () => {
  test("different files with different content are NOT mutually mismatched", () => {
    // The landed wrong fix compared every file to ONE sha; under that rule this
    // case refuses. Under the correct rule it passes.
    const staged = ["a.ts", "b.ts", "c.ts"];
    const recorded = { "a.ts": sha("A"), "b.ts": sha("B"), "c.ts": sha("C") };
    expect(drifted(staged, recorded, { "a.ts": "A", "b.ts": "B", "c.ts": "C" })).toEqual([]);
  });

  test("no recorded map at all — older staging leg — refuses nothing", () => {
    expect(drifted(["a.ts"], undefined, { "a.ts": "anything" })).toEqual([]);
  });

  test("a file with no recorded entry is unknown, not drifted", () => {
    expect(drifted(["a.ts", "new.ts"], { "a.ts": sha("A") }, { "a.ts": "A", "new.ts": "x" })).toEqual([]);
  });

  test("a live file that is absent is net-new, not drifted", () => {
    expect(drifted(["new.ts"], { "new.ts": sha("") }, { "new.ts": undefined })).toEqual([]);
  });
});
