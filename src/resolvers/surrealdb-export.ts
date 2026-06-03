import { mkdirSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import type { ResolverResult } from "./types.js";

/**
 * surrealdb_export — substrate-citizen primitive to dump SurrealDB table rows
 * to JSONL files in the bind-mounted /workspace, so learning state survives
 * container destruction. Closes Gap A from iter 2026-06-03:
 * SurrealDB lives at /var/lib/surrealdb/data.db INSIDE substrate-live, so
 * `docker rm substrate-live` loses every Thompson posterior, every concept,
 * every execution trace. /workspace is bind-mounted from the host. Exporting
 * there + committing the manifest to Git gives us a recoverable snapshot
 * chain independent of the container's own filesystem.
 *
 * Auth: uses SURREALDB_USERNAME + SURREALDB_PASSWORD from env (root for the
 * substrate's single-container setup; see scripts/substrate/units/surrealdb.service).
 * Tries Basic auth (SurrealDB's documented HTTP signin) — if it fails, falls
 * back to Bearer for completeness. SurrealDB /sql is namespace+database
 * scoped via NS / DB headers.
 *
 * Immunity-pattern: one server-side resolver, no LLM, no pool iteration,
 * empty inputShapes.
 */
export interface SurrealdbExportPointer {
  type: "surrealdb_export";
  tables?: string[];
  surrealUrl?: string;
  output_dir?: string;
  rowCap?: number;
}

const DEFAULT_TABLES = [
  "activity_template",
  "activity_execution_traces",
  "activity_metrics",
  "concept",
  "substrate_gap",
];

const DEFAULT_ROW_CAP = 100_000;
const DEFAULT_SURREAL_URL = "http://127.0.0.1:8000";

function isoCompactTs(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}

function basicAuthHeader(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

interface SurrealQueryResult {
  status?: string;
  result?: unknown;
  detail?: string;
}

export async function resolveSurrealdbExport(
  p: SurrealdbExportPointer,
): Promise<ResolverResult> {
  const tables = p.tables ?? DEFAULT_TABLES;
  const rowCap = p.rowCap ?? DEFAULT_ROW_CAP;
  const surrealUrl = (p.surrealUrl ?? process.env["SURREALDB_URL"] ?? DEFAULT_SURREAL_URL).replace(/\/+$/, "");
  const ns = process.env["SURREALDB_NAMESPACE"] ?? "activity-system";
  const db = process.env["SURREALDB_DATABASE"] ?? "learning_loop";
  const user = process.env["SURREALDB_USERNAME"] ?? "root";
  const pass = process.env["SURREALDB_PASSWORD"] ?? process.env["SURREAL_PASS"] ?? "";

  if (!pass) {
    return {
      shape: "structuredError",
      body: {
        resolver: "surrealdb_export",
        detail: "SURREALDB_PASSWORD/SURREAL_PASS not set",
        failure_mode: "cascading",
      },
    };
  }

  const outputDir = p.output_dir ?? `/workspace/snapshots/${isoCompactTs()}`;
  try {
    mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    return {
      shape: "structuredError",
      body: {
        resolver: "surrealdb_export",
        detail: `failed to create output_dir ${outputDir}: ${(err as Error).message}`,
        failure_mode: "cascading",
      },
    };
  }

  const perTable: Array<{
    table: string;
    rows_written: number;
    bytes: number;
    file: string;
    error?: string;
  }> = [];
  let totalBytes = 0;
  let totalRows = 0;

  for (const table of tables) {
    // Reject non-ident table names (defense-in-depth; tables come from caller).
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      perTable.push({ table, rows_written: 0, bytes: 0, file: "", error: "invalid table name" });
      continue;
    }
    const query = `SELECT * FROM ${table} LIMIT ${rowCap};`;
    let res: Response;
    try {
      res = await fetch(`${surrealUrl}/sql`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          // SurrealDB 2.x expects lowercase hyphenated headers; the old
          // NS/DB names from 1.x return 400 "Specify a namespace".
          "surreal-ns": ns,
          "surreal-db": db,
          "Authorization": basicAuthHeader(user, pass),
        },
        body: query,
      });
    } catch (err) {
      perTable.push({
        table,
        rows_written: 0,
        bytes: 0,
        file: "",
        error: `fetch failed: ${(err as Error).message}`,
      });
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      perTable.push({
        table,
        rows_written: 0,
        bytes: 0,
        file: "",
        error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
      });
      continue;
    }
    let parsed: SurrealQueryResult[];
    try {
      parsed = (await res.json()) as SurrealQueryResult[];
    } catch (err) {
      perTable.push({
        table,
        rows_written: 0,
        bytes: 0,
        file: "",
        error: `parse: ${(err as Error).message}`,
      });
      continue;
    }
    const first = Array.isArray(parsed) ? parsed[0] : undefined;
    const rows: unknown[] = Array.isArray(first?.result) ? (first!.result as unknown[]) : [];
    const filePath = join(outputDir, `${table}.jsonl`);
    let bytes = 0;
    try {
      const lines = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");
      writeFileSync(filePath, lines, { encoding: "utf-8" });
      try { bytes = statSync(filePath).size; } catch { bytes = lines.length; }
    } catch (err) {
      perTable.push({
        table,
        rows_written: 0,
        bytes: 0,
        file: filePath,
        error: `write: ${(err as Error).message}`,
      });
      continue;
    }
    perTable.push({ table, rows_written: rows.length, bytes, file: filePath });
    totalRows += rows.length;
    totalBytes += bytes;
  }

  return {
    shape: "surrealdbExportResult",
    body: {
      output_dir: outputDir,
      surreal_url: surrealUrl,
      namespace: ns,
      database: db,
      tables: perTable,
      total_rows: totalRows,
      total_bytes: totalBytes,
      exported_at: new Date().toISOString(),
    },
  };
}
