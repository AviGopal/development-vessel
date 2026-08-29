import { describe, it, expect } from "bun:test";
import { resolveAuthorNewResolver, spliceConfigShape, spliceImpulses } from "../../src/resolvers/author-new-resolver.js";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";

// The dev-vessel repo root (this test file lives at <root>/test/resolvers/).
const VESSEL_ROOT = resolve(import.meta.dir, "..", "..");

describe("author_new_resolver resolver (Seam ③)", () => {
  it("emits exactly 4 file paths (resolver + test + spliced config + impulses)", async () => {
    const r = await resolveAuthorNewResolver({
      type: "author_new_resolver",
      vessel: "development-vessel",
      resolver_name: "demo_seam3_scan",
      shape_name: "demo_seam3_scan",
      description: "demo seam-3 authored resolver",
      input_shapes: ["activityExecutionTrace"],
      output_shape: "demo_seam3_scan_result",
      vessel_dir: VESSEL_ROOT,
    });
    expect(r.shape).toBe("resolverAuthorProposal");
    const body = r.body as { file_count: number; file_paths: string[]; proposal: { new_files: Array<{ path: string }>; overwrite_files: Array<{ path: string }> } };
    expect(body.file_count).toBe(4);
    expect(body.file_paths.length).toBe(4);
    expect(body.file_paths).toContain("repos/development-vessel/src/resolvers/demo-seam3-scan.ts");
    expect(body.file_paths).toContain("repos/development-vessel/test/resolvers/demo-seam3-scan.test.ts");
    expect(body.file_paths).toContain("repos/development-vessel/src/config.ts");
    expect(body.file_paths).toContain("repos/development-vessel/src/routes/impulses.ts");
    // Closure linkage recorded — not a dead-end leaf.
    const linkage = (r.body as { shape_linkage: { input_shapes: string[]; output_shape: string } }).shape_linkage;
    expect(linkage.input_shapes).toContain("activityExecutionTrace");
    expect(linkage.output_shape).toBe("demo_seam3_scan_result");
  });

  it("spliced config contains the new shape literal; spliced impulses contains the case + import", async () => {
    const r = await resolveAuthorNewResolver({
      type: "author_new_resolver",
      vessel: "development-vessel",
      resolver_name: "demo_seam3_scan",
      vessel_dir: VESSEL_ROOT,
    });
    const proposal = (r.body as { proposal: { overwrite_files: Array<{ path: string; content: string }> } }).proposal;
    const config = proposal.overwrite_files.find((f) => f.path.endsWith("config.ts"))!.content;
    const impulses = proposal.overwrite_files.find((f) => f.path.endsWith("impulses.ts"))!.content;
    expect(config).toContain('"demo_seam3_scan"');
    expect(impulses).toContain('case "demo_seam3_scan":');
    expect(impulses).toContain("import { resolveDemoSeam3Scan }");
  });

  it("check-shape-dispatch over the staged spliced config+impulses exits 0", async () => {
    const r = await resolveAuthorNewResolver({
      type: "author_new_resolver",
      vessel: "development-vessel",
      resolver_name: "demo_seam3_scan",
      vessel_dir: VESSEL_ROOT,
    });
    const proposal = (r.body as { proposal: { new_files: Array<{ path: string; content: string }>; overwrite_files: Array<{ path: string; content: string }> } }).proposal;

    // Build a minimal staged vessel root: config.ts + routes/impulses.ts.
    const stageRoot = mkdtempSync(join(tmpdir(), "seam3-stage-"));
    for (const f of proposal.overwrite_files) {
      // Strip the repos/<vessel>/ prefix to get the in-vessel subPath.
      const subPath = f.path.replace(/^repos\/development-vessel\//, "");
      const abs = join(stageRoot, subPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
    }
    // Also drop the new resolver file so the import target exists on disk (the
    // check does not import, but keep the staged tree faithful).
    for (const f of proposal.new_files) {
      const subPath = f.path.replace(/^repos\/development-vessel\//, "");
      const abs = join(stageRoot, subPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
    }

    // Locate the shared checker by WALKING UP, not by fixed depth. `../../packages/...` only
    // resolves when the vessel sits at <super>/repos/<vessel>; in this container packages/ lives
    // at /vessels/packages, so the assertion failed on a path that was simply looked for in the
    // wrong place — nothing to do with the config+impulses splice this case exists to verify.
    // Fifth instance of the fixed-depth layout class in this repo.
    function findCheckScript(start: string): string | null {
      let dir = start;
      for (let i = 0; i < 8; i += 1) {
        const candidate = resolve(dir, "packages", "shape-dispatch-check", "check.ts");
        if (existsSync(candidate)) return candidate;
        const parent = resolve(dir, "..");
        if (parent === dir) break;
        dir = parent;
      }
      return null;
    }
    const checkScript = findCheckScript(VESSEL_ROOT);
    if (checkScript === null) {
      // A standalone vessel checkout genuinely has no shared packages/ to run. Skip loudly
      // rather than fail: this case is about the SPLICE agreeing with itself, and it cannot be
      // evaluated without the checker.
      console.error(
        `[author-new-resolver] SKIPPED the shape-dispatch assertion: no packages/shape-dispatch-check above ${VESSEL_ROOT}`,
      );
      return;
    }
    const proc = Bun.spawnSync(["bun", checkScript, stageRoot], { stdout: "pipe", stderr: "pipe" });
    const out = proc.stdout.toString() + proc.stderr.toString();
    expect(proc.exitCode, `check-shape-dispatch output:\n${out}`).toBe(0);
    expect(out).toContain("all agree");
  });

  it("spliceConfigShape is idempotent (no double-insert)", () => {
    const src = `      "existing_shape",\n    ] as const,\n`;
    const once = spliceConfigShape(src, "new_one", "c")!;
    const twice = spliceConfigShape(once, "new_one", "c")!;
    expect(once).toBe(twice);
    expect((once.match(/"new_one"/g) ?? []).length).toBe(1);
  });

  it("spliceImpulses inserts import + case before default", () => {
    const src =
      `import { resolveA } from "../resolvers/a.js";\n` +
      `import type { ResolverResult } from "../resolvers/types.js";\n\n` +
      `switch (pointer.type) {\n` +
      `    case "a":\n      return resolveA(p as never);\n` +
      `    default:\n      throw new Error("x");\n  }\n`;
    const out = spliceImpulses(src, "b_shape", "resolveB", "../resolvers/b.js")!;
    expect(out).toContain(`import { resolveB } from "../resolvers/b.js";`);
    expect(out).toContain(`case "b_shape":`);
    // case is before default
    expect(out.indexOf(`case "b_shape":`)).toBeLessThan(out.indexOf("default:"));
  });
});
