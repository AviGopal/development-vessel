/**
 * THE GAP-STORE MERGE MIGRATION, FORWARDER SIDE (2026-10-22).
 *
 * WHY HERE. When a node's gap store moves to another holder, the store it held stays on its own disk. The new holder
 * cannot fetch it: a node behind NAT publishes nothing it can dial. The node can always dial OUT to its holder (that is
 * how every forwarded gap write travels), so the node pushes its old store, and the holder merges it
 * (substrate-gap.ts GAP-STORE MERGE). It is a migration the substrate applies itself: it runs at unit start on any node
 * that forwards (GAP_STORE_ENDPOINT set) and still has a local gaps.json with rows, and it does nothing anywhere else.
 * Nothing is hand-edited on either side.
 *
 * ONCE PER (holder, store bytes). A completed merge writes gaps/gap-store-merge.done.json (tmp + rename) naming a hash
 * of the holder endpoint and of the local store's bytes; the same pair is never pushed again. A local store that
 * changed since, or a new holder, runs it again, which is safe: the holder's merge is idempotent by id and content
 * (lib/gap-store-merge.ts). A stale copy on a node that only ever forwarded is harmless for the same reason: its rows
 * are older than the holder's, so the holder's rows stay live and the stale ones are only kept aside.
 *
 * BY EFFECT, PER CHUNK. Rows go in chunks (every row of one id in the same chunk, so the holder sees the source's live
 * row and its shadows together). Each chunk's answer must be the holder's verified read-back, and its counts must add
 * up: received = the chunk's rows; added + identical + holder_won + source_won = the chunk's ids; after = before +
 * added. Any chunk that fails leaves no marker, so the next start runs the migration again.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { forwardToGapStore, gapStoreFilePath, gapStoreIsLocal } from "./substrate-gap.js";
import type { ResolverResult } from "./types.js";

export const GAP_STORE_MERGE_CHUNK_ROWS = 200;

type Row = Record<string, unknown> & { id: string };
export type GapStoreMergeMigrationResult =
  | { status: "skipped"; reason: "holds_the_store" | "no_local_store" | "already_merged" }
  | { status: "merged"; migration_id: string; chunks: number; totals: Record<string, number> }
  | { status: "incomplete"; migration_id: string; chunk_index: number; why: string };

const sha = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const markerPath = (): string => join(dirname(gapStoreFilePath()), "gap-store-merge.done.json");

/** Chunks of at most `size` rows, never splitting the rows of one id (a single id with more rows is one chunk). */
export function chunkRowsById(rows: readonly Row[], size: number): Row[][] {
  const groups = new Map<string, Row[]>();
  for (const r of rows) { const g = groups.get(r.id); if (g) g.push(r); else groups.set(r.id, [r]); }
  const chunks: Row[][] = [];
  let cur: Row[] = [];
  for (const g of groups.values()) {
    if (cur.length > 0 && cur.length + g.length > size) { chunks.push(cur); cur = []; }
    cur.push(...g);
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

/** Why a chunk's answer is not a verified merge of exactly that chunk, or null when it is. */
export function chunkAnswerProblem(chunk: readonly Row[], answer: ResolverResult | null): string | null {
  if (!answer) return "no answer (this node holds the store)";
  const b = (answer.body ?? {}) as Record<string, unknown>;
  if (answer.shape !== "substrateGapMerge_write") return `holder answered ${answer.shape}: ${String(b["failure_mode"] ?? "")} ${String(b["detail"] ?? "").slice(0, 200)}`.trim();
  if (b["verified"] !== true) return "holder did not report a verified read-back";
  const c = (b["counts"] ?? {}) as Record<string, unknown>;
  const n = (k: string): number => (typeof c[k] === "number" ? (c[k] as number) : Number.NaN);
  const ids = new Set(chunk.map((r) => r.id)).size;
  if (n("source_rows") !== chunk.length) return `holder received ${n("source_rows")} rows, sent ${chunk.length}`;
  if (n("added") + n("identical") + n("holder_won") + n("source_won") !== ids) return `holder accounted for ${n("added") + n("identical") + n("holder_won") + n("source_won")} ids, sent ${ids}`;
  if (n("after") !== n("holder_before") + n("added")) return `holder store went ${n("holder_before")} -> ${n("after")} rows with ${n("added")} added`;
  return null;
}

export async function runGapStoreMergeMigration(opts: { chunkRows?: number; sourceLabel?: string } = {}): Promise<GapStoreMergeMigrationResult> {
  if (gapStoreIsLocal()) return { status: "skipped", reason: "holds_the_store" };
  const path = gapStoreFilePath();
  if (!existsSync(path)) return { status: "skipped", reason: "no_local_store" };
  const raw = readFileSync(path);
  const parsed = JSON.parse(raw.toString("utf-8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("local gaps.json did not parse to an array: not merged");
  const rows = parsed.filter((r): r is Row => !!r && typeof r === "object" && typeof (r as { id?: unknown }).id === "string" && (r as { id: string }).id.length > 0);
  if (rows.length === 0) return { status: "skipped", reason: "no_local_store" };
  const endpointHash = sha(String(process.env["GAP_STORE_ENDPOINT"])).slice(0, 16);
  const sourceHash = sha(raw).slice(0, 16);
  const migrationId = `gap-store-merge:${endpointHash}:${sourceHash}`;
  try {
    const m = JSON.parse(readFileSync(markerPath(), "utf-8")) as { migration_id?: unknown };
    if (m.migration_id === migrationId) return { status: "skipped", reason: "already_merged" };
  } catch { /* no marker, or an unreadable one: run */ }
  const label = (opts.sourceLabel ?? process.env["VESSEL_ID"] ?? "forwarder").replace(/[^\w:.@-]/g, "").slice(0, 64);
  const chunks = chunkRowsById(rows, opts.chunkRows ?? GAP_STORE_MERGE_CHUNK_ROWS);
  const totals: Record<string, number> = { source_rows: 0, added: 0, identical: 0, holder_won: 0, source_won: 0, previous_kept: 0 };
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const answer = await forwardToGapStore({ type: "substrateGapMerge_write", migration_id: migrationId, source_label: label, chunk_index: i, chunk_count: chunks.length, rows: chunk });
    const why = chunkAnswerProblem(chunk, answer);
    if (why) {
      console.warn(`[gap-store-merge] ${migrationId}: chunk ${i + 1}/${chunks.length} not verified (${why}); no marker written, the next start runs the migration again`);
      return { status: "incomplete", migration_id: migrationId, chunk_index: i, why };
    }
    const c = ((answer!.body as Record<string, unknown>)["counts"] ?? {}) as Record<string, number>;
    for (const k of Object.keys(totals)) totals[k] = (totals[k] ?? 0) + (typeof c[k] === "number" ? c[k] : 0);
  }
  const marker = markerPath();
  const tmp = `${marker}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ migration_id: migrationId, chunks: chunks.length, totals, at: new Date().toISOString() }));
  renameSync(tmp, marker);
  console.log(`[gap-store-merge] ${migrationId}: ${rows.length} local rows merged into the holder in ${chunks.length} verified chunk(s): ${JSON.stringify(totals)}`);
  return { status: "merged", migration_id: migrationId, chunks: chunks.length, totals };
}
