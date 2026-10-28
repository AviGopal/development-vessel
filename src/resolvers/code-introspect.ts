import { resolve, relative } from "path";
import type { ResolverResult } from "./types.js";
import { assertInAnyWorkspace } from "./workspace-roots.js";
import { exportContract, exportGuardUnavailable, srcReaderAt, type ExportContractEntry, type SrcReader } from "./check-supply-admission.js";

export interface CodeIntrospectPointer {
  type: "code_introspect";
  path: string;
  pattern?: string;
  maxMatches?: number;
  /** Opt-in: also return `contract`, what the module exports and how each function is called (codeContract). */
  include_contract?: boolean;
}

/**
 * THE MODULE'S CONTRACT (codeIntrospectResult.body.contract, opt-in with include_contract): each export's name and kind,
 * and for a function its parameters (name, type text, optional, default), its declared return type, its signature text
 * and, where the return walk reads them, its returned value kinds / `shape` strings / `body` keys. Read in-process by the
 * readers the check-supply guards use (check-supply-admission.ts exportContract: moduleExports, exportSignatures,
 * returnedContract), so a caller is told exactly what the guards will hold a check to. `rel` is the module's path for
 * `reader` (relative re-exports resolve from it). `unavailable` says why there is no contract: the module cannot be read
 * here, or the parser is missing.
 */
export type CodeContract = { exports: ExportContractEntry[]; open: string | null } | { unavailable: string };
export function codeContract(rel: string, reader: SrcReader): CodeContract {
  if (reader.read(rel) === null) return { unavailable: "not readable" };
  return exportContract(rel, reader) ?? { unavailable: exportGuardUnavailable() ?? "not parseable" };
}

function assertInWorkspace(path: string, workspaceRoot: string): void {
  assertInAnyWorkspace(path, workspaceRoot);
}

export async function resolveCodeIntrospect(
  pointer: CodeIntrospectPointer,
  options: { workspaceRoot?: string } = {},
): Promise<ResolverResult> {
  const workspaceRoot = options.workspaceRoot ?? process.env["WORKSPACE_ROOT"] ?? process.cwd();
  assertInWorkspace(pointer.path, workspaceRoot);

  const file = Bun.file(pointer.path);
  if (!(await file.exists())) throw new Error(`file not found: ${pointer.path}`);
  const content = await file.text();

  let matches: Array<{ line: number; column: number; text: string }> = [];
  if (pointer.pattern) {
    const re = new RegExp(pointer.pattern, "gm");
    const maxMatches = pointer.maxMatches ?? 50;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null && matches.length < maxMatches) {
      const lineNum = content.slice(0, m.index).split("\n").length;
      const lineStart = content.lastIndexOf("\n", m.index) + 1;
      const column = m.index - lineStart + 1;
      matches.push({ line: lineNum, column, text: m[0] });
    }
  }

  const lines = content.split("\n");
  return {
    shape: "codeIntrospectResult",
    body: {
      path: pointer.path,
      lineCount: lines.length,
      pattern: pointer.pattern ?? null,
      matches,
      ...(pointer.include_contract === true ? { contract: codeContract(resolve(pointer.path).replace(/^\/+/, ""), srcReaderAt("")) } : {}),
    },
  };
}
