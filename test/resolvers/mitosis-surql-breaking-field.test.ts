import { describe, it, expect } from "bun:test";
import { surqlBreakingFieldRefusal } from "../../src/resolvers/vessel-mitosis-evaluate.js";

/**
 * A MIGRATION THAT PARSES CAN STILL BREAK EVERY WRITE TO ITS TABLE.
 *
 * On 2026-09-05 the compose path landed two bodies at one filename:
 *
 *   draft 1 (6ac1aa6)  DEFINE FIELD input_schema ON activity TYPE object;
 *                      -> VALID SQL. Applied. Broke every write to `activity`.
 *   draft 2 (a4b7f1b)  DEFINE FIELD input_schema IF NOT EXISTS;
 *                      -> unparseable. Never ran. INERT, harmless.
 *
 * Both passed `static_checks_pass`, because every check the gate runs is a TypeScript tool
 * and none of them opens a .surql file.
 *
 * THE ORDERING IS THE WHOLE POINT, and I got it backwards first: a syntax/parse gate refuses
 * draft 2 and PASSES draft 1. Draft 1 returns OK from any parser — it is well-formed SQL with
 * the wrong semantics. Checking that a migration parses is necessary and NOT sufficient.
 *
 * The bodies below are VERBATIM from `git show <sha>:sql/migrations/205-...`, not paraphrases,
 * so this suite fails if either real-world case stops being caught.
 *
 * HALF OF THESE TESTS PIN THE ABSTENTIONS. A false refusal blocks real work, which is worse
 * than letting one bad migration through — the same discipline as inertRegexEditRefusal.
 * Corpus-measured before shipping: 217 existing .surql files, 0 false positives.
 */
describe("surqlBreakingFieldRefusal — the third question for schema artifacts", () => {
  // ---- the two real cases ----

  it("REFUSES draft 1 verbatim — valid SQL that broke production", () => {
    const sql = [
      "DEFINE FIELD variant_reason ON activity TYPE string;",
      "DEFINE FIELD retired_at ON activity TYPE datetime;",
      "DEFINE FIELD retired_reason ON activity TYPE string;",
      "DEFINE FIELD input_schema ON activity TYPE object;",
      "DEFINE FIELD output_schema ON activity TYPE object;",
      "DEFINE FIELD schema_confidence ON activity TYPE float;",
    ].join("\n");
    const r = surqlBreakingFieldRefusal([{ path: "sql/migrations/205-x.surql", sql }]);
    expect(r).not.toBeNull();
    expect(r).toContain("variant_reason");
    expect(r).toContain("NON-OPTIONAL");
  });

  it("REFUSES draft 2 verbatim — the unparseable body, for a different stated reason", () => {
    const sql = [
      "DEFINE FIELD variant_reason IF NOT EXISTS;",
      "DEFINE FIELD retired_at IF NOT EXISTS;",
    ].join("\n");
    const r = surqlBreakingFieldRefusal([{ path: "sql/migrations/205-x.surql", sql }]);
    expect(r).not.toBeNull();
    expect(r).toContain("names no table");
  });

  it("ACCEPTS migration 206 — the repair that actually fixed the outage", () => {
    const sql =
      'DEFINE FIELD OVERWRITE input_schema ON activity TYPE option<object> FLEXIBLE\n  COMMENT "Structured input schema";\n' +
      'DEFINE FIELD OVERWRITE retired_at ON activity TYPE option<datetime>\n  COMMENT "When retired";';
    expect(surqlBreakingFieldRefusal([{ path: "sql/migrations/206-x.surql", sql }])).toBeNull();
  });

  // ---- abstentions: the gate must stay silent when the migration is safe ----

  it("ABSTAINS when a VALUE clause supplies a value (migration 055's real shape)", () => {
    const sql =
      "DEFINE FIELD IF NOT EXISTS retired ON activity TYPE bool\n  VALUE $value OR false\n  COMMENT \"retired\";";
    expect(surqlBreakingFieldRefusal([{ path: "m.surql", sql }])).toBeNull();
  });

  it("ABSTAINS when a DEFAULT clause supplies a value", () => {
    const sql = "DEFINE FIELD tags ON activity TYPE array<string> DEFAULT [];";
    expect(surqlBreakingFieldRefusal([{ path: "m.surql", sql }])).toBeNull();
  });

  it("ABSTAINS for a table created in the SAME file — no pre-existing rows to invalidate", () => {
    const sql = "DEFINE TABLE brand_new SCHEMAFULL;\nDEFINE FIELD a ON brand_new TYPE string;";
    expect(surqlBreakingFieldRefusal([{ path: "m.surql", sql }])).toBeNull();
  });

  it("ABSTAINS on nested paths — `tasks.*` types ARRAY ELEMENTS, not a column on every row", () => {
    // 5 of 6 initial corpus hits were this shape. Refusing them would have been wrong.
    const sql = "DEFINE FIELD impulse_resolutions.* ON activity_execution_traces TYPE object;";
    expect(surqlBreakingFieldRefusal([{ path: "m.surql", sql }])).toBeNull();
  });

  it("ABSTAINS on a field with no TYPE clause at all", () => {
    const sql = "DEFINE FIELD loose ON activity FLEXIBLE;";
    expect(surqlBreakingFieldRefusal([{ path: "m.surql", sql }])).toBeNull();
  });

  it("ABSTAINS on non-.surql files — this gate makes no claim about TypeScript", () => {
    const sql = "DEFINE FIELD x ON activity TYPE string;";
    expect(surqlBreakingFieldRefusal([{ path: "src/thing.ts", sql }])).toBeNull();
  });

  it("ABSTAINS on a commented-out example rather than reading it as code", () => {
    const sql = "-- DEFINE FIELD input_schema ON activity TYPE object;\nSELECT 1;";
    expect(surqlBreakingFieldRefusal([{ path: "m.surql", sql }])).toBeNull();
  });

  it("returns null on empty input and does not throw on junk", () => {
    expect(surqlBreakingFieldRefusal([])).toBeNull();
    expect(() => surqlBreakingFieldRefusal([{ path: "m.surql", sql: "" }])).not.toThrow();
    expect(surqlBreakingFieldRefusal([{ path: "m.surql", sql: ";;;;" }])).toBeNull();
  });

  // ---- discrimination: the property a parse-only gate does NOT have ----

  it("distinguishes the DESTRUCTIVE draft from the INERT one — a parser cannot", () => {
    // This is the test that justifies the gate's existence. A syntax check passes the first
    // and refuses the second, which is exactly backwards with respect to harm.
    const destructive = "DEFINE FIELD input_schema ON activity TYPE object;";
    const inert = "DEFINE FIELD input_schema IF NOT EXISTS;";
    const rd = surqlBreakingFieldRefusal([{ path: "a.surql", sql: destructive }]);
    const ri = surqlBreakingFieldRefusal([{ path: "b.surql", sql: inert }]);
    expect(rd).not.toBeNull();
    expect(ri).not.toBeNull();
    expect(rd).toContain("Found NONE"); // names the runtime symptom it prevents
    expect(rd).not.toEqual(ri); // and cites a different cause for each
  });

  // ---- found by probing the gate in production, 2026-09-05 ----

  it("REFUSES the real probe output — ANSI `ALTER TABLE … ADD COLUMN`, verbatim", () => {
    // Asked for a required column on an existing table, the drafter wrote MySQL, not SurrealDB.
    // The first version of this gate ABSTAINED here: it modelled one hazardous DEFINE FIELD
    // shape instead of asking whether the file is SurrealDB at all. It reached origin/dev with
    // verdict=FAVORABLE and would have failed on every boot forever.
    const sql = "ALTER TABLE impulse_resolution_metrics ADD COLUMN source_vessel STRING NOT NULL;\n";
    const r = surqlBreakingFieldRefusal([{ path: "sql/migrations/207-x.surql", sql }]);
    expect(r).not.toBeNull();
    expect(r).toContain("ANSI/MySQL");
  });

  it("REFUSES `ALTER TABLE … ADD` without the optional COLUMN keyword", () => {
    // In MySQL the COLUMN keyword is OPTIONAL, so matching `ADD COLUMN` alone leaves the
    // common short form to slip through — and the retry probe is reworded precisely so the
    // drafter does not repeat itself verbatim.
    const sql = "ALTER TABLE impulse_resolution_metrics ADD source_vessel STRING NOT NULL;\n";
    const r = surqlBreakingFieldRefusal([{ path: "m.surql", sql }]);
    expect(r).not.toBeNull();
    expect(r).toContain("ANSI/MySQL");
  });

  it("ABSTAINS on `ALTER TABLE … PERMISSIONS`, which SurrealDB 3.0.0 really uses", () => {
    // Migration 121 depends on this form. Blacklisting ALTER outright would refuse a real
    // migration — the corpus, not intuition, settled which half of ALTER is the hazard.
    const sql =
      "ALTER TABLE activity_execution_traces\n  PERMISSIONS FOR select WHERE org_id = $auth.org_id;";
    expect(surqlBreakingFieldRefusal([{ path: "m.surql", sql }])).toBeNull();
  });

  it("REFUSES the real 209 probe body — ANSI DDL buried inside a DEFINE EVENT, verbatim", () => {
    // Live drafter output, 2026-09-05 12:26. The gate DID refuse this in production, but on the
    // trailing `END` — the right verdict for the wrong reason. `DEFINE EVENT ... THEN ... END`
    // is legitimate SurrealDB, so that rule was a latent wedge; the hazard is the ANSI ADD.
    const sql =
      'DEFINE EVENT change_x ON TABLE impulse_resolution_metrics WHEN $event = "CREATE" THEN\n' +
      "  ALTER TABLE impulse_resolution_metrics ADD origin_vessel TEXT;\n" +
      '  UPDATE impulse_resolution_metrics SET origin_vessel = "" WHERE origin_vessel IS NONE;\n' +
      "END;";
    const r = surqlBreakingFieldRefusal([{ path: "sql/migrations/209-x.surql", sql }]);
    expect(r).not.toBeNull();
    expect(r).toContain("ANSI/MySQL"); // the RIGHT reason, not the incidental END
    expect(r).not.toContain('begins with "END"');
  });

  it("ABSTAINS on a legitimate DEFINE EVENT … THEN … END with no ANSI inside", () => {
    const sql =
      'DEFINE EVENT bump ON TABLE t WHEN $event = "UPDATE" THEN\n' +
      "  UPDATE t SET updated_at = time::now() WHERE id = $after.id;\n" +
      "END;";
    expect(surqlBreakingFieldRefusal([{ path: "m.surql", sql }])).toBeNull();
  });

  it("REFUSES any statement whose head verb is not SurrealDB", () => {
    const r = surqlBreakingFieldRefusal([
      { path: "m.surql", sql: "GRANT SELECT ON activity TO someone;" },
    ]);
    expect(r).not.toBeNull();
    expect(r).toContain("not a\nSurrealDB statement".replace("\n", " "));
  });

  it("ABSTAINS on the ordinary SurrealDB verbs a real migration uses", () => {
    // The fail-closed rule must not refuse the dialect it is protecting.
    const sql = [
      "BEGIN;",
      "DEFINE TABLE t SCHEMAFULL;",
      "DEFINE FIELD a ON t TYPE option<string>;",
      "DEFINE INDEX idx ON t FIELDS a;",
      "UPDATE t SET a = 'x' WHERE a IS NONE;",
      "REMOVE FIELD old ON t;",
      "REBUILD INDEX idx ON t;",
      "COMMIT;",
    ].join("\n");
    expect(surqlBreakingFieldRefusal([{ path: "m.surql", sql }])).toBeNull();
  });

  it("scans every staged file, not just the first", () => {
    const ok = { path: "1.surql", sql: "DEFINE FIELD a ON t TYPE option<string>;" };
    const bad = { path: "2.surql", sql: "DEFINE FIELD b ON t TYPE string;" };
    const r = surqlBreakingFieldRefusal([ok, bad]);
    expect(r).not.toBeNull();
    expect(r).toContain("2.surql");
  });
});
