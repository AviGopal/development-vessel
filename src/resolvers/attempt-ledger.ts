import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ResolverResult } from './types.js';

// attemptRevert: the auto-revert's once-per-landing marker (gap-to-feature autoRevertRegressedLandings), one
// record per status transition, keyed `<reverted attempt id>#revert:<seq>:<status>` (appendRecord refuses a
// repeated key, so a transition is a new key, never a rewrite); the reader takes the latest by file order.
export type LedgerKind = "attemptIntent" | "stateSnapshot" | "attemptOutcome" | "attemptSettlement" | "landingEvent" | "attemptRevert";

export function ledgerDir(): string {
  if (process.env.ATTEMPT_LEDGER_DIR) return process.env.ATTEMPT_LEDGER_DIR;
  // bun test sets NODE_ENV=test; a test run must never write the live ledger.
  if (process.env.NODE_ENV === "test") return join(tmpdir(), `attempt-ledger-test-${process.pid}`);
  return "/workspace/attempt-ledger";
}

const VALID_LEDGER_KINDS: ReadonlySet<string> = new Set<LedgerKind>([
  "attemptIntent",
  "stateSnapshot",
  "attemptOutcome",
  "attemptSettlement",
  "landingEvent",
  "attemptRevert",
]);

type LedgerRecord = {
  key: string;
  kind: LedgerKind;
  at: string;
  record: Record<string, unknown>;
};

function isLedgerRecord(obj: unknown): obj is LedgerRecord {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }
  const rec = obj as LedgerRecord;
  return (
    typeof rec.key === "string" &&
    VALID_LEDGER_KINDS.has(rec.kind) &&
    typeof rec.at === "string" &&
    typeof rec.record === "object" &&
    rec.record !== null &&
    !Array.isArray(rec.record)
  );
}

/**
 * THE IN-MEMORY INDEX (one per ledger file). Every read used to readFileSync the WHOLE `${kind}.jsonl` and JSON.parse
 * every line, for every call, a single-key lookup included: profiled on node1 (2026-10-17, 483 s of dev-vessel CPU)
 * readRecords was 33.4% of all CPU and the files only grow (landingEvent 5.3 MB). The file stays the source of truth;
 * the index is what this process has already parsed of it, and every call first catches up with the file:
 *   - same inode, same size, same mtime: nothing to read;
 *   - same inode, larger, and the bytes just before what was consumed unchanged: only the new bytes are read
 *     (another writer's appends included);
 *   - anything else (another inode: rotated or recreated; smaller: truncated; same size but a new mtime, or larger
 *     with those anchor bytes changed: rewritten in place): rebuilt from the whole file.
 * A final line with no newline yet (a write in progress, or another writer's) is parsed per call exactly as before
 * and never cached, so it is re-read once complete. Results are the same records, in the same file order, as the
 * whole-file read. Cached records are deep-frozen: every caller reads them (none writes; audited 2026-10-17), and a
 * future caller that tried to would throw instead of silently changing what the next read returns. Each call returns a
 * fresh array, so a caller's sort/reverse/push stays its own.
 */
type LedgerIndex = {
  ino: number; size: number; mtimeMs: number;
  /** bytes of the file covered by `records` (always just after a newline) */
  consumed: number;
  /** the last bytes before `consumed`, as read: a growth whose bytes here differ was a rewrite, not an append */
  anchor: Buffer;
  records: LedgerRecord[];
  byKey: Map<string, LedgerRecord[]>;
  /** every string `key` on any parsed line, valid record or not: appendRecord's duplicate test reads the same set */
  keys: Set<string>;
};
const indexes = new Map<string, LedgerIndex>();
const ANCHOR_BYTES = 64;
const readStats = { full_reads: 0, tail_reads: 0, bytes_read: 0 };
/** For tests: how much of the ledger files this process has read (bytes and reads), and a reset. */
export function __ledgerReadStatsForTests(): { full_reads: number; tail_reads: number; bytes_read: number } { return { ...readStats }; }
export function __resetLedgerIndexForTests(): void { indexes.clear(); readStats.full_reads = 0; readStats.tail_reads = 0; readStats.bytes_read = 0; }

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}
function parseLine(line: string): unknown {
  if (line.trim() === "") return undefined;
  try { return JSON.parse(line); } catch { return undefined; } // malformed lines are ignored, as before
}
function ingest(ix: LedgerIndex, parsed: unknown): void {
  if (typeof parsed === "object" && parsed !== null && "key" in parsed && typeof (parsed as { key: unknown }).key === "string") ix.keys.add((parsed as { key: string }).key);
  if (!isLedgerRecord(parsed)) return;
  const rec = deepFreeze(parsed);
  ix.records.push(rec);
  const list = ix.byKey.get(rec.key);
  if (list) list.push(rec); else ix.byKey.set(rec.key, [rec]);
}
function readBytes(filePath: string, from: number, to: number): Buffer {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(to - from);
    let off = 0;
    while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, from + off); if (n <= 0) break; off += n; }
    return buf.subarray(0, off);
  } finally { closeSync(fd); }
}
/** Ingest the complete lines of `buf` (which starts at a line boundary, byte `startByte` of the file); returns the
 *  unterminated final line as text. Offsets are counted in BYTES on the raw buffer (a newline byte never occurs inside a
 *  multi-byte UTF-8 sequence), so a malformed byte cannot shift where the next read starts. */
function ingestBuf(ix: LedgerIndex, buf: Buffer, startByte: number): string {
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl >= 0) {
    for (const line of buf.subarray(0, lastNl + 1).toString("utf-8").split("\n")) { const p = parseLine(line); if (p !== undefined) ingest(ix, p); }
  }
  ix.consumed = startByte + lastNl + 1;
  if (lastNl >= 0) {
    const from = Math.max(0, lastNl + 1 - ANCHOR_BYTES);
    const fresh = Buffer.from(buf.subarray(from, lastNl + 1));
    ix.anchor = fresh.length >= ANCHOR_BYTES ? fresh : Buffer.concat([ix.anchor, fresh]).subarray(-ANCHOR_BYTES);
  }
  return buf.subarray(lastNl + 1).toString("utf-8");
}
/** Bring this file's index up to date with the file; returns the index and the unterminated tail (or null: no file). */
function catchUp(filePath: string): { ix: LedgerIndex; tail: string } | null {
  let st;
  try { st = statSync(filePath); } catch { indexes.delete(filePath); return null; }
  let ix = indexes.get(filePath);
  const sameFile = !!ix && ix.ino === st.ino && st.size >= ix.consumed && !(st.size === ix.size && st.mtimeMs !== ix.mtimeMs);
  if (ix && sameFile) {
    if (st.size === ix.size) {
      // unchanged: only an unterminated final line (never cached) is read again
      if (ix.size <= ix.consumed) return { ix, tail: "" };
      readStats.tail_reads += 1;
      const t = readBytes(filePath, ix.consumed, ix.size);
      readStats.bytes_read += t.length;
      return { ix, tail: t.toString("utf-8") };
    }
    readStats.tail_reads += 1;
    const aLen = ix.anchor.length;
    const raw = readBytes(filePath, ix.consumed - aLen, st.size);
    readStats.bytes_read += raw.length;
    if (raw.length >= aLen && raw.subarray(0, aLen).equals(ix.anchor)) {
      const tail = ingestBuf(ix, raw.subarray(aLen), ix.consumed);
      ix.size = st.size; ix.mtimeMs = st.mtimeMs;
      return { ix, tail };
    }
    // the bytes before the new ones changed: a rewrite, so fall through to a full rebuild
  }
  ix = { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, consumed: 0, anchor: Buffer.alloc(0), records: [], byKey: new Map(), keys: new Set() };
  readStats.full_reads += 1;
  const buf = readFileSync(filePath);
  readStats.bytes_read += buf.length;
  const tail = ingestBuf(ix, buf, 0);
  // A write between the stat and the read leaves size/mtime describing less than was read: the next call then sees a
  // new mtime and rebuilds (or a larger size and reads only the bytes after `consumed`), never a stale result.
  if (buf.length !== st.size) ix.mtimeMs = -1;
  indexes.set(filePath, ix);
  return { ix, tail };
}
function tailRecord(tail: string): { parsed: unknown; record: LedgerRecord | null } {
  const parsed = parseLine(tail);
  return { parsed, record: parsed !== undefined && isLedgerRecord(parsed) ? parsed : null };
}

export function appendRecord(kind: LedgerKind, key: string, record: Record<string, unknown>): { appended: boolean; key: string } {
  const dir = ledgerDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const filePath = join(dir, `${kind}.jsonl`);

  const cur = catchUp(filePath);
  if (cur) {
    if (cur.ix.keys.has(key)) return { appended: false, key };
    const t = tailRecord(cur.tail).parsed;
    if (typeof t === "object" && t !== null && "key" in t && (t as { key: unknown }).key === key) return { appended: false, key };
  }

  const newRecord: LedgerRecord = { key, kind, at: new Date().toISOString(), record };
  const newLine = JSON.stringify(newRecord) + "\n";
  appendFileSync(filePath, newLine, "utf-8");
  // The index takes the new line on the next call's catch-up (a tail read of just this line), the same path another
  // writer's append takes, so there is one way in.

  return { appended: true, key };
}

export function readRecords(
  kind: LedgerKind,
  opts?: { key?: string; limit?: number }
): Array<LedgerRecord> {
  const filePath = join(ledgerDir(), `${kind}.jsonl`);
  const cur = catchUp(filePath);
  if (!cur) {
    return [];
  }
  const { ix, tail } = cur;
  const t = tail ? tailRecord(tail).record : null;
  let records: LedgerRecord[];
  if (opts?.key) {
    records = [...(ix.byKey.get(opts.key) ?? [])];
    if (t && t.key === opts.key) records.push(t);
  } else {
    records = [...ix.records];
    if (t) records.push(t);
  }

  if (opts?.limit && opts.limit > 0) {
    return records.slice(-opts.limit);
  }

  return records;
}

/** The whole-file read this index replaced, kept as the reference the index is tested against. */
export function __readRecordsUncachedForTests(
  kind: LedgerKind,
  opts?: { key?: string; limit?: number }
): Array<LedgerRecord> {
  const filePath = join(ledgerDir(), `${kind}.jsonl`);
  if (!existsSync(filePath)) {
    return [];
  }

  const fileContent = readFileSync(filePath, "utf-8");
  const lines = fileContent.split("\n");
  const records: LedgerRecord[] = [];

  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (isLedgerRecord(parsed)) {
        if (opts?.key && parsed.key !== opts.key) {
          continue;
        }
        records.push(parsed);
      }
    } catch (e) {
      // Ignore malformed lines
    }
  }

  if (opts?.limit && opts.limit > 0) {
    return records.slice(-opts.limit);
  }

  return records;
}

export async function resolveAttemptLedger(pointer: {
  type: "attemptLedger";
  kind: LedgerKind;
  key?: string;
  limit?: number;
}): Promise<ResolverResult> {
  const { kind, key, limit } = pointer;

  if (!VALID_LEDGER_KINDS.has(kind)) {
    return {
      shape: "structuredError",
      body: { error: "unknown ledger kind", kind },
    };
  }

  const records = readRecords(kind, { key, limit });
  return {
    shape: "attemptLedger",
    body: { kind, records },
  };
}