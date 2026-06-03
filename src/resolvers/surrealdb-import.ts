import { readdirSync, readFileSync, statSync } from "fs";
import { join, basename } from "path";
import type { ResolverResult } from "./types.js";

/**
 * surrealdb_import — replay a snapshot directory produced by surrealdb_export
 * back into SurrealDB. Disaster-recovery counterpart to surrealdb_export.
 *
 * Reads <input_dir>/<table>.jsonl (one JSON row per line) and CREATEs each
 * row into the matching table. Pre-existing row ids cause SurrealDB to error
 * on CREATE — those rows are counted as rows_skipped (not a failure). This
 * makes the resolver idempotent across partial restores.
 *
 * Auth + connection match surrealdb_export. Use dry_run=true to count rows
 * without writing.
 */
export interface SurrealdbImportPointer {
  type: "surrealdb_import";
  input_dir: string;
  tables?: string[];
  surrealUrl?: string;
  dry_run?: boolean;
}

const DEFAULT_SURREAL_URL = "http://127.0.0.1:8000";

function basicAuthHeader(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

export async function resolveSurrealdbImport(
  p: SurrealdbImportPointer,
): Promise<ResolverResult> {
  if (!p.input_dir) {
    return {
      shape: "structuredError",
      body: { resolver: "surrealdb_import", detail: "input_dir required", failure_mode: "cascading" },
    };
  }
  let stat;
  try {
    stat = statSync(p.input_dir);
  } catch (err) {
    return {
      shape: "structuredError",
      body: {
        resolver: "surrealdb_import",
        detail: `input_dir not accessible: ${(err as Error).message}`,
        failure_mode: "cascading",
      },
    };
  }
  if (!stat.isDirectory()) {
    return {
      shape: "structuredError",
      body: { resolver: "surrealdb_import", detail: `${p.input_dir} is not a directory`, failure_mode: "cascading" },
    };
  }
  const surrealUrl = (p.surrealUrl ?? process.env["SURREALDB_URL"] ?? DEFAULT_SURREAL_URL).replace(/\/+$/, "");
  const ns = process.env["SURREALDB_NAMESPACE"] ?? "activity-system";
  const db = process.env["SURREALDB_DATABASE"] ?? "learning_loop";
  const user = process.env["SURREALDB_USERNAME"] ?? "root";
  const pass = process.env["SURREALDB_PASSWORD"] ?? process.env["SURREAL_PASS"] ?? "";
  const dryRun = p.dry_run === true;

  // Enumerate tables — explicit list wins, otherwise scan dir for *.jsonl.
  let tables: string[];
  if (p.tables && p.tables.length > 0) {
    tables = p.tables;
  } else {
    try {
      tables = readdirSync(p.input_dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => basename(f, ".jsonl"));
    } catch (err) {
      return {
        shape: "structuredError",
        body: {
          resolver: "surrealdb_import",
          detail: `readdir failed: ${(err as Error).message}`,
          failure_mode: "cascading",
        },
      };
    }
  }

  if (!dryRun && !pass) {
    return {
      shape: "structuredError",
      body: { resolver: "surrealdb_import", detail: "SURREALDB_PASSWORD/SURREAL_PASS not set", failure_mode: "cascading" },
    };
  }

  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    // SurrealDB 2.x uses lowercase hyphenated headers (the 1.x NS/DB
    // headers return 400 "Specify a namespace").
    "surreal-ns": ns,
    "surreal-db": db,
    ...(dryRun ? {} : { "Authorization": basicAuthHeader(user, pass) }),
  };

  const perTable: Array<{
    table: string;
    rows_imported: number;
    rows_skipped: number;
    errors: string[];
  }> = [];

  for (const table of tables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      perTable.push({ table, rows_imported: 0, rows_skipped: 0, errors: ["invalid table name"] });
      continue;
    }
    const filePath = join(p.input_dir, `${table}.jsonl`);
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch (err) {
      perTable.push({
        table,
        rows_imported: 0,
        rows_skipped: 0,
        errors: [`read: ${(err as Error).message}`],
      });
      continue;
    }
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const line of lines) {
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch (err) {
        errors.push(`parse: ${(err as Error).message}`);
        skipped += 1;
        continue;
      }
      if (dryRun) {
        imported += 1;
        continue;
      }
      // CREATE <table> CONTENT $body — driven via parameterized HTTP /sql.
      // If the row has an `id`, surrealdb will reject duplicate. We catch
      // that and bump rows_skipped instead of erroring the whole table.
      const query = `CREATE ${table} CONTENT ${JSON.stringify(row)};`;
      let res: Response;
      try {
        res = await fetch(`${surrealUrl}/sql`, { method: "POST", headers, body: query });
      } catch (err) {
        errors.push(`fetch: ${(err as Error).message}`);
        skipped += 1;
        if (errors.length > 50) break;
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (/already (exists|contains)/i.test(text) || /database record/i.test(text)) {
          skipped += 1;
        } else {
          errors.push(`HTTP ${res.status}: ${text.slice(0, 120)}`);
          skipped += 1;
        }
        if (errors.length > 50) break;
        continue;
      }
      // SurrealDB returns OK even on per-statement errors; check the status field.
      let parsed: Array<{ status?: string; detail?: string }>;
      try { parsed = (await res.json()) as Array<{ status?: string; detail?: string }>; }
      catch { parsed = []; }
      const first = Array.isArray(parsed) ? parsed[0] : undefined;
      if (first?.status === "ERR") {
        const detail = first.detail ?? "";
        if (/already (exists|contains)/i.test(detail) || /database record.*already/i.test(detail)) {
          skipped += 1;
        } else {
          errors.push(detail.slice(0, 120));
          skipped += 1;
          if (errors.length > 50) break;
        }
      } else {
        imported += 1;
      }
    }
    perTable.push({ table, rows_imported: imported, rows_skipped: skipped, errors });
  }

  return {
    shape: "surrealdbImportResult",
    body: {
      input_dir: p.input_dir,
      surreal_url: surrealUrl,
      namespace: ns,
      database: db,
      dry_run: dryRun,
      tables: perTable,
      imported_at: new Date().toISOString(),
    },
  };
}
