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
