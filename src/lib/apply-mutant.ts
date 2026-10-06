// THE OPERATOR-MUTANT APPLIER (scope-earn-in qualify rule a; an EVALUATOR file).
//
// test_suite's mutate_edit runs this file as a PROGRAM FILE (`bun run <this file> <base64 JSON>`) inside the
// detached base-tree worktree. It used to run as an inline `bun -e '<program>'` inside a command substitution, which
// the shell gate's opaque-inline-interpreter rule refuses in the super-repo clone (2026-10-06: every mutant refused,
// read as mutation_not_applied). A checked-in program passes the gate as designed, and the lane cannot alter it
// (EVALUATOR_FILES), so the judge does not depend on a carve-out in the gate.
//
// Input: argv[2] = base64 of {file, start, end, original, replacement}; cwd = the worktree. The edit applies only
// when the file's text at [start, end) is exactly `original` (UTF-16 indices, the same indexing selectMutants
// uses). Exit 0 = applied, 3 = text mismatch (file untouched), 2 = bad input or unreadable file.
import { readFileSync, writeFileSync } from "node:fs";

type Edit = { file: string; start: number; end: number; original: string; replacement: string };

function parse(arg: string | undefined): Edit | null {
  if (!arg) return null;
  try {
    const m = JSON.parse(Buffer.from(arg, "base64").toString("utf8")) as Partial<Edit>;
    if (typeof m.file !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(m.file) || m.file.includes("..")) return null;
    if (!Number.isInteger(m.start) || !Number.isInteger(m.end) || (m.start as number) < 0 || (m.end as number) <= (m.start as number)) return null;
    if (typeof m.original !== "string" || typeof m.replacement !== "string") return null;
    return m as Edit;
  } catch {
    return null;
  }
}

const m = parse(process.argv[2]);
if (!m) process.exit(2);
let src: string;
try {
  src = readFileSync(m.file, "utf8");
} catch {
  process.exit(2);
}
if (src.slice(m.start, m.end) !== m.original) process.exit(3);
writeFileSync(m.file, src.slice(0, m.start) + m.replacement + src.slice(m.end));
process.exit(0);
