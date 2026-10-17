// THE ATTEMPT LEDGER IS READ FROM AN IN-MEMORY INDEX, NOT RE-PARSED WHOLE PER CALL (src/resolvers/attempt-ledger.ts).
// Profiled on node1 2026-10-17: readRecords was 33.4% of dev-vessel CPU (readFileSync of the whole `${kind}.jsonl` and a
// JSON.parse of every line, for every call). Pinned here:
//   (a) EQUIVALENCE: for every query shape the callers use (all, by key, limit, key+limit) the index returns exactly what
//       the whole-file read returns, on a ledger with duplicates, malformed lines, invalid records, blank lines and an
//       unterminated final line; appendRecord's duplicate test is unchanged (a key on ANY parsed line refuses).
//   (b) OTHER WRITERS: another writer's append, an in-place rewrite (larger or same size), a truncation, a rotation and
//       a final line completed later are all seen on the next read: no stale result.
//   (c) BOUND: once read, an unchanged file is not read again, and an append costs a read of the new bytes only, so a
//       read no longer scales with the file's size. MUST-FAIL on the parent (it re-reads and re-parses every call).
// Every case runs in its own temp ATTEMPT_LEDGER_DIR (read at call time); nothing touches /workspace.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ledger from "../../src/resolvers/attempt-ledger.js";

const ROOT = mkdtempSync(join(tmpdir(), "attempt-ledger-index-"));
const saved = process.env["ATTEMPT_LEDGER_DIR"];
let DIR = "";
let n = 0;
beforeEach(() => {
  DIR = join(ROOT, `case-${++n}`);
  mkdirSync(DIR, { recursive: true });
  process.env["ATTEMPT_LEDGER_DIR"] = DIR;
  (ledger as { __resetLedgerIndexForTests?: () => void }).__resetLedgerIndexForTests?.();
});
afterAll(() => {
  if (saved === undefined) delete process.env["ATTEMPT_LEDGER_DIR"]; else process.env["ATTEMPT_LEDGER_DIR"] = saved;
  rmSync(ROOT, { recursive: true, force: true });
});

const file = (kind: string) => join(DIR, `${kind}.jsonl`);
const line = (key: string, kind: string, record: Record<string, unknown>, at = "2026-10-17T00:00:00.000Z") => JSON.stringify({ key, kind, at, record });
const ref = (kind: ledger.LedgerKind, opts?: { key?: string; limit?: number }) =>
  (ledger as unknown as { __readRecordsUncachedForTests?: typeof ledger.readRecords }).__readRecordsUncachedForTests?.(kind, opts) ?? uncached(kind, opts);
// The parent has no reference export: the same whole-file read, written out here, so (a) compares on either tree.
function uncached(kind: string, opts?: { key?: string; limit?: number }): unknown[] {
  let text = "";
  try { text = require("node:fs").readFileSync(file(kind), "utf-8"); } catch { return []; }
  const out: Array<{ key: string }> = [];
  for (const l of text.split("\n")) {
    if (l.trim() === "") continue;
    try {
      const p = JSON.parse(l);
      if (typeof p?.key === "string" && ["attemptIntent", "stateSnapshot", "attemptOutcome", "attemptSettlement", "landingEvent", "attemptRevert"].includes(p.kind) && typeof p.at === "string" && typeof p.record === "object" && p.record !== null && !Array.isArray(p.record)) {
        if (opts?.key && p.key !== opts.key) continue;
        out.push(p);
      }
    } catch { /* malformed */ }
  }
  return opts?.limit && opts.limit > 0 ? out.slice(-opts.limit) : out;
}
const SHAPES: Array<{ key?: string; limit?: number } | undefined> = [undefined, { key: "a1" }, { key: "a2" }, { key: "dup" }, { key: "absent" }, { key: "" }, { limit: 2 }, { limit: 0 }, { key: "dup", limit: 1 }, { limit: 999 }];
const same = (kind: ledger.LedgerKind) => { for (const o of SHAPES) expect(JSON.parse(JSON.stringify(ledger.readRecords(kind, o)))).toEqual(JSON.parse(JSON.stringify(ref(kind, o)))); };

function fixture(kind = "landingEvent"): void {
  writeFileSync(file(kind), [
    line("a1", kind, { attempt_id: "a1", event: "commit", sha: "1".repeat(40), note: "héllo ✓" }),
    "",
    "{not json",
    line("dup", kind, { attempt_id: "d", n: 1 }),
    JSON.stringify({ key: "invalid-only", kind, at: "x", record: [] }), // a key on an invalid record
    line("a2", kind, { attempt_id: "a2", event: "rewrite" }),
    JSON.stringify({ key: "wrongkind", kind: "nope", at: "x", record: {} }),
    line("dup", kind, { attempt_id: "d", n: 2 }),
    "   ",
  ].join("\n") + "\n" + line("tail", kind, { attempt_id: "t", partial: true })); // final line, no newline
}

describe("(a) the index returns what the whole-file read returns", () => {
  it("[CONTROL] every caller query shape, on duplicates, malformed and invalid lines and an unterminated final line", () => {
    fixture();
    same("landingEvent");
    same("landingEvent"); // second read, from the index
    expect(ledger.readRecords("attemptIntent")).toEqual([]); // no file
  });
  it("appendRecord's duplicate test is unchanged: a key on any parsed line refuses, including an invalid record and the unterminated tail", () => {
    fixture();
    expect(ledger.appendRecord("landingEvent", "invalid-only", { x: 1 }).appended).toBe(false);
    expect(ledger.appendRecord("landingEvent", "a1", { x: 1 }).appended).toBe(false);
    expect(ledger.appendRecord("landingEvent", "tail", { x: 1 }).appended).toBe(false);
    // a new key appends (it lands after the unterminated tail, concatenated, exactly as the whole-file writer did)
    expect(ledger.appendRecord("landingEvent", "fresh", { x: 1 }).appended).toBe(true);
    same("landingEvent");
    expect(ledger.appendRecord("landingEvent", "fresh2", { x: 2 }).appended).toBe(true);
    expect(ledger.appendRecord("landingEvent", "fresh2", { x: 3 }).appended).toBe(false);
    same("landingEvent");
    expect(ledger.readRecords("landingEvent", { key: "fresh2" }).map((r) => r.record)).toEqual([{ x: 2 }]);
  });
  it("[MUST-FAIL] a caller's array is its own (sort/reverse/push do not reach the next read), and a cached record cannot be changed by a caller (frozen: the parent hands out mutable copies)", () => {
    writeFileSync(file("attemptSettlement"), [line("k1", "attemptSettlement", { settlement_seq: 2 }), line("k2", "attemptSettlement", { settlement_seq: 1 })].join("\n") + "\n");
    const a = ledger.readRecords("attemptSettlement");
    a.reverse(); a.push(a[0]!);
    expect(ledger.readRecords("attemptSettlement").map((r) => r.key)).toEqual(["k1", "k2"]);
    const r = ledger.readRecords("attemptSettlement", { key: "k1" })[0]!;
    expect(() => { (r.record as Record<string, unknown>)["settlement_seq"] = 9; }).toThrow();
    expect(ledger.readRecords("attemptSettlement", { key: "k1" })[0]!.record).toEqual({ settlement_seq: 2 });
  });
});

describe("(b) another writer's change is seen on the next read", () => {
  it("an append by another writer", () => {
    fixture(); same("landingEvent");
    appendFileSync(file("landingEvent"), "\n" + line("ext", "landingEvent", { by: "other" }) + "\n");
    same("landingEvent");
    expect(ledger.readRecords("landingEvent", { key: "ext" }).length).toBe(1);
  });
  it("an unterminated final line completed later is read as the completed record", () => {
    writeFileSync(file("attemptIntent"), line("i1", "attemptIntent", { a: 1 }) + "\n" + '{"key":"i2","kind":"attemptIntent","at":"z","rec');
    same("attemptIntent");
    appendFileSync(file("attemptIntent"), 'ord":{"a":2}}\n');
    same("attemptIntent");
    expect(ledger.readRecords("attemptIntent", { key: "i2" })[0]?.record).toEqual({ a: 2 });
  });
  it("an in-place rewrite to a LARGER file (same inode) is a rewrite, not an append", () => {
    writeFileSync(file("attemptOutcome"), line("o1", "attemptOutcome", { v: 1 }) + "\n");
    same("attemptOutcome");
    writeFileSync(file("attemptOutcome"), line("o2", "attemptOutcome", { v: 2, pad: "x".repeat(200) }) + "\n" + line("o3", "attemptOutcome", { v: 3 }) + "\n");
    same("attemptOutcome");
    expect(ledger.readRecords("attemptOutcome").map((r) => r.key)).toEqual(["o2", "o3"]);
  });
  it("a same-size rewrite (new mtime), a truncation and a rotation", () => {
    writeFileSync(file("attemptRevert"), line("r1", "attemptRevert", { s: "aa" }) + "\n");
    same("attemptRevert");
    const t0 = statSync(file("attemptRevert")).mtime;
    writeFileSync(file("attemptRevert"), line("r2", "attemptRevert", { s: "bb" }) + "\n");
    utimesSync(file("attemptRevert"), new Date(t0.getTime() + 5000), new Date(t0.getTime() + 5000));
    same("attemptRevert");
    expect(ledger.readRecords("attemptRevert")[0]?.key).toBe("r2");
    writeFileSync(file("attemptRevert"), "");
    same("attemptRevert");
    writeFileSync(join(DIR, "next.jsonl"), line("r9", "attemptRevert", { s: "rotated" }) + "\n");
    renameSync(file("attemptRevert"), join(DIR, "old.jsonl"));
    renameSync(join(DIR, "next.jsonl"), file("attemptRevert"));
    same("attemptRevert");
    expect(ledger.readRecords("attemptRevert")[0]?.key).toBe("r9");
    rmSync(file("attemptRevert"));
    expect(ledger.readRecords("attemptRevert")).toEqual([]);
  });
});

describe("(c) a read no longer scales with the file's size", () => {
  function big(): void {
    const rows: string[] = [];
    for (let i = 0; i < 4000; i++) rows.push(line(`att-${i}#commit`, "landingEvent", { attempt_id: `att-${i % 1000}`, event: "commit", sha: "a".repeat(40), note: "x".repeat(300) }));
    writeFileSync(file("landingEvent"), rows.join("\n") + "\n");
    const t = 1_790_000_000; // a whole second, so a restored mtime is exact
    utimesSync(file("landingEvent"), t, t);
  }
  it("[MUST-FAIL] once read, an unchanged file (same inode, size and mtime) is not read again", () => {
    big();
    expect(ledger.readRecords("landingEvent", { key: "att-7#commit" }).length).toBe(1);
    // Overwrite the same bytes' worth in place and put the mtime back: a reader that re-reads sees the changed content;
    // the index (nothing changed by inode, size or mtime) does not read the file at all.
    const text = require("node:fs").readFileSync(file("landingEvent"), "utf-8") as string;
    writeFileSync(file("landingEvent"), text.replace('"att-7#commit"', '"att-X#commit"'));
    utimesSync(file("landingEvent"), 1_790_000_000, 1_790_000_000);
    expect(ledger.readRecords("landingEvent", { key: "att-7#commit" }).length).toBe(1);
  });
  it("[MUST-FAIL] after the first read, 50 reads of an unchanged ~1.6 MB ledger read 0 bytes; one appended line costs that line (+64 anchor bytes)", () => {
    big();
    const stats = (ledger as { __ledgerReadStatsForTests?: () => { bytes_read: number; full_reads: number } }).__ledgerReadStatsForTests;
    expect(typeof stats).toBe("function");
    ledger.readRecords("landingEvent");
    const after1 = stats!();
    expect(after1.bytes_read).toBeGreaterThan(1_000_000);
    for (let i = 0; i < 50; i++) { ledger.readRecords("landingEvent", { key: `att-${i}#commit` }); ledger.readRecords("landingEvent"); }
    expect(stats!().bytes_read).toBe(after1.bytes_read);
    const added = line("one-more", "landingEvent", { attempt_id: "z" }) + "\n";
    appendFileSync(file("landingEvent"), added);
    expect(ledger.readRecords("landingEvent", { key: "one-more" }).length).toBe(1);
    expect(stats!().bytes_read - after1.bytes_read).toBe(Buffer.byteLength(added) + 64);
    expect(stats!().full_reads).toBe(after1.full_reads);
  });
});
