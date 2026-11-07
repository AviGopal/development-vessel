// Test-file gates: which paths are test files, the stray test edits a non-test-writing compose made, and the test_defect record a refused test-only edit leaves. Lifted as-is from feature-compose.ts.
import { TEST_DEFECT_CERTIFIER_SHAPE } from "../lib/child-script-parse.js";

export const TEST_FILE_RE = /(^|\/)(tests?|__tests__)\/|\.test\.[cm]?[jt]sx?$/;

/**
 * Existing test files a draft edited that its gap does not allow. Editing an unrelated test's assertion is how
 * a guard gets weakened: 0f96c62 rewrote mock-module-completeness's zero-new-debt assertion into an
 * allow-list, as 6ac1aa6 had on 09-05. Allowed: the gap's edit_site (a stale-test gap names its test there)
 * and `alsoAllowed`; never a path in protected_files / protected_src. check_inputs are NOT allowed: they are
 * what judges the fix (a mock-factory gap's check is the guard it must not edit). `editedRel` are
 * vessel-relative paths of EDITED files; newly created test files are not passed in.
 */
export function strayTestEdits(v: string, editedRel: string[], meta: Record<string, unknown>, alsoAllowed: string[] = []): string[] {
  const vessel = v.replace(/^repos\//, "");
  const norm = (p: unknown): string => {
    if (typeof p !== "string" || !p) return "";
    const s = p.replace(/:[^/]*$/, "").replace(/^\/+/, "");
    const pre = `repos/${vessel}/`;
    return s.startsWith(pre) ? s.slice(pre.length) : s;
  };
  const allowed = new Set<string>([norm(meta.edit_site), ...alsoAllowed.map(norm)].filter(Boolean));
  for (const k of ["protected_files", "protected_src"]) {
    const list = meta[k];
    if (Array.isArray(list)) for (const p of list) allowed.delete(norm(p));
  }
  return editedRel.filter((p) => TEST_FILE_RE.test(p) && !allowed.has(p));
}
/** The row's test_defect record when its certifier names `testFile` in `vessel`, else null. */
export function testDefectRecordFor(meta: Record<string, unknown>, testFile: string, vessel: string): { decision_id: string | null } | null {
  const td = meta["test_defect"] as { decision_id?: unknown; certifier?: { shape?: unknown; test_file?: unknown; vessel?: unknown } } | null | undefined;
  const c = td && typeof td === "object" ? td.certifier : undefined;
  if (!c || c.shape !== TEST_DEFECT_CERTIFIER_SHAPE || c.test_file !== testFile) return null;
  if (typeof c.vessel === "string" && c.vessel !== vessel.replace(/^repos\//, "")) return null;
  return { decision_id: typeof td!.decision_id === "string" ? td!.decision_id : null };
}

/** The row a gap id names: a "<gap>-compose" id, derived from a "<gap>-compose-report.json" proposal name
 *  (apply-proposal-as-patch), names <gap>. */
export function rowIdOf(gapId: string): string {
  return gapId.trim().replace(/-compose$/, "");
}
/** What a single-file write may do to a test file: admitted only where its row was localized to exactly that file (the
 *  row's test_defect certifier names it and its edit_site allows it); refused with the cited reason otherwise, a missing
 *  row included. A target that is not a test file is not this check's. Pure: the caller reads the row. */
export type TestFileWriteVerdict = { verdict: "admitted" | "refused" | "not_applicable"; reason: string; gap_id: string | null; localization_record_id: string };
export function testFileWriteVerdict(vessel: string, subPath: string, rowMeta: Record<string, unknown> | null, gapId: string | null): TestFileWriteVerdict {
  const out = (verdict: TestFileWriteVerdict["verdict"], reason: string, record = "none"): TestFileWriteVerdict => ({ verdict, reason, gap_id: gapId, localization_record_id: record });
  if (strayTestEdits(vessel, [subPath], {}).length === 0) return out("not_applicable", `${subPath} is not a test file`);
  if (!rowMeta) return out("refused", `test-file target ${subPath}: no localization row${gapId ? ` (${gapId} not found)` : " (no gap_id)"}`);
  const decision = (rowMeta["test_defect"] as { decision_id?: unknown } | null | undefined)?.decision_id;
  const record = typeof decision === "string" && decision ? decision : "none";
  if (!testDefectRecordFor(rowMeta, subPath, vessel)) return out("refused", `test-file target ${subPath}: row ${gapId}'s test_defect certifier does not name it`, record);
  if (strayTestEdits(vessel, [subPath], rowMeta).length > 0) return out("refused", `test-file target ${subPath}: row ${gapId}'s edit_site does not allow it`, record);
  return out("admitted", `test-file target ${subPath} is row ${gapId}'s localized test file`, record);
}
