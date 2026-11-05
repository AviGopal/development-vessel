// The activity_lifecycle_audit detector puts the CLOCK in its row id.
//
// src/resolvers/activity-lifecycle-audit.ts:369 builds
//   `activity-lifecycle-promote-${p.template_id}-${Date.now()}`
// and :379 builds
//   `activity-lifecycle-unload-${Date.now()}`
// so a condition that PERSISTS mints a brand-new open row on every run instead of
// updating the single row that already describes it. Measured in the live gap store
// on 2026-11-04: 3 open rows stood for 1 distinct condition.
//
// What that costs downstream, in order of how hard it is to see:
//   * every count built on rows is inflated (3 problems reported where 1 exists);
//   * re-detection is indistinguishable from a new problem, so a repeat looks like
//     a fresh finding rather than an unresolved one;
//   * whether a fix HELD is hidden, because the fixed condition simply stops appearing
//     while the stale copies keep counting.
//
// The row id belongs to the CONDITION — the template_id for a promote candidate, the
// fixed unload class for the cold-set aggregate — and ONLY that. The time is not part
// of a condition's identity; it belongs on the row as last_s, where it can be updated
// in place. After the fix, two detections of the same condition 60s apart must land on
// the SAME row id, and two different conditions must still land on different ones.
import { describe, expect, test } from "bun:test";
import * as mod from "../../src/resolvers/activity-lifecycle-audit";

type AuditPointer = mod.ActivityLifecycleAuditPointer;

/**
 * One catalogue template, spelled every way the audit may read its id or its
 * proposed flag. Extra spellings are inert: the resolver reads the one it reads.
 */
function templateOf(id: string, proposed: boolean): Record<string, unknown> {
  const nowIso = new Date().toISOString();
  return {
    id,
    template_id: id,
    templateId: id,
    name: id,
    is_proposed: proposed,
    proposed,
    status: proposed ? "proposed" : "active",
    created_at: nowIso,
    updated_at: nowIso,
  };
}

/** One execution trace for template `id`, spelled every way the audit may read it. */
function traceOf(id: string, ok: boolean): Record<string, unknown> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  return {
    template_id: id,
    templateId: id,
    activity_id: id,
    success: ok,
    ok,
    outcome: ok ? "success" : "failure",
    status: ok ? "success" : "failure",
    timestamp: nowIso,
    created_at: nowIso,
    at: nowIso,
    ts: now,
    started_at: nowIso,
  };
}

/**
 * The audit's own input, supplied in memory so the check needs no catalogue service,
 * no trace store, and no clock: one HOT proposed condition (`hotId`) with plenty of
 * recent successes, and two cold ones with only failures.
 */
function pointerFor(hotId: string): AuditPointer {
  const templates = [
    templateOf(hotId, true),
    templateOf("cond-cold-a", false),
    templateOf("cond-cold-b", false),
  ];
  const traces = [
    traceOf(hotId, true),
    traceOf(hotId, true),
    traceOf(hotId, true),
    traceOf(hotId, true),
    traceOf(hotId, true),
    traceOf(hotId, true),
    traceOf("cond-cold-a", false),
    traceOf("cond-cold-a", false),
    traceOf("cond-cold-b", false),
  ];
  const pointer = {
    type: "activityLifecycleAudit",
    templates,
    catalogue: templates,
    traces,
    hot_set_size: 1,
    hotSetSize: 1,
    promote_threshold: 1,
    promoteThreshold: 1,
    emit_cap: 1,
    emitCap: 1,
    dry_run: false,
    dryRun: false,
    skip_emit: true,
    emit: false,
    emit_url: "",
    emitUrl: "",
    api_key: "test-key",
    apiKey: "test-key",
  };
  return pointer as unknown as AuditPointer;
}

interface AuditResult {
  shape?: string;
  body?: {
    findings?: Array<Record<string, unknown>>;
    total_templates?: number;
    dry_run?: boolean;
  };
}

/**
 * Run the audit with the wall clock pinned to `nowMs`, so "the same condition detected
 * at two different times" is an exact, timer-free input rather than a race against
 * millisecond resolution.
 */
async function auditAt(nowMs: number, hotId: string): Promise<AuditResult> {
  const realNow = Date.now;
  const realFetch = globalThis.fetch;
  const findings: Array<Record<string, unknown>> = [];
  Date.now = () => nowMs;
  const fixture = pointerFor(hotId) as unknown as {
    templates: Array<Record<string, unknown>>;
    traces: Array<Record<string, unknown>>;
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === "POST") {
      const payload = await request.json() as Record<string, unknown>;
      findings.push({ ...payload, gap_id: payload.gap_id ?? payload.id });
      return Response.json({ ok: true });
    }
    const records = /trace/i.test(request.url) ? fixture.traces : fixture.templates;
    return Response.json({
      templates: fixture.templates,
      traces: fixture.traces,
      items: records,
      rows: records,
      data: records,
    });
  }) as typeof fetch;
  try {
    const pointer = {
      ...pointerFor(hotId),
      catalogue_url: "https://audit.test/catalogue",
      traces_url: "https://audit.test/traces",
      emit_url: "https://audit.test/gaps",
      dry_run: false,
      skip_emit: false,
      emit: true,
    };
    const result = await mod.resolveActivityLifecycleAudit(pointer) as unknown as AuditResult;
    return { ...result, body: { ...result.body, findings } };
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
}

/** The row ids the audit emitted for this run, in emission order. */
function rowIds(result: AuditResult): string[] {
  const findings = result.body?.findings ?? [];
  return findings.map((finding) => String(finding["gap_id"] ?? ""));
}

describe("activity_lifecycle_audit row ids name the condition, not the clock", () => {
  test("the same condition detected at two different times lands on ONE row id", async () => {
    const t0 = Date.now();

    const alphaEarly = await auditAt(t0, "cond-alpha");
    const alphaLate = await auditAt(t0 + 60_000, "cond-alpha");
    const beta = await auditAt(t0, "cond-beta");

    // Precondition: the audit actually produced rows from the condition we gave it.
    expect(rowIds(alphaEarly).length).toBeGreaterThan(0);

    // Two DIFFERENT conditions are two different rows — true before and after the fix.
    expect(rowIds(beta)).not.toEqual(rowIds(alphaEarly));

    // THE DEFECT. One condition, detected sixty seconds later, is the SAME open row:
    // its id is the condition only (`activity-lifecycle-promote-cond-alpha`). Today the
    // id also carries Date.now(), so the second detection mints a second open row and
    // this assertion is red — copies inflate counts, repeats look like new problems,
    // and a fix that held is invisible.
    expect(rowIds(alphaLate)).toEqual(rowIds(alphaEarly));
  });

  test("CONTROL: the audit still answers with the activityLifecycleAudit shape", async () => {
    // Behaviour the defect does not touch: whatever the row id is made of, the audit
    // still returns its declared shape. Must stay the same before and after the fix.
    const result = await auditAt(Date.now(), "cond-alpha");
    expect(result.shape).toBe("activityLifecycleAudit");
    expect(result.body).toBeDefined();
  });
});
