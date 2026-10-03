// RUN A GAP-STORE HARNESS FILE IN ITS OWN PROCESS, REPORTING EVERY CASE BY NAME.
//
// substrate-gap captures WORKSPACE_ROOT once, at module load, and `bun test` shares one module registry across
// files: in the full suite the store root is frozen by whichever file imported it first (the checkout), so a
// harness file that drives the real store through gap-to-feature trips its own temp-dir guard in beforeAll and
// the suite reports one "(unnamed)" failure — its cases never run, which is the same as unenforced. A query-
// string fresh import does not help when the code under test imports substrate-gap itself.
//
// This runs `<name>.cases.ts` in a child `bun test` with a fresh temp WORKSPACE_ROOT, output captured to a FILE
// (never a pipe), and returns one row per case so the caller declares one named test per case. A child that
// reports no cases, or fails to run, yields a row that fails by name.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CaseRow = { name: string; ok: boolean; detail: string };

export function runCasesIsolated(casesFile: string): CaseRow[] {
  const root = mkdtempSync(join(tmpdir(), "gap-harness-"));
  const out = join(root, "out.txt");
  try {
    const env: Record<string, string> = { HOME: process.env["HOME"] ?? "", PATH: process.env["PATH"] ?? "", WORKSPACE_ROOT: root, SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER: "1" };
    const p = Bun.spawnSync(["bash", "-c", `bun test ${JSON.stringify(casesFile)} > ${JSON.stringify(out)} 2>&1`], { env, cwd: join(import.meta.dir, "..", ".."), timeout: 120_000 });
    const text = (() => { try { return readFileSync(out, "utf8"); } catch { return ""; } })();
    // Child output is quoted ("  | ") when echoed, so its (pass)/(fail) lines are never read as the parent's.
    const quoted = (t: string): string => t.split("\n").map((l) => `  | ${l}`).join("\n");
    const rows: CaseRow[] = [];
    for (const line of text.split("\n")) {
      const m = /^\((pass|fail)\) (.*?)(?: \[[0-9.]+m?s\])?$/.exec(line);
      if (m) rows.push({ name: m[2]!, ok: m[1] === "pass", detail: m[1] === "fail" ? quoted(text.slice(0, 4000)) : "" });
    }
    if (rows.length === 0 || p.exitCode !== 0) rows.push({ name: `${casesFile} child run (exit ${String(p.exitCode)})`, ok: rows.length > 0 && p.exitCode === 0, detail: quoted(text.slice(-4000)) });
    return rows;
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* temp */ }
  }
}
