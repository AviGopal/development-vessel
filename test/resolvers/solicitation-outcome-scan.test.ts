// Per-resolver test for solicitation_outcome_scan — the OPERATOR-VERDICT-CORPUS read-back
// (§12.6 step 1b). Given solicitation ids, it reads obsidian interaction episodes and reports
// which were ANSWERED; an answered close-oracle re-land escalation folds into the oracle's
// operator-engagement calibration. Was a stub; now a real read. Fetch is mocked (no network).

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CALIB = join(tmpdir(), `soc-calib-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

const originalFetch = globalThis.fetch;
beforeAll(() => {
  process.env.CLOSE_ORACLE_CALIB_PATH = CALIB;
  // discovery + obsidian episode read both go through fetch; return an episode that answers the
  // re-land solicitation, and nothing for the other id.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("obsidian:interaction_episode")) {
      const episodes = [{ solicitation_ids: ["reland-needs-human-gap-answered-0001"], window_start: new Date().toISOString() }];
      return new Response(JSON.stringify({ content: JSON.stringify({ episodes }) }), { status: 200 });
    }
    // discovery lookup / anything else
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = originalFetch; });

describe("solicitation_outcome_scan — operator-verdict read-back", () => {
  it("reports answered vs pending and folds an answered re-land escalation into operator engagement", async () => {
    const { resolveSolicitationOutcomeScan } = await import("../../src/resolvers/solicitation-outcome-scan.js");
    const r = await resolveSolicitationOutcomeScan({
      type: "solicitation_outcome_scan",
      solicitation_ids: ["reland-needs-human-gap-answered-0001", "reland-needs-human-gap-pending-0002"],
    });
    expect(r.shape).toBe("solicitationOutcomeReport");
    const body = r.body as { answered: number; pending: number; outcomes: Array<{ solicitation_id: string; outcome: string }> };
    expect(body.answered).toBe(1);
    expect(body.pending).toBe(1);
    const answered = body.outcomes.find((o) => o.solicitation_id === "reland-needs-human-gap-answered-0001");
    expect(answered?.outcome).toBe("answered");
    // the answered re-land escalation calibrated the oracle against the operator corpus
    const mod = await import("../../src/resolvers/gap-to-feature.js");
    expect(mod.closeOracleReliability("landed_commit").operator_engaged).toBeGreaterThanOrEqual(1);
  });

  it("returns an empty report when no solicitation_ids are supplied", async () => {
    const { resolveSolicitationOutcomeScan } = await import("../../src/resolvers/solicitation-outcome-scan.js");
    const r = await resolveSolicitationOutcomeScan({ type: "solicitation_outcome_scan" });
    expect((r.body as { answered: number }).answered).toBe(0);
  });
});
