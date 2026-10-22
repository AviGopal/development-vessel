// THE GAP STORE'S READ PATH SHARES ONE PARSE PER VERSION OF THE FILE (CHANGE-30c).
//
// Every lock-free read (resolveSubstrateGap) used to readFile + JSON.parse the WHOLE store. On the holder that is
// 21.6 MB / 8,718 rows: ~140 ms and a ~100 MB transient tree per read, at >= 0.4 reads/s from the drain observer
// alone plus every forwarded spoke read. The holder's event loop stalled 15-18 s at a time, and the spokes' 15 s
// forwarded reads timed out and failed their gates closed. The read path now keeps one parsed snapshot keyed on the
// file's identity (ino + size + mtimeMs + ctimeMs + this process's write generation), re-stat'd on every read.
//
//   MUST-FAIL: two reads of an unchanged store parse it ONCE (today: twice).
//   MUST-FAIL: five CONCURRENT reads on a cold snapshot share ONE parse (today: five).
//   CONTROL:   a write landing while a parse is in flight is seen by the next read after it settles.
//   CONTROL:   an in-process write between two reads is seen by the second read.
//   CONTROL:   an out-of-process rename-replace of gaps.json is seen on the next read.
//   CONTROL:   an out-of-process IN-PLACE overwrite of the same size, inside the same second, is seen (ctime / mtime).
//   CONTROL:   rapid successive in-process writes (same second) are each seen by the next read.
//   CONTROL:   mutating a row a read handed out does not change the next read's row.
//
// COARSE TIMESTAMPS (2026-10-22). Without multigrain timestamps, mtime and ctime are one jiffy coarse, so another
// process's same-size IN-PLACE overwrite inside one tick leaves every identity field equal. The stat the cache keys on
// is stubbed to repeat the first-observed mtime / ctime, which is that filesystem:
//   MUST-FAIL: an out-of-process same-size in-place overwrite (a child process, same inode) is seen on the next read
//              (at the identity-only snapshot: the stale AAAA).
//   CONTROL:   under the same stub, an unchanged store is parsed ONCE across reads.
// Each case snapshots the store's bytes and restores them, and restores the real stat, whatever it asserts.
//
// Driven through the REAL gap store under a temp WORKSPACE_ROOT. Nothing reads or writes /workspace.
import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = mkdtempSync(join(tmpdir(), "gap-read-snapshot-"));
const saved = { ws: process.env["WORKSPACE_ROOT"], calib: process.env["EXPECTATION_CALIB_PATH"], oracle: process.env["CLOSE_ORACLE_CALIB_PATH"], trig: process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"], ep: process.env["GAP_STORE_ENDPOINT"] };
process.env["WORKSPACE_ROOT"] = join(ROOT, "ws");
isolateLearnedStateInProcess(process.env["WORKSPACE_ROOT"]!); // learned state (posteriors, calibration, credit) under the temp root too, never /workspace
mkdirSync(process.env["WORKSPACE_ROOT"], { recursive: true });
process.env["EXPECTATION_CALIB_PATH"] = join(ROOT, "expectation-calibration.json");
process.env["CLOSE_ORACLE_CALIB_PATH"] = join(ROOT, "close-oracle-calibration.json");
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
delete process.env["GAP_STORE_ENDPOINT"];

const sg = (await import("../../src/resolvers/substrate-gap.js")) as Record<string, any>;
// The store root is frozen when substrate-gap.js first loads; in a one-process suite run another file may have loaded
// it first. Write fixtures only into a scratch (temp) store, and never drop another suite's rows.
const STORE_ROOT: string = sg.gapStoreRootForTest();
const STORE_FILE = join(STORE_ROOT, "gaps", "gaps.json");
const RUN = Math.random().toString(36).slice(2, 8);
let n = 0;
const nextId = (): string => `gap-read-snapshot-${RUN}-${++n}`;

afterAll(() => {
  for (const [k, v] of [["WORKSPACE_ROOT", saved.ws], ["EXPECTATION_CALIB_PATH", saved.calib], ["CLOSE_ORACLE_CALIB_PATH", saved.oracle], ["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", saved.trig], ["GAP_STORE_ENDPOINT", saved.ep]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(ROOT, { recursive: true, force: true });
});

function assertScratch(): void {
  if (!sg.isScratchGapStoreRoot(STORE_ROOT)) throw new Error(`gap store root ${STORE_ROOT} is not a scratch root; refusing to write fixtures`);
}
function storedRows(): Array<Record<string, unknown>> {
  try { return JSON.parse(readFileSync(STORE_FILE, "utf8")) as Array<Record<string, unknown>>; } catch { return []; }
}
const row = (id: string, summary: string): Record<string, unknown> => ({
  id, category: "systematic_failure", source: "test", status: "open", summary, detected_at: "2026-10-16T06:00:00Z",
});
/** Another PROCESS's writer: tmp + rename (a new inode), keeping every row already there. */
function externalRenameWrite(rows: Array<Record<string, unknown>>): void {
  assertScratch();
  mkdirSync(join(STORE_ROOT, "gaps"), { recursive: true });
  const tmp = `${STORE_FILE}.ext.${RUN}.tmp`;
  writeFileSync(tmp, JSON.stringify(rows, null, 2));
  renameSync(tmp, STORE_FILE);
}
/** Another process writing IN PLACE (same inode). */
function externalInPlaceWrite(rows: Array<Record<string, unknown>>): void {
  assertScratch();
  writeFileSync(STORE_FILE, JSON.stringify(rows, null, 2));
}
async function readOne(id: string): Promise<Record<string, any> | null> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 });
  expect(r.shape).toBe("substrateGap");
  return ((r.body.gaps ?? []) as Array<Record<string, any>>)[0] ?? null;
}
async function writeGap(g: Record<string, unknown>): Promise<void> {
  assertScratch();
  const r = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: g } as never);
  expect(r.shape).not.toBe("structuredError");
}

beforeEach(() => {
  assertScratch();
  sg.__resetGapReadSnapshotForTests?.();
});

describe("the gap store's read path parses each version of the file once", () => {
  it("[MUST-FAIL] two reads of an unchanged store parse it once", async () => {
    const id = nextId();
    externalRenameWrite([...storedRows(), row(id, "unchanged store")]);
    sg.__resetGapReadSnapshotForTests();
    expect((await readOne(id))?.summary).toBe("unchanged store");
    expect((await readOne(id))?.summary).toBe("unchanged store");
    expect(sg.__gapReadParsesForTests()).toBe(1);
  });

  it("[MUST-FAIL] concurrent reads on a cold snapshot share ONE parse", async () => {
    const id = nextId();
    externalRenameWrite([...storedRows(), row(id, "cold store")]);
    sg.__resetGapReadSnapshotForTests();
    const got = await Promise.all(Array.from({ length: 5 }, () => readOne(id)));
    for (const g of got) expect(g?.summary).toBe("cold store");
    expect(sg.__gapReadParsesForTests()).toBe(1);
  });

  it("[CONTROL] a write landing while a parse is in flight is seen by the next read after it settles", async () => {
    const id = nextId();
    externalRenameWrite([...storedRows(), row(id, "before the in-flight write")]);
    sg.__resetGapReadSnapshotForTests?.(); // optional: this control must also hold on a tree without the snapshot
    const inflight = Promise.all(Array.from({ length: 3 }, () => readOne(id)));
    externalRenameWrite(storedRows().map((r) => (r["id"] === id ? { ...r, summary: "written during the parse" } : r)));
    await inflight;
    expect((await readOne(id))?.summary).toBe("written during the parse");
  });

  it("[CONTROL] an in-process write between two reads is seen by the second read", async () => {
    const id = nextId();
    await writeGap(row(id, "first version"));
    expect((await readOne(id))?.summary).toBe("first version");
    await writeGap(row(id, "second version, written in this process"));
    expect((await readOne(id))?.summary).toBe("second version, written in this process");
  });

  it("[CONTROL] an out-of-process rename-replace of gaps.json is seen on the next read", async () => {
    const id = nextId();
    externalRenameWrite([...storedRows(), row(id, "before the rename")]);
    expect((await readOne(id))?.summary).toBe("before the rename");
    externalRenameWrite(storedRows().map((r) => (r["id"] === id ? { ...r, summary: "after the rename" } : r)));
    expect((await readOne(id))?.summary).toBe("after the rename");
  });

  it("[CONTROL] an out-of-process in-place overwrite of the SAME size inside the same second is seen", async () => {
    const id = nextId();
    externalRenameWrite([...storedRows(), row(id, "AAAA")]);
    expect((await readOne(id))?.summary).toBe("AAAA");
    const before = readFileSync(STORE_FILE, "utf8").length;
    externalInPlaceWrite(storedRows().map((r) => (r["id"] === id ? { ...r, summary: "BBBB" } : r)));
    expect(readFileSync(STORE_FILE, "utf8").length).toBe(before);
    expect((await readOne(id))?.summary).toBe("BBBB");
  });

  it("[CONTROL] rapid successive in-process writes (same second) are each seen by the next read", async () => {
    // The real writer renames a tmp into place (a new inode) and stamps fields, so an in-process write can never
    // reproduce the old identity; the write generation is the belt for a filesystem that reuses inodes. What must
    // hold is behavioural: every write is visible to the very next read, however close together they land.
    const id = nextId();
    for (const v of ["CCCC", "DDDD", "EEEE", "FFFF"]) {
      await writeGap(row(id, v));
      expect((await readOne(id))?.summary).toBe(v);
    }
  });

  it("[CONTROL] mutating a row a read handed out does not change the next read's row", async () => {
    const id = nextId();
    externalRenameWrite([...storedRows(), row(id, "pristine")]);
    const a = await readOne(id);
    a!["summary"] = "mutated by a caller";
    (a!["classification_metadata"] ??= {})["poison"] = true;
    const b = await readOne(id);
    expect(b?.summary).toBe("pristine");
    expect(b?.["classification_metadata"]?.["poison"]).toBeUndefined();
  });
});

/** A filesystem without multigrain timestamps: every stat of the store reports the mtime / ctime it first reported,
 *  as two writes inside one timestamp tick do. Every other path, and every other field (ino, size), is the real one. */
function coarseStoreTimestamps(): { restore: () => void } {
  const realStat = fsp.stat;
  let pinned: { mtimeMs: number; ctimeMs: number; mtime: Date; ctime: Date } | null = null;
  const spy = spyOn(fsp, "stat").mockImplementation((async (p: Parameters<typeof fsp.stat>[0], opts?: Parameters<typeof fsp.stat>[1]) => {
    const st = await realStat(p, opts as never);
    if (String(p) !== STORE_FILE) return st;
    pinned ??= { mtimeMs: Number(st.mtimeMs), ctimeMs: Number(st.ctimeMs), mtime: st.mtime, ctime: st.ctime };
    return Object.assign(st, pinned);
  }) as unknown as typeof fsp.stat);
  return { restore: () => spy.mockRestore() };
}
/** Run `fn` with the store's bytes snapshotted, and restore them (or its absence) and the real stat afterwards. */
async function withRestoredStore(fn: (clock: { restore: () => void }) => Promise<void>): Promise<void> {
  assertScratch();
  const saved = existsSync(STORE_FILE) ? readFileSync(STORE_FILE) : null;
  const clock = coarseStoreTimestamps();
  try {
    await fn(clock);
  } finally {
    clock.restore();
    if (saved === null) rmSync(STORE_FILE, { force: true }); else externalRenameWriteBytes(saved);
    sg.__resetGapReadSnapshotForTests?.();
  }
}
function externalRenameWriteBytes(bytes: Buffer): void {
  assertScratch();
  const tmp = `${STORE_FILE}.restore.${RUN}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, STORE_FILE);
}
/** ANOTHER PROCESS overwrites the store IN PLACE: a child `cat > file` truncates and rewrites the same inode. */
function childInPlaceWrite(rows: Array<Record<string, unknown>>): void {
  assertScratch();
  const r = Bun.spawnSync(["sh", "-c", 'cat > "$0"', STORE_FILE], { stdin: Buffer.from(JSON.stringify(rows, null, 2)), stdout: "ignore", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`child in-place write failed: ${r.stderr.toString()}`);
}
/** The target row sits between two big fillers, so the change is far from both ends of the file. */
const padded = (id: string, summary: string): Array<Record<string, unknown>> => [
  row(`${id}-head`, "h".repeat(16_384)), row(id, summary), row(`${id}-tail`, "t".repeat(16_384)),
];

describe("the gap store's read snapshot under coarse (non-multigrain) timestamps", () => {
  it("[MUST-FAIL] an out-of-process same-size in-place overwrite inside one tick is seen on the next read", async () => {
    await withRestoredStore(async () => {
      const id = nextId();
      externalRenameWrite([...padded(id, "AAAA"), ...storedRows()]);
      sg.__resetGapReadSnapshotForTests();
      expect((await readOne(id))?.summary).toBe("AAAA");
      const real = statSync(STORE_FILE);
      const seen = await fsp.stat(STORE_FILE);
      childInPlaceWrite(storedRows().map((r) => (r["id"] === id ? { ...r, summary: "BBBB" } : r)));
      const realAfter = statSync(STORE_FILE);
      const seenAfter = await fsp.stat(STORE_FILE);
      // The case is the one the identity cannot see: same inode, same size, same (coarse) mtime and ctime.
      expect(realAfter.ino).toBe(real.ino);
      expect(realAfter.size).toBe(real.size);
      expect([seenAfter.mtimeMs, seenAfter.ctimeMs]).toEqual([seen.mtimeMs, seen.ctimeMs]);
      expect((await readOne(id))?.summary).toBe("BBBB");
      expect((await readOne(id))?.summary).toBe("BBBB");
      expect(sg.__gapReadParsesForTests()).toBe(2); // one parse per version, not one per read
    });
  });

  it("[CONTROL] under the same coarse timestamps, an unchanged store is parsed once", async () => {
    await withRestoredStore(async () => {
      const id = nextId();
      externalRenameWrite([...padded(id, "unchanged under coarse timestamps"), ...storedRows()]);
      sg.__resetGapReadSnapshotForTests();
      for (let i = 0; i < 3; i++) expect((await readOne(id))?.summary).toBe("unchanged under coarse timestamps");
      const got = await Promise.all(Array.from({ length: 4 }, () => readOne(id)));
      for (const g of got) expect(g?.summary).toBe("unchanged under coarse timestamps");
      expect(sg.__gapReadParsesForTests()).toBe(1);
    });
  });
});
