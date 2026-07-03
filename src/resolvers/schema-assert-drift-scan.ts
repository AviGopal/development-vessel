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

export async function resolveSchemaAssertDriftScan(
  _pointer: Record<string, unknown>
): Promise<ResolverResult> {
  const tables = ["concept", "concept_edge", "concept_usage"];
  const asserts = await extractAsserts(tables);
  const { checked, drifts } = await collectDrifts(asserts);

  return {
    shape: "schemaAssertDrift",
    body: {
      checked,
      drifts,
      drift_count: drifts.length,
      checked_at: new Date().toISOString(),
    },
  };
}
