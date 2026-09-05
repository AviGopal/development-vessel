/**
 * schema-assert-drift-scan
 *
 * Scans SurrealDB ASSERT constraints on concept/concept_edge/concept_usage tables
 * and detects data values that fall outside the declared allowed-value lists.
 */

import type { ResolverResult } from "./types.js";

const SURREALDB_URL = process.env["SURREALDB_URL"] ?? "http://127.0.0.1:8000";
const SURREALDB_USERNAME = process.env["SURREALDB_USERNAME"] ?? "root";
const SURREALDB_PASSWORD =
  process.env["SURREALDB_PASSWORD"] ??
  process.env["SURREAL_PASS"] ??
  "root";
const SURREALDB_NS = process.env["SURREALDB_NAMESPACE"] ?? "activity-system";
const SURREALDB_DB = process.env["SURREALDB_DATABASE"] ?? "learning_loop";

interface SurrealResponse {
  result?: unknown;
  status?: string;
  detail?: string;
}

async function surrealQuery(sql: string): Promise<unknown[]> {
  const res = await fetch(`${SURREALDB_URL}/sql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "surreal-ns": SURREALDB_NS,
      "surreal-db": SURREALDB_DB,
      "Authorization": "Basic " + btoa(`${SURREALDB_USERNAME}:${SURREALDB_PASSWORD}`),
    },
    body: sql,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SurrealDB HTTP ${res.status}: ${text}`);
  }
  const data = (await res.json()) as SurrealResponse[];
  return data.map((r) => r.result);
}

interface FieldAssert {
  table: string;
  field: string;
  allowed: string[];
}

function parseAllowedValues(defStr: string): string[] | null {
  // Match ASSERT $value IN [...] or ASSERT $value INSIDE [...]
  const match = defStr.match(/ASSERT\s+\$value\s+(?:IN|INSIDE)\s+\[([^\]]+)\]/i);
  if (!match) return null;
  const inner = match[1] ?? "";
  const values: string[] = [];
  // Extract quoted strings
  const re = /['"](.*?)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    if (m[1] !== undefined) values.push(m[1]);
  }
  return values.length > 0 ? values : null;
}

type InfoForTableResult = Record<string, Record<string, string>>;

async function extractAsserts(tables: string[]): Promise<FieldAssert[]> {
  const sql = tables.map((t) => `INFO FOR TABLE ${t};`).join(" ");
  const results = await surrealQuery(sql);
  const asserts: FieldAssert[] = [];

  for (let i = 0; i < tables.length; i++) {
    const table = tables[i] ?? "";
    const result = results[i] as InfoForTableResult | null | undefined;
    if (!result || typeof result !== "object") continue;
    const fields = (result as Record<string, unknown>)["fields"];
    if (!fields || typeof fields !== "object") continue;
    for (const [fieldName, fieldDef] of Object.entries(fields as Record<string, unknown>)) {
      const defStr = typeof fieldDef === "string" ? fieldDef : JSON.stringify(fieldDef);
      const allowed = parseAllowedValues(defStr);
      if (allowed !== null) {
        asserts.push({ table, field: fieldName, allowed });
      }
    }
  }
  return asserts;
}

interface CheckedEntry {
  table: string;
  field: string;
  allowed_count: number;
  distinct_in_data: number;
}

interface DriftEntry {
  table: string;
  field: string;
  value: string;
  row_count: number;
}

type GroupByRow = Record<string, unknown>;

async function collectDrifts(
  asserts: FieldAssert[]
): Promise<{ checked: CheckedEntry[]; drifts: DriftEntry[] }> {
  const checked: CheckedEntry[] = [];
  const drifts: DriftEntry[] = [];

  for (const fa of asserts) {
    const sql = `SELECT ${fa.field}, count() FROM ${fa.table} GROUP BY ${fa.field};`;
    let rows: GroupByRow[];
    try {
      const results = await surrealQuery(sql);
      const raw = results[0];
      rows = Array.isArray(raw) ? (raw as GroupByRow[]) : [];
    } catch {
      rows = [];
    }

    const allowedSet = new Set(fa.allowed);
    let distinct = 0;

    for (const row of rows) {
      const val = row[fa.field];
      if (val === null || val === undefined) continue;
      distinct++;
      const valStr = String(val);
      if (!allowedSet.has(valStr)) {
        const cnt = typeof row["count"] === "number" ? (row["count"] as number) : 1;
        drifts.push({ table: fa.table, field: fa.field, value: valStr, row_count: cnt });
      }
    }

    checked.push({
      table: fa.table,
      field: fa.field,
      allowed_count: fa.allowed.length,
      distinct_in_data: distinct,
    });
  }

  return { checked, drifts };
}

/**
 * DECLARATION DRIFT — what the migrations SAY the schema is, versus what it IS.
 *
 * The assert scan above compares DATA against declared ASSERT lists. Nothing compared the
 * DECLARATIONS themselves against the live schema, and on 2026-09-05 that cost a day:
 *
 *  - MISSING. `activity` is SCHEMAFULL and had 51 fields declared across sql/ but 54 live,
 *    with 6 declared fields absent. SurrealDB DISCARDS a write to an undeclared field
 *    silently — success:true, HTTP 200, value gone. Commit cc81c2d correctly wrote
 *    `retired_reason` for months' worth of retirements and every one was thrown away. The
 *    six belonged to two migrations that `init_migrations` records as applied but which
 *    never ran (37 files stamped inside one second by a bootstrap that pre-populates the
 *    ledger and skips applying).
 *
 *  - HAZARD. The mirror image. A non-`option` field with no DEFAULT/VALUE on a table that
 *    already has rows makes SurrealDB reject EVERY write omitting it —
 *    "Found NONE for field `input_schema` ... but expected a object". That took the trace
 *    store offline for 35 minutes and 156 errors. It is still latent on
 *    `org_id ON impulse_resolution_metrics TYPE string` (migration 070), harmless only
 *    while that table has zero rows.
 *
 * Both are invisible to every existing check: typecheck does not parse .surql, and the
 * database reports success either way. The consuming layer for a schema declaration is
 * `INFO FOR TABLE`, so that is what this compares against.
 *
 * PURE over its inputs so the logic is testable without a database.
 */
export interface DeclarationDriftResult {
  missing: Array<{ table: string; field: string; declared_in: string }>;
  hazards: Array<{ table: string; field: string; type: string }>;
  declared_count: number;
  tables_seen: number;
  schemafull_tables: number;
}

/**
 * NAME THE DENOMINATOR, OR THE DETECTOR IS NOISE.
 *
 * Run first without these two filters, the scan reported 140 missing and 114 hazards over the
 * live store — 254 items nobody would read. Both numbers were measuring the wrong population:
 *
 *  - A missing declaration only DISCARDS anything on a SCHEMAFULL table. SCHEMALESS tables
 *    accept undeclared fields, so a declaration absent there costs nothing. 59 of 97 tables
 *    are SCHEMAFULL.
 *  - A non-optional field is only DANGEROUS if rows exist that omit it. `org_id` on
 *    impulse_resolution_metrics is exactly this shape and breaks nothing, because that table
 *    has zero rows. Confirming violations is a query, so the pure function returns hazard
 *    CANDIDATES and the resolver confirms them against row counts.
 *
 * A detector that cries wolf 254 times is worse than none: it trains its reader to skip it.
 */
export function declarationDrift(
  files: Array<{ path: string; sql: string }>,
  liveIn: Map<string, Map<string, string>>,
  schemafull?: Set<string>,
): DeclarationDriftResult {
  const FIELD_RE =
    /DEFINE\s+FIELD\s+(?:(?:IF\s+NOT\s+EXISTS|OVERWRITE)\s+)*([A-Za-z_][\w.[\]*]*)\s+ON\s+(?:TABLE\s+)?([A-Za-z_]\w*)([^;]*);/gi;
  const missing: DeclarationDriftResult["missing"] = [];
  const seenDecl = new Set<string>();
  let declared = 0;

  // SurrealDB BACKTICK-QUOTES RESERVED WORDS in `INFO FOR TABLE`, so a field declared as
  // `diff` comes back keyed as "`diff`". Comparing the raw keys reported code_modification
  // _proposal.diff and substrate_tuning_param.value as MISSING when both exist — 2 of the
  // first 4 findings, a 50% false-positive rate that would make this scan ignorable.
  const unquote = (s: string) => s.replace(/^`|`$/g, "");
  const normLive = new Map<string, Map<string, string>>();
  for (const [t, fields] of liveIn) {
    const m = new Map<string, string>();
    for (const [k, v] of fields) m.set(unquote(k), v);
    normLive.set(t, m);
  }
  const live = normLive;

  for (const f of files) {
    if (!/\.surql$/i.test(f.path)) continue;
    const sql = f.sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const m of sql.matchAll(FIELD_RE)) {
      const field = m[1]!;
      const table = m[2]!;
      // `tasks.*` types array ELEMENTS; INFO FOR TABLE reports those under a different
      // key shape, so comparing them would manufacture false drift.
      if (field.includes(".") || field.includes("[")) continue;
      declared++;
      const key = `${table} ${field}`;
      if (seenDecl.has(key)) continue;
      seenDecl.add(key);
      const liveTable = live.get(table);
      // ABSTAIN on a table we have no live picture of — absence of data is not drift.
      if (!liveTable) continue;
      // ABSTAIN on SCHEMALESS tables: an undeclared field there is accepted, not discarded.
      if (schemafull && !schemafull.has(table)) continue;
      if (!liveTable.has(field)) {
        missing.push({ table, field, declared_in: f.path.split("/").slice(-1)[0]! });
      }
    }
  }

  // Hazards are read off the LIVE schema, not the files: a field can be dangerous however
  // it got there, including by a hand-applied DDL that no migration records.
  const hazards: DeclarationDriftResult["hazards"] = [];
  for (const [table, fields] of live) {
    if (schemafull && !schemafull.has(table)) continue;
    for (const [field, def] of fields) {
      if (field.includes(".") || field.includes("[")) continue;
      const tm = def.match(
        /\bTYPE\s+([\s\S]+?)(?=\s+(?:DEFAULT|VALUE|ASSERT|PERMISSIONS|COMMENT|READONLY|REFERENCE|FLEXIBLE)\b|$)/i,
      );
      if (!tm) continue;
      const type = tm[1]!.trim();
      if (/^option\s*</i.test(type)) continue;
      if (/\b(DEFAULT|VALUE)\b/i.test(def)) continue;
      hazards.push({ table, field, type });
    }
  }

  return {
    missing,
    hazards,
    declared_count: declared,
    tables_seen: live.size,
    schemafull_tables: schemafull ? schemafull.size : live.size,
  };
}

/**
 * Confirm hazard candidates against reality: a non-optional field is only dangerous if rows
 * already exist that omit it. Returns only confirmed hazards, each with the violating count.
 * A field whose count cannot be read is DROPPED rather than reported — an unmeasurable hazard
 * is not evidence of one.
 */
export async function confirmHazards(
  candidates: DeclarationDriftResult["hazards"],
  countViolating: (table: string, field: string) => Promise<number | null>,
): Promise<Array<{ table: string; field: string; type: string; violating_rows: number }>> {
  const confirmed: Array<{ table: string; field: string; type: string; violating_rows: number }> = [];
  for (const c of candidates) {
    const n = await countViolating(c.table, c.field);
    if (n !== null && n > 0) confirmed.push({ ...c, violating_rows: n });
  }
  return confirmed;
}

/** Read every .surql under a root. Returns null (not []) when the root is unreadable. */
async function readSurqlTree(root: string): Promise<Array<{ path: string; sql: string }> | null> {
  const { readdir, readFile, stat } = await import("node:fs/promises");
  const out: Array<{ path: string; sql: string }> = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir)) {
      const p = `${dir}/${entry}`;
      const st = await stat(p);
      if (st.isDirectory()) await walk(p);
      else if (entry.endsWith(".surql")) out.push({ path: p, sql: await readFile(p, "utf8") });
    }
  }
  try {
    await walk(root);
  } catch {
    return null;
  }
  return out;
}

async function liveSchema(): Promise<{
  live: Map<string, Map<string, string>>;
  schemafull: Set<string>;
}> {
  const live = new Map<string, Map<string, string>>();
  const schemafull = new Set<string>();
  const dbInfo = (await surrealQuery("INFO FOR DB;"))[0] as
    | { tables?: Record<string, string> }
    | undefined;
  const defs = dbInfo?.tables ?? {};
  const tables = Object.keys(defs);
  if (tables.length === 0) return { live, schemafull };
  for (const t of tables) if (/SCHEMAFULL/i.test(String(defs[t]))) schemafull.add(t);
  // INFO FOR TABLE in batches: one 97-statement body is a large single request.
  const CHUNK = 25;
  for (let i = 0; i < tables.length; i += CHUNK) {
    const group = tables.slice(i, i + CHUNK);
    let results: unknown[];
    try {
      results = await surrealQuery(group.map((t) => `INFO FOR TABLE ${t};`).join(" "));
    } catch {
      continue;
    }
    for (let j = 0; j < group.length; j++) {
      const r = results[j] as InfoForTableResult | null | undefined;
      if (!r?.["fields"]) continue;
      live.set(group[j]!, new Map(Object.entries(r["fields"])));
    }
  }
  return { live, schemafull };
}

export async function resolveSchemaAssertDriftScan(
  pointer: Record<string, unknown>
): Promise<ResolverResult> {
  const tables = ["concept", "concept_edge", "concept_usage"];
  const asserts = await extractAsserts(tables);
  const { checked, drifts } = await collectDrifts(asserts);

  // Declaration drift over the vessel whose migrations own the schema.
  const sqlRoot =
    typeof pointer["sql_root"] === "string"
      ? (pointer["sql_root"] as string)
      : "/vessels/activity-api/sql";
  let declaration: DeclarationDriftResult | null = null;
  let declarationUnavailable: string | null = null;
  try {
    const files = await readSurqlTree(sqlRoot);
    if (files === null || files.length === 0) {
      // AN UNREADABLE ROOT MUST NOT READ AS A CLEAN SCAN. Reporting zero drift because we
      // found zero files is exactly the silence-is-success failure this scan exists to
      // catch; say we could not look instead.
      declarationUnavailable = `sql_root_unreadable_or_empty: ${sqlRoot}`;
    } else {
      const { live, schemafull } = await liveSchema();
      if (live.size === 0) {
        declarationUnavailable = "live_schema_unavailable";
      } else {
        const raw = declarationDrift(files, live, schemafull);
        // Confirm hazard candidates against rows that actually violate them.
        const confirmed = await confirmHazards(raw.hazards, async (table, field) => {
          try {
            const res = await surrealQuery(
              `SELECT count() FROM ${table} WHERE ${field} IS NONE GROUP ALL;`,
            );
            const rows = res[0];
            if (!Array.isArray(rows) || rows.length === 0) return 0;
            const c = (rows[0] as Record<string, unknown>)["count"];
            return typeof c === "number" ? c : null;
          } catch {
            return null; // unmeasurable is not evidence of a hazard
          }
        });
        declaration = { ...raw, hazards: confirmed as unknown as typeof raw.hazards };
      }
    }
  } catch (err) {
    declarationUnavailable = `declaration_scan_failed: ${(err as Error).message}`;
  }

  return {
    shape: "schemaAssertDrift",
    body: {
      checked,
      drifts,
      drift_count: drifts.length,
      declaration_drift: declaration,
      declaration_unavailable: declarationUnavailable,
      checked_at: new Date().toISOString(),
    },
  };
}
