import { describe, it, expect, afterEach } from "bun:test";
import { resolveSurrealdbImport } from "../../src/resolvers/surrealdb-import.js";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const savedFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = savedFetch; });

describe("surrealdb_import resolver", () => {
  it("dry_run counts rows without making fetch calls", async () => {
    const dir = join(tmpdir(), `sb-import-dry-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "activity_template.jsonl"), `{"id":"a:1"}\n{"id":"a:2"}\n`);
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; return new Response("[]", { status: 200 }); }) as unknown as typeof fetch;
    const result = await resolveSurrealdbImport({
      type: "surrealdb_import",
      input_dir: dir,
      dry_run: true,
    });
    expect(result.shape).toBe("surrealdbImportResult");
    const body = result.body as { tables: Array<{ rows_imported: number }> };
    expect(body.tables[0]!.rows_imported).toBe(2);
    expect(fetchCalled).toBe(false);
  });

  it("refuses when input_dir does not exist", async () => {
    const result = await resolveSurrealdbImport({
      type: "surrealdb_import",
      input_dir: "/nonexistent/path/abcd1234",
    });
    expect(result.shape).toBe("structuredError");
  });

  it("counts already-exists rows as rows_skipped, not errors", async () => {
    process.env["SURREALDB_PASSWORD"] = "test-pass";
    const dir = join(tmpdir(), `sb-import-dup-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "concept.jsonl"), `{"id":"concept:1"}\n{"id":"concept:2"}\n`);
    let callIdx = 0;
    globalThis.fetch = (async () => {
      callIdx += 1;
      // First call OK, second is a duplicate
      if (callIdx === 1) {
        return new Response(JSON.stringify([{ status: "OK", result: [] }]), { status: 200 });
      }
      return new Response(
        JSON.stringify([{ status: "ERR", detail: "Database record `concept:2` already exists" }]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const result = await resolveSurrealdbImport({
      type: "surrealdb_import",
      input_dir: dir,
    });
    expect(result.shape).toBe("surrealdbImportResult");
    const body = result.body as { tables: Array<{ rows_imported: number; rows_skipped: number; errors: string[] }> };
    expect(body.tables[0]!.rows_imported).toBe(1);
    expect(body.tables[0]!.rows_skipped).toBe(1);
    expect(body.tables[0]!.errors.length).toBe(0);
    delete process.env["SURREALDB_PASSWORD"];
  });
});
