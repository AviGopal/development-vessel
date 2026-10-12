// PROTECTED: the captured -> replay adapter (compose-admission-core.ts composeAdmissionReplayOf) and the held-out
// contract (runner.ts heldoutReplay; cli.ts heldout).
//   - a field the replay needs that a record lacks, or carries as null where null is not a value, makes the record
//     UNREPLAYABLE with that field named, and it is never answered;
//   - records the capture (src/judge/routing-capture.ts buildComposeAdmissionRecord) writes, built exactly as the
//     admission block builds them, are replayable and replay to the decision they recorded;
//   - the output is [{record_hash, decision | null, unreplayable?}], one per input line, in order;
//   - MUTANT: an adapter that fills a missing field with a default answers an incomplete record, and is red here.
import { describe, expect, test } from "bun:test";
import { buildComposeAdmissionRecord, SCOPE_NOT_CONSULTED } from "../../src/judge/routing-capture.js";
import { composeAdmissionReplayOf } from "../../src/resolvers/compose-admission-core.js";
import { heldoutReplay, type Adapted, type HeldoutLine } from "./runner";

const line = (record_hash: string, input: unknown, over: Partial<HeldoutLine> = {}): HeldoutLine =>
  ({ record_hash, family: "routing_input", entry: "composeAdmission", delivered: null, input, ports: null, llm: null, ...over });
const ARMED = { id: "gap-x", status: "open", classification_metadata: { falsifier: { class: "class2" }, edit_site: "repos/v/src/x.ts" } };
/** A record built as the admission block builds it (same recorder, same fields). */
const rec = (o: Partial<Parameters<typeof buildComposeAdmissionRecord>[0]> = {}) => buildComposeAdmissionRecord({
  gapId: "gap-x", lane: "undirected", row: ARMED, why: null, supply: null, decision: "admitted", draftingStarted: true, scope: null,
  stage: null, land: true, supplyMarker: false, stored: "present", operatorHold: false, supplyVerdict: null, localization: null, ...o,
}) as unknown as Record<string, unknown>;
const omit = (o: Record<string, unknown>, k: string) => { const c = { ...o }; delete c[k]; return c; };

const INCOMPLETE: Array<[string, unknown, string]> = [
  ["no land", omit(rec(), "land"), "land"],
  ["no supply_marker", omit(rec(), "supply_marker"), "supply_marker"],
  ["no stored", omit(rec(), "stored"), "stored"],
  ["operator_hold null", { ...rec(), operator_hold: null }, "operator_hold"],
  ["no supply_verdict", omit(rec(), "supply_verdict"), "supply_verdict"],
  ["no localization", omit(rec(), "localization"), "localization"],
  ["scope null without a reason", { ...rec(), scope: null, scope_reason: null }, "scope_reason"],
  ["no lane", omit(rec(), "lane"), "lane"],
  ["a truncated record", { ...rec(), truncated: true }, "truncated"],
];

async function answeredIncomplete(adapters?: Record<string, (l: HeldoutLine) => Adapted>): Promise<string[]> {
  const res = await heldoutReplay(INCOMPLETE.map(([label, r]) => line(label, r)), adapters);
  return res.filter((r) => r.decision !== null).map((r) => r.record_hash);
}

describe("held-out adapter: a missing replay field is unreplayable, never defaulted", () => {
  for (const [label, r, field] of INCOMPLETE) {
    test(`${label}: unreplayable, naming ${field}`, () => {
      const a = composeAdmissionReplayOf(r);
      expect(a.ok).toBe(false);
      if (!a.ok) expect(a.unreplayable).toContain(field);
    });
  }
  test("no incomplete record is answered", async () => { expect(await answeredIncomplete()).toEqual([]); });
  test("MUTANT an adapter that defaults the optional fields answers incomplete records (red)", async () => {
    const defaulting: Record<string, (l: HeldoutLine) => Adapted> = {
      composeAdmission: (l) => {
        const i = { land: true, supply_marker: false, stored: "present", operator_hold: false, supply_verdict: null, localization: null, ...(l.input as Record<string, unknown>) };
        for (const k of ["land", "supply_marker", "stored", "operator_hold", "supply_verdict", "localization", "lane"]) if (i[k as keyof typeof i] === null || i[k as keyof typeof i] === undefined) (i as Record<string, unknown>)[k] = k === "lane" ? "undirected" : k === "stored" ? "present" : k === "supply_verdict" || k === "localization" ? null : false;
        delete (i as Record<string, unknown>).truncated;
        if ((i as Record<string, unknown>).scope === null && !(i as Record<string, unknown>).scope_reason) (i as Record<string, unknown>).scope_reason = "assumed";
        const a = composeAdmissionReplayOf(i);
        return a.ok ? { ok: true, input: a.input, ports: {}, llm: null } : a;
      },
    };
    expect((await answeredIncomplete(defaulting)).length).toBeGreaterThan(0);
  });
});

describe("records the capture writes replay to the decision they recorded", () => {
  const cases: Array<[string, Record<string, unknown>, { admit: boolean; stage: string | null }]> = [
    ["an admitted armed gap", rec(), { admit: true, stage: null }],
    ["an operator hold", rec({ decision: "refused", draftingStarted: false, stage: "operator_hold", operatorHold: true }), { admit: false, stage: "operator_hold" }],
    ["an unarmed gap", rec({ row: { id: "gap-x", status: "open", classification_metadata: {} }, why: "unarmed", decision: "refused", draftingStarted: false, stage: "ineligible" }), { admit: false, stage: "ineligible" }],
    ["an unreadable store", rec({ row: null, stored: "unreadable", decision: "refused", draftingStarted: false, stage: "hold_state_unreadable" }), { admit: false, stage: "hold_state_unreadable" }],
    ["a check-supply ledger that admits", rec({ row: { id: "gap-x", status: "open", classification_metadata: {} }, why: "unarmed", supplyMarker: true, supply: { admitted: true, why: "ledger_match" }, supplyVerdict: { admit: true, why: null } }), { admit: true, stage: null }],
  ];
  for (const [label, r, want] of cases) {
    test(`${label}: replayable, and the replay matches the record's decision`, async () => {
      expect(r.scope_reason).toBe(SCOPE_NOT_CONSULTED);
      const [out] = await heldoutReplay([line(label, r)]);
      expect(out!.unreplayable).toBeUndefined();
      const d = out!.decision as { admit: boolean; refusal: { stage: string } | null };
      expect({ admit: d.admit, stage: d.refusal?.stage ?? null }).toEqual(want);
      expect(d.admit).toBe(r.decision === "admitted");
    });
  }
  test("one answer per line, in order; a wrong family or entry is unreplayable", async () => {
    const res = await heldoutReplay([line("a", rec()), line("f", rec(), { family: "judge_input" }), line("e", rec(), { entry: "editIntent" })]);
    expect(res.map((r) => r.record_hash)).toEqual(["a", "f", "e"]);
    expect(res[1]).toEqual({ record_hash: "f", decision: null, unreplayable: ["family"] });
    expect(res[2]).toEqual({ record_hash: "e", decision: null, unreplayable: ["entry"] });
  });
});
