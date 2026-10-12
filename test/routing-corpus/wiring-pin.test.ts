// PROTECTED: feature_compose's admission is decided by the entry the routing corpus pins (DESIGN §6.3). A corpus-green
// rule production does not call is a hollow gate, so this reads src/resolvers/feature-compose.ts as text and asserts, by
// anchor (never by line):
//   - the admission block builds the composeAdmission record and asks compose-admission-core's composeAdmission, and a
//     refusal is rendered by the core and returned;
//   - it does so after the stored row and its hold are read, and before the spend envelope, the slot, the landing lease
//     and any drafting (the drafter's context assembly);
//   - the floor's inline refusals (now the core's floor and renderer) are gone from feature-compose.ts.
// Every anchor must be FOUND: a missing anchor is red, never vacuous. Each assertion is shown red on a mutant.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FC = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "feature-compose.ts"), "utf8");

const ANCHORS = {
  held: "const held = (stored?.classification_metadata as { operator_hold?: unknown } | undefined)?.operator_hold === true;",
  record: 'schema: 1, entry: "composeAdmission", gap_id: _gapIdForSlot, lane, land, supply_marker: !!supplyMarker,',
  load: 'const { composeAdmission, renderAdmissionRefusal } = await import("./compose-admission-core.js");',
  ask: "const admission = composeAdmission(admissionInput);",
  branch: "if (!admission.admit && admission.refusal) {",
  render: "const r = renderAdmissionRefusal(admissionInput, admission.refusal);",
  lease: "      landingLeaseGap = _gapIdForSlot;\n      admittedCapture = (draftingStarted) => admissionCapture(",
  envelope: 'const { spendEnvelopeAllows } = await import("../judge/gap-policy.js");',
  drafter: 'const { planDrafterReads, assembleDrafterContext } = await import("../drafter/index.js");',
};
/** The floor's refusals as they were inline. None may come back as a local copy beside the core. */
const MOVED = [
  "is under operator_hold`);",
  "hold_state_unreadable (gap store unreadable; failing closed)",
  "check_supply_gap_missing (a check_supply compose names a gap the store does not hold)",
  "check_supply_ledger_unreadable (gap store unreadable or timed out; failing closed)",
  "is ineligible (${why})",
  "check_supply ${verdict.why})",
];

export function wiringOffences(text: string): string[] {
  const bad: string[] = [];
  const at: Record<string, number> = {};
  for (const [k, a] of Object.entries(ANCHORS)) {
    at[k] = text.indexOf(a);
    if (at[k]! < 0) bad.push(`anchor not found: ${k}`);
    else if (text.indexOf(a, at[k]! + 1) >= 0 && k !== "envelope") bad.push(`anchor not unique: ${k}`);
  }
  for (const m of MOVED) if (text.includes(m)) bad.push(`moved refusal back in feature-compose.ts: ${m}`);
  const order = ["held", "record", "load", "ask", "branch", "render", "lease", "envelope", "drafter"];
  for (let i = 1; i < order.length; i++) if (!(at[order[i - 1]!]! < at[order[i]!]!)) bad.push(`${order[i - 1]} is not before ${order[i]}`);
  if (at.branch! - at.ask! > 200 || at.render! - at.branch! > 200) bad.push("the refusal branch does not immediately follow the admission");
  return bad;
}

describe("wiring pin: feature_compose admits through compose-admission-core", () => {
  test("every anchor found, in order, no moved refusal left", () => { expect(wiringOffences(FC)).toEqual([]); });
  test("MUTANT the decision skipped is red", () => {
    expect(wiringOffences(FC.replace(ANCHORS.ask, "const admission = { admit: true, refusal: null };")).length).toBeGreaterThan(0);
  });
  test("MUTANT a local copy of the hold refusal is red", () => {
    const m = FC.replace(ANCHORS.record, `${ANCHORS.record}\n      ...(held ? (() => { console.log(\`x is under operator_hold\`); return {}; })() : {}),`);
    expect(wiringOffences(m).length).toBeGreaterThan(0);
  });
  test("MUTANT the admission moved after the spend envelope is red", () => {
    const block = FC.slice(FC.indexOf(ANCHORS.load), FC.indexOf(ANCHORS.lease));
    const m = FC.replace(block, "").replace(ANCHORS.envelope, `${ANCHORS.envelope}\n${block}`);
    expect(wiringOffences(m).length).toBeGreaterThan(0);
  });
  test("MUTANT a refusal not rendered by the core is red", () => {
    expect(wiringOffences(FC.replace(ANCHORS.render, "const r = { log: \"x\", body: {} };")).length).toBeGreaterThan(0);
  });
});
