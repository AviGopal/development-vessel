// THE WHOLE-FILE DEFAULT (gap-check-judge.ts testSuiteWholeFileDefault; qa ruling (iii), 2026-10-19). A test_suite check
// of one test_file that names no field read 'unknown' on every run (no fetch_error, no generic count key in a test_suite
// body), so it could never be measured, closed or falsified, and admission excluded it as unjudgeable. It now reads the
// file's cases: the named ones with only_tests (requested_not_passing), else all of them (total - pass).
// The real judge on a stub transport answering the vessel's own resolve endpoint; no source-text assertions.
import { describe, expect, it } from "bun:test";

delete process.env["GAP_STORE_ENDPOINT"];
const { evaluateGapCheck, testSuiteWholeFileDefault } = await import("../../src/judge/gap-check-judge.js");

type Row = Record<string, unknown>;
const answer = (body: Row) => (async () => Response.json({ shape: "test_suite", body })) as unknown as typeof fetch;
const judge = (er: Row, body: Row) => evaluateGapCheck({ id: "wf-default", classification_metadata: { evidence_resolve: er, falsifier: "class2" } }, { fetchImpl: answer(body) });
const FILE = { shape: "test_suite", input: { vessel: "super-repo", test_file: "validation/scripts/widget.check.sh" } };
const NAMED = { shape: "test_suite", input: { vessel: "super-repo", test_file: "validation/scripts/widget.check.sh", only_tests: ["a holds", "b holds"] } };

describe("a test_suite check of one file that names no field is answered by the whole-file default", () => {
  it("MUST-FAIL: a file with a failing case reads present", async () => {
    expect(await judge(FILE, { ran: true, total: 3, pass: 2, fail: 1, skip: 0 })).toBe("present");
  });
  it("MUST-FAIL: a file whose every case passes reads absent", async () => {
    expect(await judge(FILE, { ran: true, total: 3, pass: 3, fail: 0, skip: 0 })).toBe("absent");
  });
  it("MUST-FAIL: with only_tests and no field, requested_not_passing is read (present / absent)", async () => {
    expect(await judge(NAMED, { ran: true, total: 5, pass: 4, fail: 1, requested_not_passing: 1 })).toBe("present");
    expect(await judge(NAMED, { ran: true, total: 5, pass: 4, fail: 1, requested_not_passing: 0 })).toBe("absent");
  });
  it("a skipped case keeps the check present (skipping its assertions does not close it)", async () => {
    expect(await judge(FILE, { ran: true, total: 3, pass: 2, fail: 0, skip: 1 })).toBe("present");
  });
  it("a run that measured nothing stays unknown (no summary, measured:false, zero cases, no requested count)", async () => {
    expect(await judge(FILE, { ran: false, total: 0, pass: 0, fail: 0 })).toBe("unknown");
    expect(await judge(FILE, { ran: false, measured: false, why: "refused", total: 0, pass: 0, fail: 0 })).toBe("unknown");
    expect(await judge(FILE, { ran: true, total: 0, pass: 0, fail: 0 })).toBe("unknown");
    expect(await judge(NAMED, { ran: true, total: 5, pass: 4, fail: 1, requested_not_passing: null })).toBe("unknown");
  });
  it("control: without a test_file (a whole-suite run) a check naming no field stays unknown", async () => {
    const er = { shape: "test_suite", input: { vessel: "development-vessel" } };
    expect(testSuiteWholeFileDefault(er)).toBe(false);
    expect(await judge(er, { ran: true, total: 10, pass: 9, fail: 1 })).toBe("unknown");
  });
  it("control: a named zero_field is read exactly as before, not by the default", async () => {
    const er = { ...NAMED, zero_field: "requested_not_passing" };
    expect(testSuiteWholeFileDefault(er)).toBe(false);
    expect(await judge(er, { ran: true, total: 5, pass: 4, fail: 1, requested_not_passing: 0 })).toBe("absent");
  });
  it("control: another shape naming no field is untouched (still unknown)", async () => {
    const er = { shape: "git_log", input: { test_file: "x.test.ts" } };
    expect(testSuiteWholeFileDefault(er)).toBe(false);
    expect(await evaluateGapCheck({ id: "wf-other", classification_metadata: { evidence_resolve: er, falsifier: "class2" } }, { fetchImpl: (async () => Response.json({ shape: "commandResult", body: { exitCode: 0, stdout: "x" } })) as unknown as typeof fetch })).toBe("unknown");
  });
});
