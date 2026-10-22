/**
 * THE DURABLE QUEUE FOR GAP WRITES THE HOLDER COULD NOT TAKE (2026-10-22). Storage only: the decisions (what may be
 * queued, when it replays, what a replay's answer means) live in resolvers/substrate-gap.ts GAP-WRITE QUEUE.
 *
 * One file per queued write in <dir>/, named `<seq>-<write_id>.json` so a directory listing is the FIFO order. Each
 * is written to a unique tmp and renamed into place, so a reader sees a whole entry or none. Rewrites (an attempt
 * count) go the same way. A write that cannot be replayed is moved to <dir>/dead/ with a typed reason.
 *
 * BOUNDED. At most GAP_FORWARD_QUEUE_MAX_ENTRIES entries and GAP_FORWARD_QUEUE_MAX_ENTRY_BYTES per entry; past
 * either, nothing is written and the reason is typed (queue_full, entry_too_large). The dead-letter directory keeps
 * the newest GAP_FORWARD_QUEUE_MAX_DEAD entries and logs each one it drops. These bounds are bootstrap-tier capacity
 * (how much disk a node may spend while its holder is away), not behaviour.
 *
 * NEVER A CREDENTIAL. An entry holds the write's pointer and its write id. It never holds a key or anything derived
 * from one: only writes whose principal is this node are queued, and a replay presents the node key it holds anyway.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GAP_FORWARD_QUEUE_MAX_ENTRIES = 1000;
export const GAP_FORWARD_QUEUE_MAX_ENTRY_BYTES = 256 * 1024;
export const GAP_FORWARD_QUEUE_MAX_DEAD = 200;

export type QueuedGapWrite = { write_id: string; pointer: Record<string, unknown>; enqueued_at: string; attempts: number; last_error: string | null };
export type QueueRefusal = "queue_full" | "entry_too_large" | "queue_unwritable";
export type DeadReason = "attempts_exhausted" | `refused_on_replay:${string}` | "unreadable_entry";

let tmpCounter = 0;
let seqCounter = 0;
function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, path);
}
const isEntryFile = (f: string): boolean => f.endsWith(".json") && !f.includes(".tmp");

/** The queued entries' file names, oldest first. */
export function queuedFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(isEntryFile).sort();
}

/** Queue one write. The entry is whole on disk when this returns {queued:true}. */
export function enqueueGapWrite(dir: string, write_id: string, pointer: Record<string, unknown>): { queued: true; file: string } | { queued: false; reason: QueueRefusal; detail: string } {
  try {
    mkdirSync(dir, { recursive: true });
    const n = queuedFiles(dir).length;
    if (n >= GAP_FORWARD_QUEUE_MAX_ENTRIES) return { queued: false, reason: "queue_full", detail: `${n} writes are already queued (the bound is ${GAP_FORWARD_QUEUE_MAX_ENTRIES})` };
    const entry: QueuedGapWrite = { write_id, pointer, enqueued_at: new Date().toISOString(), attempts: 0, last_error: null };
    const text = JSON.stringify(entry);
    if (Buffer.byteLength(text) > GAP_FORWARD_QUEUE_MAX_ENTRY_BYTES) return { queued: false, reason: "entry_too_large", detail: `the write is ${Buffer.byteLength(text)} bytes (the bound is ${GAP_FORWARD_QUEUE_MAX_ENTRY_BYTES})` };
    const seq = `${Date.now().toString().padStart(15, "0")}-${String(seqCounter++ % 1_000_000).padStart(6, "0")}`;
    const file = `${seq}-${write_id.replace(/[^\w-]/g, "").slice(0, 64)}.json`;
    atomicWrite(join(dir, file), text);
    return { queued: true, file };
  } catch (err) {
    return { queued: false, reason: "queue_unwritable", detail: String((err as Error)?.message ?? err).slice(0, 200) };
  }
}

export function readQueued(dir: string, file: string): QueuedGapWrite | null {
  try {
    const e = JSON.parse(readFileSync(join(dir, file), "utf-8")) as QueuedGapWrite;
    return e && typeof e.write_id === "string" && e.pointer && typeof e.pointer === "object" ? e : null;
  } catch { return null; }
}

/** Record one more failed attempt on an existing entry (never a second entry). */
export function bumpQueuedAttempt(dir: string, file: string, entry: QueuedGapWrite, error: string): QueuedGapWrite {
  const next = { ...entry, attempts: entry.attempts + 1, last_error: error.slice(0, 300) };
  atomicWrite(join(dir, file), JSON.stringify(next));
  return next;
}

export function removeQueued(dir: string, file: string): void {
  rmSync(join(dir, file), { force: true });
}

/** Move an entry that will never replay to <dir>/dead/, with its typed reason; keep the newest GAP_FORWARD_QUEUE_MAX_DEAD. */
export function deadLetterQueued(dir: string, file: string, entry: QueuedGapWrite | null, reason: DeadReason): void {
  const dead = join(dir, "dead");
  mkdirSync(dead, { recursive: true });
  atomicWrite(join(dead, file), JSON.stringify({ ...(entry ?? {}), dead_reason: reason, dead_at: new Date().toISOString() }));
  rmSync(join(dir, file), { force: true });
  const all = readdirSync(dead).filter(isEntryFile).sort();
  for (const f of all.slice(0, Math.max(0, all.length - GAP_FORWARD_QUEUE_MAX_DEAD))) {
    rmSync(join(dead, f), { force: true });
    console.error(`[gap-forward-queue] dead-letter bound reached: dropped the oldest dead entry ${f}`);
  }
}
