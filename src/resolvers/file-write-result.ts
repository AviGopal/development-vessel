import type { ResolverResult } from "./types.js";

/**
 * Writes a word count to disk and reports whether it landed.
 *
 * It previously wrote via `fetch("file://...", { method: "PUT" })` and returned
 * `{ written: true }` whenever `res.ok` was truthy. That request does not write a file, so the
 * resolver reported a successful write while nothing appeared on disk — `existsSync(path)` was
 * false immediately afterwards. A claim of success that nobody checks is worse than a failure:
 * the same class this repo already recorded in mitosis staging as "a write that succeeds is not
 * an edit" (93d7596).
 *
 * Now writes with Bun.write and VERIFIES the file exists before claiming it does, so `written`
 * means what it says.
 */
export async function fileWriteResult(_pointer: unknown): Promise<ResolverResult> {
  const phrase = "the quick brown fox jumps";
  const count = phrase.split(/\s+/).length;
  const path = "/tmp/audit_count.txt";

  try {
    await Bun.write(path, JSON.stringify({ count }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { shape: "fileWriteResult", body: { written: false, path, count, error: msg } };
  }

  // VERIFY, do not assume. The bug being fixed here was precisely a success reported without
  // reading back, so the read-back is the point of the fix and not incidental.
  const landed = await Bun.file(path).exists();
  return {
    shape: "fileWriteResult",
    body: landed
      ? { written: true, path, count }
      : { written: false, path, count, error: "write reported no error but the file is absent" },
  };
}
