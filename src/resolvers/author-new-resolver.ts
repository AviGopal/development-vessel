/**
 * author_new_resolver — Seam ③ (net-new resolver authoring, 2026-06-19).
 *
 * The substrate's self-alteration pipeline could SURGICALLY edit existing
 * vessel source (patch_with_tools) and write full-content NEW files
 * (apply_proposal_as_patch new_files[]), but it could not author a NET-NEW
 * RESOLVER end-to-end — a resolver is not one file, it is the THREE-PLACE rule:
 *   1. src/resolvers/<name>.ts          (the implementation — NEW file)
 *   2. src/config.ts                    (add shape to discovery.shapes — EDIT)
 *   3. src/routes/impulses.ts           (add import + dispatch case — EDIT)
 * plus a per-resolver test (test/resolvers/<name>.test.ts — NEW file).
 *
 * This resolver does NOT write live source. It EMITS an apply-able proposal
 * object (shape `resolverAuthorProposal`) that the existing
 * apply_proposal_as_patch → vessel_mitosis_cutover machinery stages and gates:
 *   - new_files[]:       the resolver impl + its test (genuinely new)
 *   - overwrite_files[]: the SPLICED config.ts + impulses.ts (existing files,
 *                        read live and spliced here so the FAVORABLE gate — tsc
 *                        + check-shape-dispatch + bun test — verifies the whole
 *                        four-file staged tree before cutover).
 *
 * Determinism: the splice is mechanical (insert before the array/​switch
 * terminator, insert import after the last import). There is nothing for an LLM
 * to hallucinate. impl_body is the only free-form input; when omitted a minimal
 * compiling stub is generated.
 *
 * Closure constraint (spectral-gap governor): a resolver that emits a pure
 * dead-end leaf shape adds no topology. The pointer records the intended
 * input/output shape linkage (input_shapes / output_shape) on the proposal so
 * the scaffolded resolver connects to existing topology rather than dangling.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";

export interface AuthorNewResolverPointer {
  type: "author_new_resolver";
  /** Vessel whose three-place wiring is extended, e.g. "development-vessel". */
  vessel: string;
  /** New resolver/shape name, e.g. "trace_health_scan" (snake_case shape id). */
  resolver_name: string;
  /** The advertised shape name. Defaults to resolver_name when omitted. */
  shape_name?: string;
  /** Optional resolver body (the inside of resolve<Name>). A compiling stub is
   *  generated when omitted. */
  impl_body?: string;
  /** Human-readable description woven into the config.ts shape comment. */
  description?: string;
  /** Closure: shapes this resolver CONSUMES (recorded on the proposal so the
   *  scaffold connects to existing topology, not a dead-end leaf). */
  input_shapes?: string[];
  /** Closure: the shape this resolver PRODUCES (its output linkage). */
  output_shape?: string;
  /** Where the live vessel trees live (container path). Defaults to /vessels. */
  vessels_root?: string;
  /** Read live source from here instead of vessels_root/<vessel> (tests). */
  vessel_dir?: string;
  /** Emit-only: do not throw if the live files cannot be read. */
}

function structuredError(detail: string, extra?: Record<string, unknown>): ResolverResult {
  return { shape: "structuredError", body: { resolver: "author_new_resolver", detail, ...(extra ?? {}) } };
}

/** snake_case -> PascalCase (trace_health_scan -> TraceHealthScan). */
function pascal(name: string): string {
  return name.split(/[_-]/).filter(Boolean).map((s) => s[0]!.toUpperCase() + s.slice(1)).join("");
}

/**
 * Splice a new shape literal into config.ts `discovery.shapes`. Idempotent:
 * if the shape is already present, returns the source unchanged. The terminator
 * is the literal `    ] as const,` line that closes the shapes array.
 */
export function spliceConfigShape(src: string, shape: string, comment: string): string | null {
  if (new RegExp(`["']${shape}["']`).test(src)) return src; // already present
  const terminator = "\n    ] as const,";
  const idx = src.indexOf(terminator);
  if (idx < 0) return null;
  const insertion = `\n      // ${comment}\n      "${shape}",`;
  return src.slice(0, idx) + insertion + src.slice(idx);
}

/**
 * Splice the import + dispatch case into impulses.ts. Idempotent on the case.
 * The import goes after the last `import ... from "../resolvers/...";` line;
 * the case goes immediately before `    default:` in the switch.
 */
export function spliceImpulses(src: string, shape: string, resolverFn: string, importPath: string): string | null {
  let out = src;
  // 1. Import — after the last resolver import line.
  if (!out.includes(`import { ${resolverFn} }`)) {
    const importLine = `import { ${resolverFn} } from "${importPath}";`;
    const importRe = /import \{[^}]*\} from "\.\.\/resolvers\/[^"]+\.js";\n/g;
    let lastImportEnd = -1;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(out)) !== null) lastImportEnd = m.index + m[0].length;
    if (lastImportEnd < 0) return null;
    out = out.slice(0, lastImportEnd) + importLine + "\n" + out.slice(lastImportEnd);
  }
  // 2. Dispatch case — before `default:` in the switch. Idempotent.
  if (!new RegExp(`case ["']${shape}["']:`).test(out)) {
    const defaultRe = /\n(\s*)default:/;
    const dm = defaultRe.exec(out);
    if (!dm) return null;
    const indent = dm[1] ?? "    ";
    const caseBlock =
      `\n${indent}case "${shape}":\n` +
      `${indent}  return ${resolverFn}(p as Parameters<typeof ${resolverFn}>[0]);`;
    out = out.slice(0, dm.index) + caseBlock + out.slice(dm.index);
  }
  return out;
}

function resolverFileContent(p: AuthorNewResolverPointer): string {
  const Name = pascal(p.resolver_name);
  const fn = `resolve${Name}`;
  const PointerT = `${Name}Pointer`;
  const outShape = p.output_shape ?? `${p.resolver_name}_result`;
  const inputShapesDoc = (p.input_shapes ?? []).length
    ? ` * Input shapes (closure linkage): ${(p.input_shapes ?? []).join(", ")}\n`
    : "";
  const body = p.impl_body && p.impl_body.trim().length
    ? p.impl_body
    : `  // TODO: implement. Stub returns an empty, well-formed result.\n` +
      `  return { shape: ${JSON.stringify(outShape)}, body: { authored: true, pointer_type: pointer.type } };`;
  return (
    `/**\n` +
    ` * ${p.resolver_name} — ${p.description ?? "substrate-authored resolver (Seam ③)"}.\n` +
    inputShapesDoc +
    ` * Output shape: ${outShape}\n` +
    ` */\n\n` +
    `import type { ResolverResult } from "./types.js";\n\n` +
    `export interface ${PointerT} {\n` +
    `  type: "${p.resolver_name}";\n` +
    `  [key: string]: unknown;\n` +
    `}\n\n` +
    `export async function ${fn}(pointer: ${PointerT}): Promise<ResolverResult> {\n` +
    `${body}\n` +
    `}\n`
  );
}

function testFileContent(p: AuthorNewResolverPointer): string {
  const Name = pascal(p.resolver_name);
  const fn = `resolve${Name}`;
  const outShape = p.output_shape ?? `${p.resolver_name}_result`;
  return (
    `import { describe, it, expect } from "bun:test";\n` +
    `import { ${fn} } from "../../src/resolvers/${p.resolver_name.replace(/_/g, "-")}.js";\n\n` +
    `describe("${p.resolver_name} resolver", () => {\n` +
    `  it("returns a well-formed result for the ${outShape} shape", async () => {\n` +
    `    const r = await ${fn}({ type: "${p.resolver_name}" });\n` +
    `    expect(typeof r.shape).toBe("string");\n` +
    `    expect(r).toHaveProperty("body");\n` +
    `  });\n` +
    `});\n`
  );
}

export async function resolveAuthorNewResolver(pointer: AuthorNewResolverPointer): Promise<ResolverResult> {
  if (!pointer.vessel || !pointer.resolver_name) {
    return structuredError("vessel and resolver_name are required");
  }
  if (!/^[a-z][a-z0-9_]*$/.test(pointer.resolver_name)) {
    return structuredError(`resolver_name must be snake_case: ${pointer.resolver_name}`);
  }
  const shape = pointer.shape_name ?? pointer.resolver_name;
  const Name = pascal(pointer.resolver_name);
  const fn = `resolve${Name}`;
  const kebab = pointer.resolver_name.replace(/_/g, "-");

  const vesselsRoot = pointer.vessels_root ?? "/vessels";
  const vesselDir = pointer.vessel_dir ?? join(vesselsRoot, pointer.vessel);
  const configPath = join(vesselDir, "src", "config.ts");
  const impulsesPath = join(vesselDir, "src", "routes", "impulses.ts");

  let configSrc: string;
  let impulsesSrc: string;
  try {
    configSrc = await readFile(configPath, "utf-8");
    impulsesSrc = await readFile(impulsesPath, "utf-8");
  } catch (err) {
    return structuredError(`cannot read live wiring files: ${(err as Error).message}`, { config_path: configPath, impulses_path: impulsesPath });
  }

  const splicedConfig = spliceConfigShape(
    configSrc,
    shape,
    `Seam ③ substrate-authored resolver (${new Date().toISOString().slice(0, 10)}): ${pointer.description ?? pointer.resolver_name}`,
  );
  if (splicedConfig === null) {
    return structuredError("could not locate discovery.shapes array terminator in config.ts");
  }
  const splicedImpulses = spliceImpulses(impulsesSrc, shape, fn, `../resolvers/${kebab}.js`);
  if (splicedImpulses === null) {
    return structuredError("could not splice import/case into impulses.ts");
  }

  const repoRoot = `repos/${pointer.vessel}`;
  const proposal = {
    kind: "patch_proposal",
    authored_by: "author_new_resolver",
    summary: `Author net-new resolver ${pointer.resolver_name} (shape ${shape}) in ${pointer.vessel}`,
    // Closure linkage recorded so this is not a dead-end leaf shape.
    shape_linkage: {
      shape,
      input_shapes: pointer.input_shapes ?? [],
      output_shape: pointer.output_shape ?? `${pointer.resolver_name}_result`,
    },
    new_files: [
      { path: `${repoRoot}/src/resolvers/${kebab}.ts`, content: resolverFileContent(pointer) },
      { path: `${repoRoot}/test/resolvers/${kebab}.test.ts`, content: testFileContent(pointer) },
    ],
    overwrite_files: [
      { path: `${repoRoot}/src/config.ts`, content: splicedConfig },
      { path: `${repoRoot}/src/routes/impulses.ts`, content: splicedImpulses },
    ],
  };

  let persisted_to: string | null = null;
  if ((pointer as { persist?: boolean }).persist !== false) {
    try {
      const dir = join(process.env["WORKSPACE_ROOT"] ?? "/workspace", "proposals");
      await mkdir(dir, { recursive: true });
      persisted_to = join(dir, `${kebab}-authoring-report.json`);
      await writeFile(persisted_to, JSON.stringify(proposal, null, 1));
    } catch { persisted_to = null; }
  }
  return {
    shape: "resolverAuthorProposal",
    body: {
      persisted_to,
      vessel: pointer.vessel,
      resolver_name: pointer.resolver_name,
      shape,
      file_count: 4,
      file_paths: [
        ...proposal.new_files.map((f) => f.path),
        ...proposal.overwrite_files.map((f) => f.path),
      ],
      shape_linkage: proposal.shape_linkage,
      proposal,
    },
  };
}
