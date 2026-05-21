import { resolve, relative } from "path";
import type { ResolverResult } from "./types.js";

export interface CodeIntrospectPointer {
  type: "code_introspect";
  path: string;
  pattern?: string;
  maxMatches?: number;
}

function assertInWorkspace(path: string, workspaceRoot: string): void {
  const abs = resolve(path);
  const rel = relative(workspaceRoot, abs);
  if (rel.startsWith("..")) {
    throw new Error(`path outside workspace root: ${path}`);
  }
}

export async function resolveCodeIntrospect(pointer: CodeIntrospectPointer): Promise<ResolverResult> {
  const workspaceRoot = process.env["WORKSPACE_ROOT"] ?? process.cwd();
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
    },
  };
}
