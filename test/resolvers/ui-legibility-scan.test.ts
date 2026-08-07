/**
 * Tests for ui_legibility_scan.
 *
 * Two properties are load-bearing and both were real defects:
 *
 *  1. An unobservable target must produce a FAILED execution, not a clean one.
 *     The resolver used to return `uiLegibilityReport{available:false}`, which
 *     the route wraps as `success:true` — so a scheduled detector graded on that
 *     field earned a Thompson win for every run in which it never looked.
 *
 *  2. The detector must CLOSE its own findings when they stop reproducing, and
 *     must NOT close anything else. A detector that only opens gaps makes its
 *     own close-rate unmeasurable; a detector that closes indiscriminately
 *     silences human complaints its three rules cannot express.
 *
 * No real network: `fetch` is replaced per-test and restored afterwards.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveUiLegibilityScan } from "../../src/resolvers/ui-legibility-scan.js";

type Handler = (url: string, body: Record<string, unknown>) => unknown;

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; body: Record<string, unknown> }> = [];

function installFetch(handler: Handler): void {
  calls = [];
  // @ts-expect-error — deliberate test double
  globalThis.fetch = async (url: string, init?: { body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url: String(url), body });
    const payload = handler(String(url), body);
    if (payload === null) return { ok: false, status: 502, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => payload };
  };
}

/** The pointer nested inside an `{impulse:{pointer:…}}` envelope. */
function pointerOf(body: Record<string, unknown>): Record<string, unknown> {
  const imp = (body["impulse"] ?? {}) as Record<string, unknown>;
  return (imp["pointer"] ?? {}) as Record<string, unknown>;
}

const uiView = (xsPx: number): string =>
  JSON.stringify({
    goal_dispatch: {
      open: true,
      effective_tokens: { "--sub-font-xs": `${xsPx}px` },
      component_counts: { max_chips_per_row: 3 },
    },
  });

const SCAN = { type: "ui_legibility_scan" as const, obsidianEndpoint: "http://surface.test" };

describe("ui_legibility_scan", () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("reports an UNOBSERVABLE target as a structuredError, never as a clean scan", async () => {
    // The surface is unreachable: ui_view comes back with no content.
    installFetch(() => ({ content: null }));

    const res = await resolveUiLegibilityScan(SCAN);

    // structuredError is what the impulses route turns into success:false. If
    // this ever becomes uiLegibilityReport again, a blind run scores as a win.
    expect(res.shape).toBe("structuredError");
    const body = res.body as { detail: string; available: boolean };
    expect(body.available).toBe(false);
    expect(body.detail).toContain("could not observe");
  });

  it("opens a gap when a token is below the px floor", async () => {
    installFetch((url, body) => {
      if (pointerOf(body)["type"] === "obsidian:ui_view") return { content: uiView(11) };
      if (pointerOf(body)["type"] === "obsidian:note") return { content: "" };
      if (pointerOf(body)["type"] === "substrateGap") return { body: { gaps: [] } };
      return { ok: true };
    });

    const res = await resolveUiLegibilityScan(SCAN);
    const body = res.body as { violations: unknown[]; gaps_emitted: number; gaps_closed: number };

    expect(res.shape).toBe("uiLegibilityReport");
    expect(body.violations).toHaveLength(1);
    expect(body.gaps_emitted).toBe(1);
    expect(body.gaps_closed).toBe(0);

    const written = calls.filter((c) => pointerOf(c.body)["type"] === "substrateGap_write");
    expect(written).toHaveLength(1);
    const gap = pointerOf(written[0]!.body)["gap"] as Record<string, unknown>;
    expect(gap["status"]).toBe("open");
    expect(gap["source"]).toBe("substrate_detected");
  });

  it("CLOSES its own finding when the violation no longer reproduces", async () => {
    const openGap = {
      id: "ui-feedback---sub-font-xs-hard_to_see",
      status: "open",
      source: "substrate_detected",
      category: "ui_legibility",
      summary: "UI legibility violation (px_floor) on --sub-font-xs",
      classification_metadata: { rule: "px_floor", region: "--sub-font-xs" },
    };
    installFetch((url, body) => {
      if (pointerOf(body)["type"] === "obsidian:ui_view") return { content: uiView(14) };
      if (pointerOf(body)["type"] === "obsidian:note") return { content: "" };
      if (pointerOf(body)["type"] === "substrateGap") return { body: { gaps: [openGap] } };
      return { ok: true };
    });

    const res = await resolveUiLegibilityScan(SCAN);
    const body = res.body as {
      violations: unknown[];
      gaps_closed: number;
      closed_gap_ids: string[];
      information_yield: string;
    };

    expect(body.violations).toHaveLength(0);
    expect(body.gaps_closed).toBe(1);
    expect(body.closed_gap_ids).toEqual([openGap.id]);
    // Closing IS information — a scan that closed something is not idle.
    expect(body.information_yield).toBe("productive");

    const write = calls.find((c) => pointerOf(c.body)["type"] === "substrateGap_write");
    const gap = pointerOf(write!.body)["gap"] as Record<string, unknown>;
    expect(gap["status"]).toBe("closed");
    const meta = gap["classification_metadata"] as Record<string, unknown>;
    expect(meta["closed_by"]).toBe("ui_legibility_scan");
    expect(meta["closed_reason"]).toBe("violation_not_reproduced_on_rescan");
  });

  it("NEVER closes a human-reported gap, even when its own rules all pass", async () => {
    // The safety property. A human's complaint shares this keyspace on purpose;
    // the human saw something these three rules cannot express, so a clean scan
    // is not evidence that their report is resolved.
    const humanGap = {
      id: "ui-feedback-sub-card-fleet-hard_to_understand",
      status: "open",
      source: "human_reported",
      category: "ui_legibility",
      summary: "boldface the content section",
      classification_metadata: { kind: "hard_to_understand" },
    };
    installFetch((url, body) => {
      if (pointerOf(body)["type"] === "obsidian:ui_view") return { content: uiView(14) };
      if (pointerOf(body)["type"] === "obsidian:note") return { content: "" };
      if (pointerOf(body)["type"] === "substrateGap") return { body: { gaps: [humanGap] } };
      return { ok: true };
    });

    const res = await resolveUiLegibilityScan(SCAN);
    const body = res.body as { gaps_closed: number; closed_gap_ids: string[] };

    expect(body.gaps_closed).toBe(0);
    expect(body.closed_gap_ids).toEqual([]);
    expect(calls.some((c) => pointerOf(c.body)["type"] === "substrateGap_write")).toBe(false);
  });

  it("does not close a substrate finding whose rule this scan cannot re-evaluate", async () => {
    // Same funnel, same source, but a rule outside R1–R3. The scan has no
    // evidence about it, and no evidence is not evidence of absence.
    const foreignRule = {
      id: "ui-feedback-something-else-hard_to_see",
      status: "open",
      source: "substrate_detected",
      category: "ui_legibility",
      summary: "some other detector's finding",
      classification_metadata: { rule: "contrast_ratio" },
    };
    installFetch((url, body) => {
      if (pointerOf(body)["type"] === "obsidian:ui_view") return { content: uiView(14) };
      if (pointerOf(body)["type"] === "obsidian:note") return { content: "" };
      if (pointerOf(body)["type"] === "substrateGap") return { body: { gaps: [foreignRule] } };
      return { ok: true };
    });

    const body = (await resolveUiLegibilityScan(SCAN)).body as { gaps_closed: number };
    expect(body.gaps_closed).toBe(0);
  });
});
