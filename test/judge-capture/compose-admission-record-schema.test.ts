// THE composeAdmission RECORD SCHEMA (routing capture, build 7 part 1).
//
// The routing corpus replays feature_compose admission from these records, so a record missing an input (above all
// the scope, the recorded port) cannot be replayed. Pinned here, on the closed recorder's pure builder and line writer:
//   - every record carries every required schema-1 key (lane included), typed, and no key outside the required and
//     additive optional sets (the one admission schema shared with the admission core's input);
//   - scope is either an object keyed by the gap's edit site (and its suspected real location), each value the port's
//     excluded_by verdict, with scope_reason null; or null with a non-empty scope_reason (no port was in hand). It is
//     never silently absent;
//   - armed and falsifier_class read the falsifier exactly as the eligibility predicate does;
//   - the line is `[fc-admission] {json}` and never exceeds 16 KB: an oversized record keeps every key and is marked
//     truncated.
import { describe, expect, it } from "bun:test";
import {
  buildComposeAdmissionRecord, composeAdmissionLine, COMPOSE_ADMISSION_ENTRY, COMPOSE_ADMISSION_LINE_TAG, COMPOSE_ADMISSION_SCHEMA,
  ROUTING_CAPTURE_MAX_BYTES, SCOPE_NOT_CONSULTED, COMPOSE_ADMISSION_REQUIRED_KEYS, COMPOSE_ADMISSION_OPTIONAL_KEYS, ADMISSION_REFUSAL_STAGES,
  type ComposeAdmissionInput,
} from "../../src/judge/routing-capture.js";
import { composeEligibilitySkipReason } from "../../src/judge/gap-eligibility.js";

const EDIT = "repos/fixture-vessel/src/compute.ts";
const SUSPECTED = "repos/fixture-vessel/src/other.ts";
const row = (meta: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ id: "capture-fixture-gap", status: "open", summary: "fixture", classification_metadata: meta, ...extra });
const input = (r: Record<string, unknown>, over: Partial<ComposeAdmissionInput> = {}): ComposeAdmissionInput => ({
  gapId: "capture-fixture-gap", lane: "undirected", row: r, why: composeEligibilitySkipReason(r), supply: null,
  decision: composeEligibilitySkipReason(r) ? "refused" : "admitted", draftingStarted: false, scope: null, ...over,
});
const REQUIRED = ["armed", "decision", "drafting_started", "edit_site", "entry", "falsifier_class", "gap_id", "lane", "schema", "scope", "scope_reason", "supply_exception", "why"];
const OPTIONAL = ["land", "localization", "operator_hold", "stage", "stored", "supply_marker", "supply_verdict", "truncated"];

/** The schema-1 contract a replay reads. Returns the problems found (empty = valid). */
function schemaProblems(rec: Record<string, unknown>): string[] {
  const p: string[] = [];
  for (const k of REQUIRED) if (!(k in rec)) p.push(`missing ${k}`);
  for (const k of Object.keys(rec)) if (!REQUIRED.includes(k) && !OPTIONAL.includes(k)) p.push(`unknown ${k}`);
  if (rec.lane !== "directed" && rec.lane !== "undirected") p.push("lane");
  if ("stage" in rec && rec.stage !== null && !(ADMISSION_REFUSAL_STAGES as readonly unknown[]).includes(rec.stage)) p.push("stage");
  for (const k of ["land", "supply_marker", "operator_hold"]) if (k in rec && typeof rec[k] !== "boolean") p.push(k);
  if ("stored" in rec && !["unreadable", "absent", "present"].includes(String(rec.stored))) p.push("stored");
  const sv = rec.supply_verdict as { admit?: unknown; why?: unknown } | null | undefined;
  if ("supply_verdict" in rec && sv !== null && (typeof sv !== "object" || typeof sv.admit !== "boolean" || (sv.why !== null && typeof sv.why !== "string"))) p.push("supply_verdict");
  if (rec.schema !== COMPOSE_ADMISSION_SCHEMA) p.push("schema");
  if (rec.entry !== COMPOSE_ADMISSION_ENTRY) p.push("entry");
  if (typeof rec.gap_id !== "string" || !rec.gap_id) p.push("gap_id");
  if (rec.edit_site !== null && typeof rec.edit_site !== "string") p.push("edit_site");
  if (rec.falsifier_class !== null && typeof rec.falsifier_class !== "string") p.push("falsifier_class");
  if (typeof rec.armed !== "boolean") p.push("armed");
  if (rec.why !== null && typeof rec.why !== "string") p.push("why");
  const se = rec.supply_exception as { admitted?: unknown; why?: unknown } | null | undefined;
  if (se !== null && (typeof se !== "object" || typeof se.admitted !== "boolean" || typeof se.why !== "string")) p.push("supply_exception");
  const sc = rec.scope as Record<string, unknown> | null | undefined;
  if (sc === null) { if (typeof rec.scope_reason !== "string" || !rec.scope_reason) p.push("scope_reason"); }
  else if (!sc || typeof sc !== "object" || Array.isArray(sc)) p.push("scope");
  else {
    for (const [k, v] of Object.entries(sc)) if (!k || (v !== null && typeof v !== "string")) p.push(`scope[${k}]`);
    if (rec.scope_reason !== null) p.push("scope_reason");
  }
  if (rec.decision !== "admitted" && rec.decision !== "refused") p.push("decision");
  if (typeof rec.drafting_started !== "boolean") p.push("drafting_started");
  if (rec.truncated !== undefined && rec.truncated !== true) p.push("truncated");
  return p;
}
const parseLine = (line: string): Record<string, unknown> => {
  expect(line.startsWith(`${COMPOSE_ADMISSION_LINE_TAG} {`)).toBe(true);
  return JSON.parse(line.slice(COMPOSE_ADMISSION_LINE_TAG.length + 1)) as Record<string, unknown>;
};

describe("composeAdmission record: schema 1", () => {
  it("[MUST-FAIL] a refused record with no scope port carries every schema key: scope null, and why in scope_reason", () => {
    const rec = buildComposeAdmissionRecord(input(row({ falsifier: "unresolvable", edit_site: EDIT })));
    expect(schemaProblems(rec as unknown as Record<string, unknown>)).toEqual([]);
    expect(rec).toEqual({
      schema: 1, entry: "composeAdmission", gap_id: "capture-fixture-gap", lane: "undirected", edit_site: EDIT, falsifier_class: "unresolvable",
      armed: false, why: "unarmed", supply_exception: null, scope: null, scope_reason: SCOPE_NOT_CONSULTED, decision: "refused", drafting_started: false,
    });
  });

  it("[MUST-FAIL] the scope records the port's verdict per path when a port is in hand, and the suspected location too", () => {
    const port = (p: string): string | null => (p === SUSPECTED ? "repos/fixture-vessel/src/" : null);
    const rec = buildComposeAdmissionRecord(input(row({ falsifier: { class: "CLASS2" }, edit_site: EDIT, suspected_real_location: SUSPECTED }), { scope: port, draftingStarted: true }));
    expect(schemaProblems(rec as unknown as Record<string, unknown>)).toEqual([]);
    expect(rec.scope).toEqual({ [EDIT]: null, [SUSPECTED]: "repos/fixture-vessel/src/" });
    expect(rec.scope_reason).toBeNull();
    expect(rec.falsifier_class).toBe("class2");
    expect(rec.armed).toBe(true);
    expect(rec.why).toBeNull();
    expect(rec.decision).toBe("admitted");
    expect(rec.drafting_started).toBe(true);
  });

  it("[MUST-FAIL] a record without an edit site, with a port in hand, carries an (empty) scope object", () => {
    const rec = buildComposeAdmissionRecord(input(row({ falsifier: "class1" }), { scope: () => null }));
    expect(schemaProblems(rec as unknown as Record<string, unknown>)).toEqual([]);
    expect(rec.edit_site).toBeNull();
    expect(rec.scope).toEqual({});
    expect(rec.scope_reason).toBeNull();
    expect(rec.why).toBe("no_edit_site");
  });

  it("[MUST-FAIL] the module's declared key sets are the schema this test pins", () => {
    expect([...COMPOSE_ADMISSION_REQUIRED_KEYS].sort()).toEqual([...REQUIRED].sort());
    expect([...COMPOSE_ADMISSION_OPTIONAL_KEYS].sort()).toEqual([...OPTIONAL].sort());
  });

  it("[MUST-FAIL] the additive optional fields are carried when given, and a pre-block refusal with no stored row reads the caller's edit site", () => {
    const rec = buildComposeAdmissionRecord({
      gapId: "capture-fixture-gap", lane: "directed", row: null, pointerGap: { id: "capture-fixture-gap", classification_metadata: { edit_site: EDIT } },
      why: null, supply: null, decision: "refused", draftingStarted: false, scope: null,
      stage: "hold_state_unreadable", land: true, supplyMarker: false, stored: "unreadable", operatorHold: false, supplyVerdict: null,
    });
    expect(schemaProblems(rec as unknown as Record<string, unknown>)).toEqual([]);
    expect(rec).toMatchObject({ lane: "directed", edit_site: EDIT, falsifier_class: null, armed: false, stage: "hold_state_unreadable", land: true, supply_marker: false, stored: "unreadable", operator_hold: false, supply_verdict: null });
    const bare = buildComposeAdmissionRecord(input(row({ falsifier: "class2", edit_site: EDIT })));
    for (const k of OPTIONAL) expect(k in bare).toBe(false);
  });

  it("armed agrees with the eligibility predicate's falsifier read on every falsifier shape", () => {
    for (const f of ["class1", "class2", "Class2", { class: "class1" }, "class3", "", undefined, { class: 2 }, null]) {
      const r = row({ falsifier: f, edit_site: EDIT });
      const rec = buildComposeAdmissionRecord(input(r));
      expect({ f, armed: rec.armed }).toEqual({ f, armed: composeEligibilitySkipReason(r) !== "unarmed" });
    }
  });

  it("the supply exception is carried as given", () => {
    const rec = buildComposeAdmissionRecord(input(row({ falsifier: "unresolvable", edit_site: EDIT }), { supply: { admitted: true, why: "ledger_match" }, decision: "admitted" }));
    expect(schemaProblems(rec as unknown as Record<string, unknown>)).toEqual([]);
    expect(rec.supply_exception).toEqual({ admitted: true, why: "ledger_match" });
    expect(rec.why).toBe("unarmed");
  });

  it("[MUST-FAIL] the line is `[fc-admission] {json}` and round-trips the record", () => {
    const rec = buildComposeAdmissionRecord(input(row({ falsifier: "class2", edit_site: EDIT })));
    expect(parseLine(composeAdmissionLine(rec))).toEqual(rec as unknown as Record<string, unknown>);
  });

  it("[MUST-FAIL] an oversized record is capped at 16 KB, keeps every key and is marked truncated", () => {
    const big = "x".repeat(20_000);
    const rec = buildComposeAdmissionRecord(input(row({ falsifier: "class2", edit_site: EDIT + big, suspected_real_location: SUSPECTED + big }), { why: big, supply: { admitted: false, why: big }, scope: () => big }));
    const line = composeAdmissionLine(rec);
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(ROUTING_CAPTURE_MAX_BYTES);
    const back = parseLine(line);
    expect(schemaProblems(back)).toEqual([]);
    expect(back.truncated).toBe(true);
    expect(back.gap_id).toBe("capture-fixture-gap");
    expect(back.decision).toBe("admitted");
    expect(Object.keys(back.scope as object).length).toBeGreaterThan(0);
  });

  it("[MUST-FAIL] the schema check itself reddens on a record missing scope (positive control)", () => {
    const rec = buildComposeAdmissionRecord(input(row({ falsifier: "class2", edit_site: EDIT }))) as unknown as Record<string, unknown>;
    const { scope: _drop, ...noScope } = rec;
    expect(schemaProblems(noScope)).not.toEqual([]);
    expect(schemaProblems({ ...rec, scope: [EDIT] })).toContain("scope");
    expect(schemaProblems({ ...rec, scope: null, scope_reason: "" })).toContain("scope_reason");
    const { lane: _lane, ...noLane } = rec;
    expect(schemaProblems(noLane)).toContain("missing lane");
    expect(schemaProblems({ ...rec, stage: "made_up" })).toContain("stage");
    expect(schemaProblems({ ...rec, extra_field: 1 })).toContain("unknown extra_field");
    expect(schemaProblems({ ...rec, scope: { [EDIT]: null }, scope_reason: "unread" })).toContain("scope_reason");
  });
});
