/**
 * MERGING ONE GAP STORE INTO ANOTHER (pure; no I/O).
 *
 * WHY. A substrate whose gap store moves to another holder leaves the old holder's ledger behind: the rows it filed,
 * armed and closed exist only in its own gaps.json. The new holder must hold them too, or every gap the old holder
 * knew becomes a fresh, unarmed, uncredited row the next time a detector files it. The rows move by migration, never
 * by hand: the node whose store is left behind pushes it to the holder (substrate-gap.ts GAP-STORE MERGE), the holder
 * applies this plan, and both sides check the effect by counts read back from disk.
 *
 * THE CONFLICT RULE (one id, two contents).
 *   - Rows are compared with nothing stripped except key order (a canonical stringify). Equal content is not a
 *     conflict: the holder's row stays and nothing is kept aside.
 *   - Otherwise the row with the NEWER `updated_at` wins. A timestamp that does not parse loses to one that does.
 *     A tie (both equal, or neither parses) goes to the HOLDER: it is the authority that keeps judging the row.
 *   - The loser is never dropped: it is returned in `previous`, and the caller keeps it in the _previous ledger
 *     beside the store (gaps/_previous.jsonl), keyed by id and a hash of its content. It is not kept INSIDE the row:
 *     the write path rebuilds a row from the incoming write and carries only named fields forward, so a row field
 *     would be lost at that row's next write.
 *   - A loser already kept (same id, same content hash) is not kept again, so running the same merge twice changes
 *     nothing the second time.
 *
 * WHAT THE PLAN NEVER TOUCHES. The write path addresses an id by its FIRST row (findIndex), so a store with two rows
 * of one id has one live row and shadows. The holder's shadows stay exactly where and as they are (they are counted,
 * not collapsed: collapsing could change which row is live). The merge reads and replaces only the holder's first row
 * of an id. The source's first row of an id is its live row; the source's shadows of that id are kept in `previous`
 * when they differ from the winner.
 *
 * Positions: every holder row keeps its index; rows for ids the holder lacks are appended in source order.
 */

export type GapRow = Record<string, unknown> & { id: string };
export type MergeSide = "holder" | "source";
export type KeptPrevious = { id: string; content_hash: string; from: MergeSide; row: GapRow };

export type GapStoreMergeCounts = {
  /** rows in the holder's store before the merge (shadows included) */
  holder_before: number;
  /** rows received from the source (shadows included) */
  source_rows: number;
  source_ids: number;
  source_shadow_rows: number;
  holder_shadow_rows: number;
  /** source ids the holder did not have: appended */
  added: number;
  /** source ids whose live row equals the holder's: nothing changed */
  identical: number;
  /** source ids whose live row differs and the holder's row stayed (newer, or a tie) */
  holder_won: number;
  /** source ids whose live row differs and replaced the holder's (strictly newer) */
  source_won: number;
  /** rows in the holder's store after the merge */
  after: number;
};

export type GapStoreMergePlan = { rows: GapRow[]; previous: KeptPrevious[]; counts: GapStoreMergeCounts };

/** Canonical JSON (keys sorted at every depth): two rows are the same content iff these strings are equal. */
export function canonicalRow(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalRow).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalRow(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** The id the _previous ledger keys a kept row's content by. */
export function rowContentHash(row: unknown): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(canonicalRow(row));
  return h.digest("hex").slice(0, 32);
}

function updatedAtMs(row: GapRow): number {
  const v = row["updated_at"];
  const t = typeof v === "string" ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/** Whether `row` is one the merge can place: an object with a non-empty string id. */
export function isMergeableRow(row: unknown): row is GapRow {
  return !!row && typeof row === "object" && !Array.isArray(row) && typeof (row as { id?: unknown }).id === "string" && ((row as { id: string }).id).length > 0;
}

/**
 * Plan the merge of `source` into `holder`. `alreadyKept` holds the _previous ledger's existing `id:content_hash`
 * keys, so a loser kept by an earlier run is not returned again.
 */
export function planGapStoreMerge(holder: readonly GapRow[], source: readonly GapRow[], alreadyKept: ReadonlySet<string> = new Set()): GapStoreMergePlan {
  const rows: GapRow[] = holder.slice();
  const firstIdx = new Map<string, number>();
  let holderShadows = 0;
  holder.forEach((r, i) => { if (firstIdx.has(r.id)) holderShadows++; else firstIdx.set(r.id, i); });

  const sourceGroups = new Map<string, GapRow[]>();
  for (const r of source) { const g = sourceGroups.get(r.id); if (g) g.push(r); else sourceGroups.set(r.id, [r]); }

  const previous: KeptPrevious[] = [];
  const kept = new Set(alreadyKept);
  const keep = (row: GapRow, from: MergeSide, winner: GapRow): void => {
    if (canonicalRow(row) === canonicalRow(winner)) return;
    const content_hash = rowContentHash(row);
    const k = `${row.id}:${content_hash}`;
    if (kept.has(k)) return;
    kept.add(k);
    previous.push({ id: row.id, content_hash, from, row });
  };

  const counts: GapStoreMergeCounts = {
    holder_before: holder.length, source_rows: source.length, source_ids: sourceGroups.size,
    source_shadow_rows: source.length - sourceGroups.size, holder_shadow_rows: holderShadows,
    added: 0, identical: 0, holder_won: 0, source_won: 0, after: 0,
  };
  for (const [id, group] of sourceGroups) {
    const live = group[0]!;
    const shadows = group.slice(1);
    const idx = firstIdx.get(id);
    if (idx === undefined) {
      rows.push(live);
      firstIdx.set(id, rows.length - 1);
      counts.added++;
      for (const s of shadows) keep(s, "source", live);
      continue;
    }
    const held = rows[idx]!;
    let winner: GapRow;
    if (canonicalRow(held) === canonicalRow(live)) {
      winner = held;
      counts.identical++;
    } else if (updatedAtMs(live) > updatedAtMs(held)) {
      winner = live;
      rows[idx] = live;
      counts.source_won++;
      keep(held, "holder", winner);
    } else {
      winner = held;
      counts.holder_won++;
      keep(live, "source", winner);
    }
    for (const s of shadows) keep(s, "source", winner);
  }
  counts.after = rows.length;
  return { rows, previous, counts };
}

/**
 * THE BY-EFFECT CHECK: what was read back after the merge (`after`, and the _previous ledger's `keptKeys`) against
 * what went in. Returns the problems; empty means no row was lost.
 *   1. after = holder_before + (source ids the holder lacked).
 *   2. every holder row keeps its index: a holder shadow is unchanged, a holder first row is unchanged or replaced
 *      only by the source's live row of that id.
 *   3. every other input row (a holder first row, any source row) is the live row of its id in `after`, or is kept
 *      in the _previous ledger under its id and content hash.
 */
export function verifyGapStoreMerge(holder: readonly GapRow[], source: readonly GapRow[], after: readonly unknown[], keptKeys: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const holderIds = new Set(holder.map((r) => r.id));
  const newIds = new Set(source.map((r) => r.id).filter((id) => !holderIds.has(id)));
  if (after.length !== holder.length + newIds.size) problems.push(`row count: after=${after.length}, expected holder_before=${holder.length} + added=${newIds.size}`);
  const liveAfter = new Map<string, string>();
  for (const r of after) if (isMergeableRow(r) && !liveAfter.has(r.id)) liveAfter.set(r.id, canonicalRow(r));
  const sourceLive = new Map<string, string>();
  for (const r of source) if (!sourceLive.has(r.id)) sourceLive.set(r.id, canonicalRow(r));
  const seen = new Set<string>();
  const holderFirst: GapRow[] = [];
  holder.forEach((r, i) => {
    const a = after[i];
    const first = !seen.has(r.id);
    seen.add(r.id);
    if (first) holderFirst.push(r);
    const same = isMergeableRow(a) && canonicalRow(a) === canonicalRow(r);
    const replacedBySource = first && isMergeableRow(a) && a.id === r.id && sourceLive.get(r.id) === canonicalRow(a);
    if (!same && !replacedBySource) problems.push(`holder row ${i} (${r.id}) changed or moved`);
  });
  // A holder shadow is checked in place above; every other input row must be live or kept.
  for (const r of [...holderFirst, ...source]) {
    const live = liveAfter.get(r.id);
    if (live === undefined) { problems.push(`id ${r.id} is missing after the merge`); continue; }
    if (live === canonicalRow(r)) continue;
    if (!keptKeys.has(`${r.id}:${rowContentHash(r)}`)) problems.push(`a row of ${r.id} is neither live nor kept in _previous`);
  }
  return problems;
}
