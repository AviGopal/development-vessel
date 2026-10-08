/**
 * THE TREE A GAP'S LITERAL CHECK IS EVALUATED ON. One resolver, shared by the evaluator (gap-to-feature
 * verifyGapCondition / evaluateGapCheck, class 1 and 1b), the class-1 classifier (substrate-gap classifyFalsifier and
 * its arming guard) and compose grounding's region gate (lib/region-literal.ts), so the label and the measurement
 * cannot read different files.
 *
 * The evaluator reads the RUNNING vessel tree: MITOSIS_RUNTIME_DIR (default /vessels) joined with the edit site minus
 * a leading `/` and `repos/`. The classifier used to read WORKSPACE_ROOT (captured at load; the super-repo clone in
 * the container, where `<vessel>/src/...` never exists) with the same stripped path, so every hardcoded_url gap with
 * an edit site was born unresolvable with a false "without edit_site" reason, and a literal present only in the
 * workspace would have been labelled class1 for a check the evaluator answers 'unknown'.
 *
 * Read at call time; an empty value is unset (the rule gap-to-feature's envPath already used).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function evaluatorTreeRoot(): string {
  const raw = process.env["MITOSIS_RUNTIME_DIR"];
  return raw === undefined || raw.trim() === "" ? "/vessels" : raw;
}

/**
 * The edit site the evaluator measures, by ITS precedence: a string file_path wins over edit_site, a trailing
 * `:<line>` is stripped, and an empty result is no site at all.
 */
export function evaluatorEditSite(meta: Record<string, unknown> | null | undefined): string | null {
  const m = meta ?? {};
  const raw = typeof m["file_path"] === "string" ? (m["file_path"] as string) : typeof m["edit_site"] === "string" ? (m["edit_site"] as string) : null;
  const site = raw ? raw.replace(/:\d+$/, "") : null;
  return site ? site : null;
}

/** The absolute path the evaluator reads for an edit site. */
export function evaluatorTreePath(editSite: string): string {
  return join(evaluatorTreeRoot(), editSite.replace(/^\//, "").replace(/^repos\//, ""));
}

export type EvaluatorLiteralRead =
  | { ok: true; path: string; count: number }
  | { ok: false; path: string; kind: "missing" | "unreadable"; error: string };

/**
 * Count a literal (indexOf, never a regex) in the edit site where the evaluator reads it. FAIL CLOSED: a missing file
 * and an unreadable one (EISDIR, EACCES, ...) are their own outcomes, never "0 occurrences".
 */
export function countLiteralOnEvaluatorTree(editSite: string, literal: string): EvaluatorLiteralRead {
  const path = evaluatorTreePath(editSite);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, path, kind: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable", error: code ?? String((err as Error).message ?? err).slice(0, 120) };
  }
  let count = 0;
  if (literal.length > 0) for (let i = text.indexOf(literal); i !== -1; i = text.indexOf(literal, i + literal.length)) count++;
  return { ok: true, path, count };
}
