// WIRING PIN: EVERY feature_compose ADMISSION DECISION IS RECORDED (routing capture, build 7 part 1).
//
// The routing corpus replays admission from composeAdmission records, so a decision the compose takes without
// writing one is a decision the corpus never sees. A pure-module test cannot notice a call site being dropped; this
// pin reads resolveFeatureCompose's source and fails when:
//   - feature-compose.ts stops importing recordComposeAdmission from the closed recorder;
//   - any return between the stored-row read and the admission block (the first check-supply ledger read, unreadable
//     or gap missing; hold_state_unreadable; operator_hold) is not preceded by a refused admissionCapture naming its
//     stage, or the helper stops calling recordComposeAdmission with the lane and no scope port;
//   - any return inside the admission block (refusals and check-supply ledger failures) is not preceded, since the
//     previous return, by captureAdmission("refused", false), or the helper stops calling recordComposeAdmission;
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
const ADMISSION_START = "if (stored && (pointer as { land?: boolean }).land !== false) {";
const ADMISSION_END = "landingLeaseGap = _gapIdForSlot;";
const DRAFT_START = "const outcome = await resolveFeatureComposeUncapped(pointer);";

describe("feature_compose admission writes a composeAdmission record at every decision", () => {
  it("[MUST-FAIL] the recorder is imported from the closed src/judge/routing-capture.ts", () => {
    expect(SRC).toMatch(/^import \{[^}]*\brecordComposeAdmission\b[^}]*\} from "\.\.\/judge\/routing-capture\.js";$/m);
  });

  it("[MUST-FAIL] every refusal before the admission block is recorded with its stage", () => {
    const pre = between(SRC, PRE_START, ADMISSION_START);
    expect(pre).toMatch(/const admissionCapture = \([\s\S]*?\)[^=]*=>\s*recordComposeAdmission\(\{ gapId: _gapIdForSlot, lane, [^}]*\bscope: null\b[^}]*\}\);/);
    const preludes = returnPreludes(pre);
    const stages = ["check_supply_ledger_unreadable", "check_supply_gap_missing", "hold_state_unreadable", "operator_hold"];
    expect(preludes.length).toBe(stages.length);
    preludes.forEach((p, i) => expect(p).toContain(`admissionCapture({ decision: "refused", draftingStarted: false, stage: "${stages[i]}"`));
  });

  it("[MUST-FAIL] every return inside the admission block is preceded by a refused capture", () => {
    const block = between(SRC, ADMISSION_START, ADMISSION_END);
    expect(block).toMatch(/const captureAdmission = \([^)]*\)[^=]*=>\s*admissionCapture\(\{[^}]*\}\);/);
    const preludes = returnPreludes(block);
    expect(preludes.length).toBe(4); // two ledger re-read failures, the check-supply refusal, the eligibility refusal
    for (const p of preludes) expect(p).toMatch(/captureAdmission\("refused", false(, "[a-z_]+")?\);/);
  });

  it("[MUST-FAIL] the admitted path arms the capture, and every exit before drafting records drafting_started false", () => {
    const after = between(SRC, ADMISSION_END, DRAFT_START);
    expect(after.slice(0, 200)).toContain('admittedCapture = (draftingStarted) => captureAdmission("admitted", draftingStarted);');
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
