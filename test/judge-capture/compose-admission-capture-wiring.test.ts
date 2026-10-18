// WIRING PIN: EVERY feature_compose ADMISSION DECISION IS RECORDED (routing capture, build 7 part 1).
//
// The routing corpus replays admission from composeAdmission records, so a decision the compose takes without
// writing one is a decision the corpus never sees. A pure-module test cannot notice a call site being dropped; this
// pin reads resolveFeatureCompose's source and fails when:
//   - feature-compose.ts stops importing recordComposeAdmission from the closed recorder;
//   - the helper stops calling recordComposeAdmission with the lane and no scope port;
//   - any return between the stored-row read and the admitted path (the check-supply ledger re-read failures, and the
//     refusal the admission core decided: store unreadable, gap missing, operator hold, ineligible) is not preceded,
//     since the previous return, by a refused admissionCapture naming its stage; the core's refusal is recorded with
//     the core's stage;
//   - the admitted path stops arming admittedCapture, or any exit between admission and drafting (spend envelope,
//     landing lease, duplicate slot, capacity) stops calling admittedCapture?.(false);
//   - the drafting start (resolveFeatureComposeUncapped) is not preceded by admittedCapture?.(true);
//   - the capture moves into the frozen post-assembly region (from `const exactOps` on).
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "feature-compose.ts"), "utf8");

/** The text between two markers (each must occur exactly once). */
function between(text: string, start: string, end: string): string {
  const a = text.indexOf(start);
  expect(a, `marker not found: ${start}`).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(start, a + 1), `marker not unique: ${start}`).toBe(-1);
  const b = text.indexOf(end, a + start.length);
  expect(b, `end marker not found after start: ${end}`).toBeGreaterThan(a);
  return text.slice(a, b + end.length);
}
/** For each `return {` in a segment, the text since the previous return (or the segment start). */
function returnPreludes(segment: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (let i = segment.indexOf("return {"); i >= 0; i = segment.indexOf("return {", i + 1)) {
    out.push(segment.slice(from, i));
    from = i + 1;
  }
  return out;
}

const PRE_START = "const supplyMarker = csa.checkSupplyMarkerOf(pointer);";
const ADMISSION_END = "admittedCapture = (draftingStarted) => admissionCapture({ decision: \"admitted\", draftingStarted, stage: null,";
// The drafting start: the uncapped body called with the pointer it runs with (an observe compose's is land:false,
// skip_push:true; compose-observe.ts observeComposePointer).
const DRAFT_START = "const outcome = await resolveFeatureComposeUncapped(observeComposePointer(pointer));";

describe("feature_compose admission writes a composeAdmission record at every decision", () => {
  it("[MUST-FAIL] the recorder is imported from the closed src/judge/routing-capture.ts", () => {
    expect(SRC).toMatch(/^import \{[^}]*\brecordComposeAdmission\b[^}]*\} from "\.\.\/judge\/routing-capture\.js";$/m);
  });

  it("[MUST-FAIL] every refusal from the stored-row read to the admitted path is recorded with its stage", () => {
    const pre = between(SRC, PRE_START, ADMISSION_END);
    expect(pre).toMatch(/const admissionCapture = \([\s\S]*?\)[^=]*=>\s*recordComposeAdmission\(\{ gapId: _gapIdForSlot, lane, [^}]*\bscope: null\b[^}]*\}\);/);
    const preludes = returnPreludes(pre);
    // two check-supply ledger re-read failures, then the refusal the admission core decided
    expect(preludes.length).toBe(3);
    expect(preludes[0]).toContain('admissionCapture({ decision: "refused", draftingStarted: false, stage: "check_supply_ledger_unreadable"');
    expect(preludes[1]).toContain('admissionCapture({ decision: "refused", draftingStarted: false, stage: "check_supply_gap_missing"');
    expect(preludes[2]).toContain("const admission = composeAdmission(admissionInput);");
    expect(preludes[2]).toContain('admissionCapture({ decision: "refused", draftingStarted: false, stage: admission.refusal.stage,');
  });

  it("[MUST-FAIL] the admitted path arms the capture, and every exit before drafting records drafting_started false", () => {
    const after = between(SRC, ADMISSION_END, DRAFT_START);
    const preludes = returnPreludes(after);
    expect(preludes.length).toBe(4); // spend envelope, landing lease, duplicate slot, capacity
    for (const p of preludes) expect(p).toContain("admittedCapture?.(false);");
    const tail = after.slice(after.lastIndexOf("return {"));
    expect(tail).toContain("admittedCapture?.(true);");
    expect(tail.indexOf("admittedCapture?.(true);")).toBeLessThan(tail.indexOf(DRAFT_START));
  });

  it("[MUST-FAIL] the capture lives outside the frozen post-assembly region", () => {
    const frozen = SRC.slice(SRC.indexOf("  const exactOps: PlanOp[] | null = (() => {"));
    expect(frozen.length).toBeGreaterThan(0);
    for (const s of ["recordComposeAdmission", "captureAdmission", "admittedCapture", "admissionCapture"]) expect(frozen).not.toContain(s);
  });
});
