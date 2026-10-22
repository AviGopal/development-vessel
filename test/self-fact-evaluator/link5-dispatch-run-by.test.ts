// LINK 5: A DISPATCH IS AN OPERATOR ACT IFF OUR SIDE RAN IT (USER RULING 2026-10-22, verbatim: "Yes, iff we ran it.
// Boredom, detectors or other instigators do not count."; USER RULING "Keep strict: unattributable (Recommended)").
// operator-acts.ts dispatchRunBy + link5DispatchFindings must classify EXACTLY as research's autonomy6
// (dispatcher_class + operator_dispatches_naming). PARITY: research's generated fixtures, copied verbatim to
// fixtures/parity-link5-fixtures.json (sha256 98d9b32e6f9946e7f57046a17f47c3aa984bf775dec75939ee3ee88ada696091, generated
// by autonomy6 sha256 e41a47000eefb86d369e8919668756a0823519c8085da652111fe219924bace9; no live key ids). DRAFT.
//   PARITY     all 34 class cases, all 11 naming cases and the unparseable-store case, row for row;
//   MUST-FAIL  a system-class key principal with no label is SYSTEM (rule 1 reads the key class map);
//   MUST-FAIL  a dispatch naming ANOTHER vessel's same-named file, or the bare vessel-relative path, does not count;
//   MUST-FAIL  in a closure: an OURS dispatch naming the gap is an operator act; an untagged principal-less one, or an
//              unread store, makes link 5 unattributable;
//   MUST-FAIL  under node_self only operator_label is read; expectation-scan (both forms) is a system dispatcher;
//   CONTROL    an unlisted key is OURS; a SYSTEM dispatch naming the gap is not an act.
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchRunBy, link5DispatchFindings, type KeyMapEntry } from "../../src/resolvers/operator-acts.js";
import { judgeRepairClosure, repairControlInputs } from "../../src/resolvers/self-fact-reconcile.js";

const FIXTURE = join(import.meta.dir, "fixtures", "parity-link5-fixtures.json");
const RAW = readFileSync(FIXTURE);
type Case = { name: string; record: unknown; expected_class: string };
type Naming = { name: string; store: unknown[]; gap_id: string; edit_site: string; window: [string, string] | null; expected_findings: string[] };
const FX = JSON.parse(RAW.toString("utf8")) as { keymap: Array<[string, string]>; system_dispatcher_ids: string[]; class_cases: Case[]; naming_cases: Naming[]; unparseable_store_case: { store_text: string; gap_id: string; edit_site: string; expected_findings: string[] } };
const KM: KeyMapEntry[] = FX.keymap.map(([id, owner_kind]) => ({ id, owner_kind }));
const win = (w: [string, string] | null): [number, number] | null => (w ? [Date.parse(w[0]), Date.parse(w[1])] : null);

describe("link 5 parity with research's autonomy6 (frozen fixtures)", () => {
  it("the fixture is research's, unchanged (sha256)", () => {
    expect(createHash("sha256").update(RAW).digest("hex")).toBe("98d9b32e6f9946e7f57046a17f47c3aa984bf775dec75939ee3ee88ada696091");
    expect(FX.class_cases.length).toBe(34);
    expect(FX.naming_cases.length).toBe(11);
  });
  it("PARITY: every class case classifies as research's dispatcher_class", () => {
    const mismatches = FX.class_cases.map((c) => ({ name: c.name, expected: c.expected_class, got: dispatchRunBy(c.record, KM).by.toLowerCase() })).filter((r) => r.expected !== r.got);
    expect(mismatches).toEqual([]);
  });
  it("PARITY: every naming case yields research's findings, in order", () => {
    const mismatches = FX.naming_cases.map((c) => ({ name: c.name, expected: c.expected_findings, got: link5DispatchFindings(c.store as never, c.gap_id, c.edit_site, win(c.window), KM).map((f) => f.finding) })).filter((r) => JSON.stringify(r.expected) !== JSON.stringify(r.got));
    expect(mismatches).toEqual([]);
  });
  it("PARITY: an unparseable store text naming the gap is unattributable", () => {
    const u = FX.unparseable_store_case;
    expect(link5DispatchFindings([u.store_text], u.gap_id, u.edit_site, null, KM).map((f) => f.finding)).toEqual(u.expected_findings);
  });
});

describe("link 5: who ran it, and what names the gap (qa parity fixes)", () => {
  it("MUST-FAIL (fix 1): a system-class key principal with no label is SYSTEM; with a human label, OURS", () => {
    expect(dispatchRunBy({ principal: { kind: "key", label: "key:key_SYSTEM_TEST" } }, KM).by).toBe("SYSTEM");
    expect(dispatchRunBy({ principal: { kind: "key", label: "key:key_SYSTEM_TEST" }, operator_label: "human-surface" }, KM).by).toBe("OURS");
  });
  it("MUST-FAIL (m3): under a node_self principal only operator_label is read; an operator field never decides", () => {
    expect({ field_only: dispatchRunBy({ principal: { kind: "node_self" }, operator: "human-surface" }, KM).by, label: dispatchRunBy({ principal: { kind: "node_self" }, operator: "rhythm-conductor-drain", operator_label: "human-surface" }, KM).by })
      .toEqual({ field_only: "SYSTEM", label: "OURS" });
  });
  it("MUST-FAIL (m4): operator:expectation-scan and its bare form expectation-scan are system dispatchers", () => {
    expect([dispatchRunBy({ operator: "operator:expectation-scan" }, KM).by, dispatchRunBy({ operator: "expectation-scan" }, KM).by, dispatchRunBy({ principal: { kind: "node_self" }, operator_label: "operator:expectation-scan" }, KM).by])
      .toEqual(["SYSTEM", "SYSTEM", "SYSTEM"]);
  });
  it("CONTROL (fix 1): an unlisted key, or an operator-class key, is OURS", () => {
    expect([dispatchRunBy({ principal: { kind: "key", label: "key:key_UNLISTED_0" } }, KM).by, dispatchRunBy({ principal: { kind: "key", label: "key:key_OPERATOR_TEST" } }, KM).by]).toEqual(["OURS", "OURS"]);
  });
  it("MUST-FAIL (fix 2): another vessel's same-named file, or the bare vessel-relative path, does not name the gap", () => {
    const site = "repos/goal-host-vessel/src/judge/thing.ts";
    const run = (goal: string) => link5DispatchFindings([{ dispatchId: "d", operator: "operator:qa-1", goal }], "some-system-gap-id-about-a-real-defect", site, null, KM).length;
    expect({ other_vessel: run("edit repos/local-tools-vessel/src/judge/thing.ts"), bare: run("edit src/judge/thing.ts"), qualified: run(`edit ${site}`), vessel_form: run("edit goal-host-vessel/src/judge/thing.ts") })
      .toEqual({ other_vessel: 0, bare: 0, qualified: 1, vessel_form: 1 });
  });
});

describe("link 5 in a repair closure", () => {
  const NOW = Date.parse("2026-10-22T12:00:00Z");
  const inp0 = repairControlInputs(NOW, false); // system-armed, otherwise clean: counts with no dispatch
  const gapId = String(inp0.row!["id"]);
  const closure = (dispatches: unknown[] | null) => judgeRepairClosure({ ...inp0, acts: { ...inp0.acts, dispatches } as never });
  const v = (j: ReturnType<typeof closure>) => ({ verdict: j.verdict, failing_link: j.failing_link ?? null });
  const at = NOW - 60 * 3600_000;
  it("MUST-FAIL: an OURS dispatch naming the gap is an operator act", () => {
    expect(v(closure([{ dispatchId: "d1", startedAt: at, operator: "operator:ac8b0aad", goal: `close ${gapId}` }]))).toEqual({ verdict: "not_counted", failing_link: "operator_act:operator-dispatch" });
  });
  it("MUST-FAIL: an untagged principal-less dispatch naming the gap, or an unread store, makes link 5 unattributable", () => {
    const u = (j: ReturnType<typeof closure>) => ({ verdict: j.verdict, why: j.reason.includes("link 5 UNATTRIBUTABLE") });
    expect({ untagged: u(closure([{ dispatchId: "d2", startedAt: at, goal: `close ${gapId}` }])), unread: u(closure(null)) }).toEqual({ untagged: { verdict: "unjudged", why: true }, unread: { verdict: "unjudged", why: true } });
  });
  it("CONTROL: a SYSTEM dispatch naming the gap is not an act", () => {
    expect(v(closure([{ dispatchId: "d3", startedAt: at, operator: "rhythm-conductor-drain", goal: `close ${gapId}` }]))).toEqual({ verdict: "counted", failing_link: null });
  });
});
