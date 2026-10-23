// ALREADY-MINTED COMPOSED CAPABILITIES THAT KEEP GOAL-TEXT IDS ARE REPORTED (law 3). author_composed_capability now keys
// a composed capability's id on its contract (composedCapabilityTemplateId), but templates minted before that keep the
// 40-char goal slug, so a mint keyed on a goal-class preamble keeps shadowing that class after the id fix.
// activity_lifecycle_audit already walks the template catalogue; it now reports every composed-cap template whose id is
// not the signature form (composed-cap-<shape>-<12 hex>). Report only: nothing is retired, renamed or written.
// MUST-FAIL at the parent 60f078b0: the audit body carries no composed_capability_slug_ids.
import { afterEach, describe, expect, it } from "bun:test";
import { resolveActivityLifecycleAudit } from "../../src/resolvers/activity-lifecycle-audit.js";
import { composedCapabilityTemplateId } from "../../src/resolvers/author-composed-capability.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const writes: string[] = [];
function catalogue(templates: Array<{ id: string; tags?: string[] }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if ((init?.method ?? "GET").toUpperCase() !== "GET") writes.push(url);
    if (url.includes("/templates")) return new Response(JSON.stringify({ templates: url.includes("offset=0") ? templates : [] }), { status: 200 });
    if (url.includes("execution-traces")) return new Response(JSON.stringify({ executions: [] }), { status: 200 });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as unknown as typeof fetch;
}

const signatureId = composedCapabilityTemplateId([], ["conceptCreditReport"], [{ resolver: "llm_completion_dispatch", output_shapes: ["conceptCreditReport"] }]).id;
const deliverableId = composedCapabilityTemplateId([], ["composedDeliverable_could_you_please"], [{ resolver: "llm_completion_dispatch" }]).id;

async function audit(templates: Array<{ id: string; tags?: string[] }>) {
  globalThis.fetch = catalogue(templates);
  const r = await resolveActivityLifecycleAudit({ type: "activity_lifecycle_audit" });
  expect(r.shape).toBe("activityLifecycleAudit");
  return r.body as { composed_capability_slug_ids?: string[]; composed_capability_slug_id_count?: number };
}

describe("activity_lifecycle_audit: composed capabilities still keyed on goal text", () => {
  it("[MUST-FAIL] an existing slug-id composed-cap template is reported", async () => {
    const body = await audit([
      { id: "composed-cap-investigate-and-decompose" },
      { id: "activity:⟨composed-cap-could-you-please-close-the-substrate-gap⟩" },
      { id: signatureId },
    ]);
    expect(body.composed_capability_slug_ids).toEqual([
      "composed-cap-could-you-please-close-the-substrate-gap",
      "composed-cap-investigate-and-decompose",
    ]);
    expect(body.composed_capability_slug_id_count).toBe(2);
  });

  it("[CONTROL] signature-id composed-cap templates and non-composed templates are not reported", async () => {
    const body = await audit([{ id: signatureId }, { id: deliverableId }, { id: "learned-deadline-note-index" }, { id: "hot-template" }]);
    expect(signatureId).toMatch(/^composed-cap-conceptcreditreport-[0-9a-f]{12}$/);
    expect(body.composed_capability_slug_ids ?? []).toEqual([]);
    expect(body.composed_capability_slug_id_count ?? 0).toBe(0);
  });

  it("[CONTROL] report only: the slug-id report writes nothing (no gap, no retire, no rename)", async () => {
    writes.length = 0;
    await audit([{ id: "composed-cap-investigate-and-decompose" }]);
    expect(writes).toEqual([]);
  });
});
