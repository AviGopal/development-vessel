// THE CUTOVER GUARDS DO NOT LEAK INTO THE NEXT FILE (probe).
//
// The cutover suites install a filesystem guard through bun's mock.module (node:fs,
// node:fs/promises) plus a Bun.write patch, and a fetch guard on globalThis.fetch. bun runs every
// test file of one `bun test` invocation in ONE process, and mock.restore() does not undo
// mock.module, so a guard that is not explicitly restored stays installed for every later file:
// that file's legitimate writes outside os.tmpdir() would then be blocked (EACCES) by a guard it
// never asked for, and its fetches would hit a dead route table.
//
// This probe writes OUTSIDE os.tmpdir() — to a directory it owns, next to this file, which it
// creates and removes itself (never /workspace) — through every API the guard wraps, and checks
// that fetch is the native one. Run it in the same process AFTER a guard file:
//   bun test ./test/resolvers/vessel-mitosis-cutover.test.ts ./test/resolvers/cutover-guard-leak-probe.test.ts
// The "./" matters. On bun 1.3.14, a bare `test/…` argument is a name FILTER, and bun picks its
// own file order: measured here, the probe ran last whatever the argument order. A "./"-prefixed
// argument is an exact path, and bun runs those in argument order. Green only if the guards were
// restored.
import { describe, it, expect } from "bun:test";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("cutover guard leak probe", () => {
  it("after a cutover guard file in the same process, writes outside os.tmpdir() succeed and fetch is native", async () => {
    const dir = join(import.meta.dir, `.guard-leak-probe-${process.pid}`);
    // Precondition: this probe only means something when its scratch path is outside the guard's allowed root.
    expect(resolve(dir).startsWith(resolve(tmpdir()) + "/")).toBe(false);
    const errors: string[] = [];
    try {
      try { await mkdir(dir, { recursive: true }); } catch (e) { errors.push(`mkdir: ${String(e)}`); }
      try { await writeFile(join(dir, "a.txt"), "a"); } catch (e) { errors.push(`writeFile: ${String(e)}`); }
      try { writeFileSync(join(dir, "b.txt"), "b"); } catch (e) { errors.push(`writeFileSync: ${String(e)}`); }
      try { await Bun.write(join(dir, "c.txt"), "c"); } catch (e) { errors.push(`Bun.write: ${String(e)}`); }
      expect(errors).toEqual([]);
      expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("a");
      expect(await readFile(join(dir, "c.txt"), "utf8")).toBe("c");
      expect(String(globalThis.fetch)).toContain("[native code]");
    } finally {
      // Removal goes through whatever fs is installed; if a leaked guard blocks it, fall back to the
      // real module via a fresh child process so the probe never leaves its directory behind.
      try { await rm(dir, { recursive: true, force: true }); } catch { /* fall through */ }
      if (existsSync(dir)) Bun.spawnSync(["rm", "-rf", "--", dir]);
    }
    expect(existsSync(dir)).toBe(false);
  });
});
