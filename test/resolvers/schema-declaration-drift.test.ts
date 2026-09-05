import { describe, it, expect } from "bun:test";
import { declarationDrift, confirmHazards } from "../../src/resolvers/schema-assert-drift-scan.js";

/**
 * WHAT THE MIGRATIONS SAY THE SCHEMA IS, VERSUS WHAT IT IS.
 *
 * Both halves of the 2026-09-05 incident are invisible to every other check — typecheck does
 * not parse .surql, and SurrealDB reports success either way:
 *
 *   MISSING  `activity` had 51 fields declared across sql/ and 54 live, with 6 declared
 *            fields absent. A write to an undeclared field on a SCHEMAFULL table is
 *            DISCARDED silently (success:true, HTTP 200). Commit cc81c2d wrote
 *            retired_reason correctly and every value was thrown away.
 *
 *   HAZARD   The mirror image. A non-option field with no DEFAULT/VALUE on a table that
 *            already has rows makes SurrealDB reject EVERY write omitting it. That took the
 *            trace store offline: 156 errors in 35 minutes.
 *
 * The fixtures below are the REAL declarations and the REAL live definitions from that day,
 * so this suite fails if either case stops being detected.
 */
const live = (t: string, fields: Record<string, string>) =>
  new Map([[t, new Map(Object.entries(fields))]]);

describe("declarationDrift — declared in sql/ vs live in INFO FOR TABLE", () => {
  it("REPORTS a declared field that does not exist live (the retired_reason case)", () => {
    const files = [
      {
        path: "sql/migrations/055-variant-tracking.surql",
        sql: "DEFINE FIELD IF NOT EXISTS retired_reason ON activity TYPE option<string>;",
      },
    ];
    const r = declarationDrift(files, live("activity", { retired: "DEFINE FIELD retired ON activity TYPE option<bool>" }));
    expect(r.missing).toHaveLength(1);
    expect(r.missing[0]).toMatchObject({
      table: "activity",
      field: "retired_reason",
      declared_in: "055-variant-tracking.surql",
    });
  });

  it("REPORTS a live non-optional field with no DEFAULT (the outage shape, and 070)", () => {
    // Verbatim from the live store: this one is still latent, harmless only because the
    // table has zero rows today.
    const r = declarationDrift(
      [],
      live("impulse_resolution_metrics", {
        org_id: "DEFINE FIELD org_id ON impulse_resolution_metrics TYPE string PERMISSIONS FULL",
      }),
    );
    expect(r.hazards).toHaveLength(1);
    expect(r.hazards[0]).toMatchObject({ table: "impulse_resolution_metrics", field: "org_id", type: "string" });
  });

  it("REPORTS the exact six fields that were missing on 2026-09-05", () => {
    const decls = ["retired_at", "retired_reason", "variant_reason", "input_schema", "output_schema", "schema_confidence"];
    const files = decls.map((d) => ({
      path: "sql/migrations/055-variant-tracking.surql",
      sql: `DEFINE FIELD IF NOT EXISTS ${d} ON activity TYPE option<string>;`,
    }));
    const r = declarationDrift(files, live("activity", { retired: "DEFINE FIELD retired ON activity TYPE option<bool>" }));
    expect(r.missing.map((m) => m.field).sort()).toEqual([...decls].sort());
  });

  // ---- abstentions: absence of evidence must never read as absence of drift ----

  it("ABSTAINS on a table it has no live picture of", () => {
    // Reporting every field of an unknown table as "missing" would bury the real signal.
    const files = [{ path: "m.surql", sql: "DEFINE FIELD a ON unknown_table TYPE string;" }];
    const r = declarationDrift(files, live("activity", {}));
    expect(r.missing).toHaveLength(0);
  });

  it("ABSTAINS on nested and array-element declarations", () => {
    // `tasks.*` types ARRAY ELEMENTS and INFO FOR TABLE reports them under a different key
    // shape; comparing them manufactures false drift.
    const files = [
      { path: "m.surql", sql: "DEFINE FIELD tasks.* ON activity TYPE object;" },
      { path: "m.surql", sql: "DEFINE FIELD tags[*] ON activity TYPE string;" },
    ];
    const r = declarationDrift(files, live("activity", {}));
    expect(r.missing).toHaveLength(0);
  });

  it("does NOT flag an option<> field, or one with DEFAULT or VALUE, as a hazard", () => {
    const r = declarationDrift(
      [],
      live("activity", {
        a: "DEFINE FIELD a ON activity TYPE option<string>",
        b: "DEFINE FIELD b ON activity TYPE array<string> DEFAULT []",
        c: "DEFINE FIELD c ON activity TYPE bool VALUE $value OR false",
      }),
    );
    expect(r.hazards).toHaveLength(0);
  });

  it("ignores non-.surql inputs and counts what it actually examined", () => {
    const files = [
      { path: "src/thing.ts", sql: "DEFINE FIELD x ON activity TYPE string;" },
      { path: "m.surql", sql: "DEFINE FIELD y ON activity TYPE option<string>;" },
    ];
    const r = declarationDrift(files, live("activity", {}));
    expect(r.declared_count).toBe(1); // only the .surql
    expect(r.missing.map((m) => m.field)).toEqual(["y"]);
    expect(r.tables_seen).toBe(1);
  });

  it("counts a field declared in several migrations once", () => {
    const files = [
      { path: "a.surql", sql: "DEFINE FIELD dup ON activity TYPE option<string>;" },
      { path: "b.surql", sql: "DEFINE FIELD OVERWRITE dup ON activity TYPE option<string>;" },
    ];
    const r = declarationDrift(files, live("activity", {}));
    expect(r.missing).toHaveLength(1);
  });

  it("returns empty, non-throwing results on empty input", () => {
    const r = declarationDrift([], new Map());
    expect(r).toEqual({
      missing: [],
      hazards: [],
      declared_count: 0,
      tables_seen: 0,
      schemafull_tables: 0,
    });
  });

  // ---- naming the denominator: without these the scan reported 254 items ----

  it("ABSTAINS on SCHEMALESS tables — an undeclared field there is accepted, not discarded", () => {
    // Unfiltered, the live store produced 140 'missing' and 114 'hazards'. Both populations
    // were wrong: discard only happens on SCHEMAFULL tables.
    const files = [{ path: "m.surql", sql: "DEFINE FIELD ghost ON loose_table TYPE string;" }];
    const live = new Map([["loose_table", new Map<string, string>()]]);
    expect(declarationDrift(files, live, new Set()).missing).toHaveLength(0);
    expect(declarationDrift(files, live, new Set(["loose_table"])).missing).toHaveLength(1);
  });

  it("matches a field SurrealDB backtick-quotes because it is a reserved word", () => {
    // `INFO FOR TABLE` keys reserved words with backticks, so `diff` comes back as "`diff`".
    // Comparing raw keys reported code_modification_proposal.diff and
    // substrate_tuning_param.value as MISSING when both exist — 2 of the first 4 findings,
    // a 50% false-positive rate that would have made this scan ignorable.
    const files = [
      { path: "m.surql", sql: "DEFINE FIELD diff ON code_modification_proposal TYPE string;" },
      { path: "m.surql", sql: "DEFINE FIELD value ON substrate_tuning_param TYPE string;" },
    ];
    const liveMap = new Map([
      ["code_modification_proposal", new Map([["`diff`", "DEFINE FIELD `diff` ON code_modification_proposal TYPE string"]])],
      ["substrate_tuning_param", new Map([["`value`", "DEFINE FIELD `value` ON substrate_tuning_param TYPE string"]])],
    ]);
    const r = declarationDrift(files, liveMap, new Set(["code_modification_proposal", "substrate_tuning_param"]));
    expect(r.missing).toHaveLength(0);
  });

  it("reports SCHEMAFULL count so the denominator is visible in the output", () => {
    const live = new Map([
      ["a", new Map<string, string>()],
      ["b", new Map<string, string>()],
    ]);
    const r = declarationDrift([], live, new Set(["a"]));
    expect(r.tables_seen).toBe(2);
    expect(r.schemafull_tables).toBe(1);
  });
});

describe("confirmHazards — a non-optional field is only dangerous if rows omit it", () => {
  const cand = [
    { table: "impulse_resolution_metrics", field: "org_id", type: "string" },
    { table: "activity", field: "input_schema", type: "object" },
  ];

  it("drops a candidate on an empty table and keeps one with violating rows", async () => {
    // org_id on a zero-row table is exactly the shape that broke nothing all day.
    const r = await confirmHazards(cand, async (t) => (t === "activity" ? 3886 : 0));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ table: "activity", field: "input_schema", violating_rows: 3886 });
  });

  it("DROPS a candidate whose count cannot be read — unmeasurable is not evidence", async () => {
    const r = await confirmHazards(cand, async () => null);
    expect(r).toHaveLength(0);
  });

  it("returns nothing for no candidates", async () => {
    expect(await confirmHazards([], async () => 99)).toEqual([]);
  });
});
