import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveSurrealdbExport } from "../../src/resolvers/surrealdb-export.js";
import { mkdirSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const savedPass = process.env["SURREALDB_PASSWORD"];
const savedSurreal = process.env["SURREAL_PASS"];
const savedFetch = globalThis.fetch;

beforeEach(() => {
  delete process.env["SURREALDB_PASSWORD"];
  delete process.env["SURREAL_PASS"];
});
afterEach(() => {
  if (savedPass === undefined) delete process.env["SURREALDB_PASSWORD"]; else process.env["SURREALDB_PASSWORD"] = savedPass;
  if (savedSurreal === undefined) delete process.env["SURREAL_PASS"]; else process.env["SURREAL_PASS"] = savedSurreal;
  globalThis.fetch = savedFetch;
});

describe("surrealdb_export resolver", () => {
  it("refuses when no SURREALDB_PASSWORD is set (cascading)", async () => {
    const out = join(tmpdir(), `sb-export-${Date.now()}`);
    const result = await resolveSurrealdbExport({ type: "surrealdb_export", output_dir: out });
    expect(result.shape).toBe("structuredError");
    expect((result.body as { failure_mode: string }).failure_mode).toBe("cascading");
  });

  it("writes JSONL per table using stubbed fetch", async () => {
    process.env["SURREALDB_PASSWORD"] = "test-pass";
    const out = join(tmpdir(), `sb-export-ok-${Date.now()}`);
    mkdirSync(out, { recursive: true });
    let callCount = 0;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      callCount += 1;
      const query = init?.body ?? "";
      // Each table returns one row
      const tableMatch = /FROM (\w+)/.exec(String(query));
      const table = tableMatch ? tableMatch[1] : "x";
      return new Response(
        JSON.stringify([{ status: "OK", result: [{ id: `${table}:1`, value: callCount }] }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const result = await resolveSurrealdbExport({
      type: "surrealdb_export",
      tables: ["activity_template", "concept"],
      output_dir: out,
    });
    expect(result.shape).toBe("surrealdbExportResult");
    const body = result.body as { total_rows: number; tables: Array<{ table: string; rows_written: number }> };
    expect(body.total_rows).toBe(2);
    expect(body.tables.length).toBe(2);
    expect(existsSync(join(out, "activity_template.jsonl"))).toBe(true);
    expect(existsSync(join(out, "concept.jsonl"))).toBe(true);
    const line = readFileSync(join(out, "activity_template.jsonl"), "utf-8").trim();
    expect(line).toContain("activity_template:1");
  });

  it("rejects invalid table names without making a fetch call", async () => {
    process.env["SURREALDB_PASSWORD"] = "test-pass";
    const out = join(tmpdir(), `sb-export-inv-${Date.now()}`);
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; return new Response("[]", { status: 200 }); }) as unknown as typeof fetch;
    const result = await resolveSurrealdbExport({
      type: "surrealdb_export",
      tables: ["bad name; DROP TABLE x"],
      output_dir: out,
    });
    expect(result.shape).toBe("surrealdbExportResult");
    const body = result.body as { tables: Array<{ error?: string }> };
    expect(body.tables[0]!.error).toContain("invalid table name");
    expect(fetchCalled).toBe(false);
  });
});
