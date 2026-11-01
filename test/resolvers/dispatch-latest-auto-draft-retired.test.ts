import { describe, it, expect, afterEach } from "bun:test";
import { resolveDispatchLatestAutoDraft } from "../../src/resolvers/dispatch-latest-auto-draft.js";

// dispatch_latest_auto_draft lists candidates with ?q=gap-closing. activity-api answers that
// from its full-text path, which returns raw activity rows including retired ones, and
// posterior retirement sets `retired: true` without `deprecated`. A retired arm must never be
// picked or POSTed to light-dispatch /dispatch; deprecated arms stay skipped and live arms
// are still picked newest-first.

const originalFetch = globalThis.fetch;

type Row = { id: string; deprecated?: boolean; retired?: boolean };

function stub(rows: Row[], executedIds: string[] = []): { posted: string[] } {
  const posted: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/v2/activities/templates")) {
      return new Response(JSON.stringify({ templates: rows, total: rows.length, fts: true }), { status: 200 });
    }
    if (url.includes("/v2/activities/execution-traces")) {
      return new Response(JSON.stringify({ executions: executedIds.map((id) => ({ activity_id: id })) }), { status: 200 });
    }
    if (url.endsWith("/dispatch")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { template_id?: string };
      posted.push(String(body.template_id));
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { posted };
}

const RETIRED = "gap-closing:service-failure-observe-refresh-1793133446252";
const LIVE_OLDER = "gap-closing:auto-1790000000000-live-arm";
const LIVE_OLDEST = "gap-closing:auto-1780000000000-other-arm";
const DEPRECATED = "gap-closing:auto-1795000000000-deprecated-arm";

describe("dispatch_latest_auto_draft skips retired arms", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("MUST-FAIL a retired gap-closing arm alone in the listing is not dispatched", async () => {
    const s = stub([{ id: RETIRED, retired: true }]);
    const r = await resolveDispatchLatestAutoDraft({ type: "dispatch_latest_auto_draft" });
    const body = r.body as { dispatched: string | null; auto_templates_total: number };
    expect(body.dispatched).toBeNull();
    expect(body.auto_templates_total).toBe(0);
    expect(s.posted).toEqual([]);
  });

  it("MUST-FAIL a newer retired arm does not outrank an older live arm", async () => {
    const s = stub([{ id: LIVE_OLDER }, { id: RETIRED, retired: true, deprecated: false }]);
    const r = await resolveDispatchLatestAutoDraft({ type: "dispatch_latest_auto_draft" });
    expect((r.body as { dispatched: string | null }).dispatched).toBe(LIVE_OLDER);
    expect(s.posted).toEqual([LIVE_OLDER]);
  });

  it("control: a deprecated arm is still skipped", async () => {
    const s = stub([{ id: DEPRECATED, deprecated: true }, { id: LIVE_OLDER }]);
    const r = await resolveDispatchLatestAutoDraft({ type: "dispatch_latest_auto_draft" });
    expect((r.body as { dispatched: string | null }).dispatched).toBe(LIVE_OLDER);
    expect(s.posted).toEqual([LIVE_OLDER]);
  });

  it("control: live arms are picked newest-first and executed arms are passed over, as today", async () => {
    const s = stub([{ id: LIVE_OLDEST }, { id: LIVE_OLDER, retired: false }], []);
    const r1 = await resolveDispatchLatestAutoDraft({ type: "dispatch_latest_auto_draft" });
    expect((r1.body as { dispatched: string | null }).dispatched).toBe(LIVE_OLDER);
    expect(s.posted).toEqual([LIVE_OLDER]);

    const s2 = stub([{ id: LIVE_OLDEST }, { id: LIVE_OLDER }], [LIVE_OLDER]);
    const r2 = await resolveDispatchLatestAutoDraft({ type: "dispatch_latest_auto_draft" });
    expect((r2.body as { dispatched: string | null }).dispatched).toBe(LIVE_OLDEST);
    expect(s2.posted).toEqual([LIVE_OLDEST]);
  });
});
