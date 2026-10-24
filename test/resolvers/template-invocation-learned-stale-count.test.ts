// THE RIBOSOME-EXTRACTION JOINT'S READING IS A TOP-LEVEL NUMBER ON A PURE TEMPLATE READ
// (template-invocation-history-report.ts A LEARNED-TRACK FRESHNESS CHECK). The joint-liveness detector arms a joint
// only when its binding's check { shape, input, field } reads a finite number, and the class-2 judge reads only
// top-level fields. No instrument returned the learned track's freshness, so the joint could not arm. With max_lag_sec
// the read answers stale_count (1 when the newest learned template lags the newest execution by more than
// max_lag_sec, else 0: measured against the newest execution, so an idle node is never read stale); without it the
// body is exactly what it was.
// MUST-FAIL on the parent (34852069): the report returns no stale_count and has no response contract.
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = mkdtempSync(join(tmpdir(), "tpl-learned-stale-"));
process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
const { resolveTemplateInvocationHistoryReport } = await import("../../src/resolvers/template-invocation-history-report.js");
const { checkArmingProblem, responseFields } = await import("../../src/resolvers/substrate-gap.js");

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

const NOW = Date.now();
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString();
/** Serves `rows` newest-first in pages, as activity-api's listing does, and executions newest-first at `execAgo`. */
const serve = (rows: Array<Record<string, unknown>>, execAgo: number[] = [0]) => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = new URL(typeof input === "string" ? input : input.toString());
    if (u.pathname.includes("/templates")) {
      const limit = Number(u.searchParams.get("limit") ?? 100), offset = Number(u.searchParams.get("offset") ?? 0);
      return Response.json({ templates: rows.slice(offset, offset + limit) });
    }
    return Response.json({ executions: execAgo.map((sec, i) => ({ activity_id: `act-${i}`, executed_at: ago(sec) })) });
  }) as unknown as typeof fetch;
};
const read = async (extra: Record<string, unknown> = {}) =>
  (await resolveTemplateInvocationHistoryReport({ type: "template_invocation_history_report", templatesUrl: "http://api/templates", tracesUrl: "http://api/execution-traces", ...extra } as never)).body as Record<string, unknown>;

const DAY = 86_400;
const plain = (i: number, sec: number) => ({ id: `plain-${i}`, created_at: ago(sec), tags: ["git.commit"] });

describe("template_invocation_history_report max_lag_sec (the ribosome-extraction joint)", () => {
  it("must-fail: the newest learned template older than max_lag_sec reads stale_count 1", async () => {
    serve([plain(1, 60), plain(2, 3600), { id: "activity:⟨learned-composition-a-to-b⟩", created_at: ago(5 * DAY), tags: ["ribosome.extracted"] }, plain(3, 6 * DAY)]);
    const b = await read({ max_lag_sec: DAY });
    expect(b["stale_count"]).toBe(1);
    expect(b["newest_learned_template_id"]).toBe("learned-composition-a-to-b");
    expect(Number.isFinite(b["newest_learned_age_sec"])).toBe(true);
  });

  it("must-fail: a fresh learned template reads stale_count 0 (zero when healthy), by id or by a ribosome tag", async () => {
    serve([plain(1, 60), { id: "learned-auto-bridge-x", created_at: ago(600) }, { id: "learned-old", created_at: ago(9 * DAY) }]);
    expect(await read({ max_lag_sec: DAY })).toMatchObject({ stale_count: 0, newest_learned_template_id: "learned-auto-bridge-x" });
    serve([{ id: "extracted-y", created_at: ago(120), tags: ["ribosome"] }]);
    expect((await read({ max_lag_sec: DAY }))["stale_count"]).toBe(0);
  });

  it("must-fail: no learned template at all, over the whole list, reads stale_count 1", async () => {
    serve([plain(1, 60), plain(2, 120)]);
    expect(await read({ max_lag_sec: DAY })).toMatchObject({ stale_count: 1, newest_learned_template_id: null });
  });

  it("a capped pull whose rows are all newer than the horizon cannot tell: no stale_count (unmeasured, never fresh)", async () => {
    serve(Array.from({ length: 30 }, (_, i) => plain(i, 60 + i)));
    const b = await read({ max_lag_sec: DAY, pageSize: 10, templateFetchCap: 20 });
    expect("stale_count" in b).toBe(false);
    // The same capped pull that reached past the horizon can: the newest learned row would have been seen.
    serve(Array.from({ length: 30 }, (_, i) => plain(i, i * DAY)));
    expect((await read({ max_lag_sec: DAY, pageSize: 10, templateFetchCap: 20 }))["stale_count"]).toBe(1);
  });

  it("must-fail: the response contract declares every key of both bodies, and stale_count needs max_lag_sec", async () => {
    serve([plain(1, 60), { id: "learned-x", created_at: ago(5 * DAY) }]);
    for (const k of [...Object.keys(await read()), ...Object.keys(await read({ max_lag_sec: DAY }))]) expect(responseFields("template_invocation_history_report") ?? []).toContain(k);
    const er = (input: Record<string, unknown>) => ({ shape: "template_invocation_history_report", input, zero_field: "stale_count" });
    expect(checkArmingProblem(er({ max_lag_sec: DAY }))).toBeNull();
    expect(checkArmingProblem(er({}))?.position).toBe("evidence_resolve.zero_field");
  });

  it("must-fail: the lag is measured against the newest execution, not the clock: an idle node is not read stale", async () => {
    // Executions stopped 3 h ago; the newest learned template is 1 h older than the newest execution.
    serve([plain(1, 3 * 3600 + 60), { id: "learned-composition-c", created_at: ago(4 * 3600) }, plain(2, 9 * DAY)], [3 * 3600, 5 * 3600]);
    const b = await read({ max_lag_sec: 2 * 3600 });
    expect(b).toMatchObject({ stale_count: 0, newest_learned_template_id: "learned-composition-c", newest_learned_age_sec: 3600 });
    expect(b["newest_execution_at"]).toBe(ago(3 * 3600));
    // The same template 3 h behind the newest execution is stale at a 2 h lag.
    serve([{ id: "learned-composition-c", created_at: ago(6 * 3600) }, plain(2, 9 * DAY)], [3 * 3600]);
    expect(await read({ max_lag_sec: 2 * 3600 })).toMatchObject({ stale_count: 1, newest_learned_age_sec: 3 * 3600 });
  });

  it("no execution time read: no stale_count (unmeasured, never fresh)", async () => {
    serve([{ id: "learned-x", created_at: ago(9 * DAY) }], []);
    expect("stale_count" in (await read({ max_lag_sec: DAY }))).toBe(false);
  });

  it("control: without max_lag_sec the body carries exactly the fields it always did", async () => {
    serve([plain(1, 60), { id: "learned-x", created_at: ago(5 * DAY) }]);
    const b = await read();
    expect(Object.keys(b).sort()).toEqual(["completed_at", "fired_count", "health_verdict", "total_templates", "unfired_capabilities", "unfired_count", "unfired_ratio"]);
  });
});
