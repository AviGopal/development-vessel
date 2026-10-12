// PROTECTED (MUST-FAIL): A CLOSED CHECK NEVER READS STATE THE OPEN RULES CONTROL AFTER THE CALL.
//
// composeAdmission (src/resolvers/compose-admission-core.ts) asks the open rules (src/judge-rules/routing-admission.ts
// admitCompose) and then clamps their answer against the input's scope port and renders any refusal. If the rules are
// handed the object the clamp reads afterwards, they can write the evidence that admits their own answer (insert a
// scope entry, then refuse naming it); if the clamp reads the rules' answer more than once, a getter can show the clamp
// one value and the renderer another. Either way an open rule writes refusal text, which the core exists to prevent.
//
// The rules are replaced (bun mock.module) by adversaries:
//   - a mutating rule that replaces the input's scope with a self-inserted entry and refuses naming it;
//   - a mutating rule that writes a forged entry INTO the caller's scope map (nested) and refuses naming it;
//   - a rule whose refusal reads as an offered entry twice and as a forged entry the third time (getter);
//   - a rule that rewrites the floor's evidence (stored / operator_hold / why) and admits.
// For each: the forged refusal is refused and the floor answers (fell_back), the caller's input is unchanged, and every
// floor-refused input stays refused with the floor's own stage. Controls: the mocked rules ARE consulted (a supported
// scope refusal is rendered), a non-mutating rule admits without falling back, and the rules see the input's values.
// MUTANT (seen red): a core that hands admitCompose its own working copy and clamps that copy after the call.
import { afterAll, describe, expect, mock, test } from "bun:test";

const RULES = "../../src/judge-rules/routing-admission.ts";
const CORE = "../../src/resolvers/compose-admission-core.ts";
// Snapshot (spread) before any mock.module: a namespace's bindings are re-pointed by mock.module.
const realRules = { ...(await import(RULES)) };
const core = await import(CORE);
afterAll(() => { mock.module(RULES, () => realRules); });

type Input = import("../../src/resolvers/compose-admission-core.ts").ComposeAdmissionInput;
const SITE = "repos/v/src/x.ts";
const OFFERED = "repos/v/src/";
const FORGED = "repos/";
const base: Input = {
  schema: 1, entry: "composeAdmission", gap_id: "route-mutation", lane: "undirected", land: true, supply_marker: false,
  stored: "present", operator_hold: false, why: null, supply_verdict: null, edit_site: SITE,
  scope: { [SITE]: null }, scope_reason: null, localization: null,
};
const floorRefused: Input[] = [
  { ...base, stored: "unreadable" }, { ...base, stored: "unreadable", supply_marker: true }, { ...base, stored: "absent", supply_marker: true },
  { ...base, operator_hold: true }, { ...base, why: "unarmed" }, { ...base, supply_verdict: { admit: false, why: "mismatch" } },
];
const withRules = (admitCompose: (i: any) => unknown) => { mock.module(RULES, () => ({ admitCompose })); };
const refusal = (excluded_by: string) => ({ admit: false, refusal: { stage: "scope_excluded", verdict: "REFUSED", excluded_by } });

/** One adversarial call: the decision, whether the caller's input changed, and the rendered refusal (if any). */
function ask(inp: Input) {
  const before = structuredClone(inp);
  const got = core.composeAdmission(inp);
  const rendered = got.refusal ? core.renderAdmissionRefusal(inp, got.refusal) : null;
  return { got, changed: JSON.stringify(inp) !== JSON.stringify(before), rendered };
}

describe("a mutating or shape-shifting rule cannot write the evidence its refusal is clamped against", () => {
  const adversaries: Array<[string, (i: any) => unknown]> = [
    ["self-inserted scope entry", (i) => { i.scope = { x: FORGED }; return refusal(FORGED); }],
    ["forged entry written into the scope map", (i) => { if (i.scope) i.scope[SITE] = FORGED; return refusal(FORGED); }],
    ["floor evidence rewritten, then admit", (i) => { i.stored = "present"; i.operator_hold = false; i.why = null; i.supply_verdict = { admit: true, why: null }; return { admit: true, refusal: null }; }],
  ];
  for (const [name, adv] of adversaries) {
    test(`${name}: the forged answer is refused, the floor answers, the caller's input is unchanged`, () => {
      withRules((i) => { try { return adv(i); } catch { return refusal(FORGED); } });
      const { got, changed, rendered } = ask(structuredClone(base));
      expect(changed).toBe(false);
      expect(rendered?.log ?? "").not.toContain(`excluded by ${FORGED})`);
      expect({ admit: got.admit, refusal: got.refusal }).toEqual({ admit: true, refusal: null });
      if (!name.startsWith("floor evidence")) expect(got.fell_back).toBe(true);
    });
    test(`${name}: every floor-refused input stays refused with the floor's own stage`, () => {
      withRules(adv);
      for (const raw of floorRefused) {
        const inp = structuredClone(raw);
        const { got, changed } = ask(inp);
        expect(changed).toBe(false);
        expect(got.admit).toBe(false);
        expect(got.refusal).toEqual(core.floorAdmission(structuredClone(raw)).refusal);
      }
    });
  }

  test("a refusal whose excluded_by reads as an offered entry twice and a forged one after is rendered as ONE value the clamp checked", () => {
    let reads = 0;
    withRules(() => {
      const r: Record<string, unknown> = { stage: "scope_excluded", verdict: "REFUSED" };
      Object.defineProperty(r, "excluded_by", { enumerable: true, get() { reads++; return reads <= 2 ? OFFERED : FORGED; } });
      return { admit: false, refusal: r };
    });
    const { got, rendered } = ask({ ...structuredClone(base), scope: { [SITE]: OFFERED } });
    // Either refused by the clamp (floor) or the offered entry: never the forged one.
    if (got.refusal) expect(got.refusal.excluded_by).toBe(OFFERED);
    expect(rendered?.log ?? "").not.toContain(`excluded by ${FORGED})`);
    expect(JSON.stringify(rendered?.body ?? {})).not.toContain(`scope entry ${FORGED} (`);
  });
});

describe("controls", () => {
  test("positive control: the mocked rules ARE consulted (a supported scope refusal is rendered)", () => {
    withRules(() => refusal(OFFERED));
    const { got, rendered } = ask({ ...structuredClone(base), scope: { [SITE]: OFFERED } });
    expect(got).toEqual({ admit: false, refusal: { stage: "scope_excluded", verdict: "REFUSED", excluded_by: OFFERED }, fell_back: false, events: [] });
    expect(rendered!.log).toContain(`excluded by ${OFFERED})`);
  });
  test("a non-mutating rule admits without falling back, and sees the input's values", () => {
    let seen: unknown;
    withRules((i) => { seen = JSON.parse(JSON.stringify(i)); return { admit: true, refusal: null }; });
    const inp = structuredClone(base);
    const { got, changed } = ask(inp);
    expect(changed).toBe(false);
    expect(got).toEqual({ admit: true, refusal: null, fell_back: false, events: [] });
    expect(seen).toEqual(JSON.parse(JSON.stringify(inp)));
  });
  test("the shipped rules answer as before (admit everything the floor admits)", () => {
    mock.module(RULES, () => realRules);
    expect(core.composeAdmission(structuredClone(base))).toEqual({ admit: true, refusal: null, fell_back: false, events: [] });
  });
});
