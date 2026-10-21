// gap_lifecycle_scan's expired_not_redetected pass skips a row its OWN armed check measures.
//
// The pass closed rows on AGE alone and never read classification_metadata.check_supply, so a row
// whose check gap-check-supply had armed (red at HEAD, re-run against every tree) was closed
// "not re-detected" although that check is its re-detector. Both such closures observed were
// narrowed children carrying their parent's armed_at: an arm copied at narrowing is the parent's,
// not the row's, and must not hold the row open (the third case below).
//
// HERMETIC, like gap-lifecycle-scan-orphan-expiry-scan-record.test.ts: temp gaps.json + proposals
// dir, WORKSPACE_ROOT at the temp dir, GAP_STORE_ENDPOINT unset (this process is the holder), and a
// fetch spy that answers every write. No live service, no DB.

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGapLifecycleScan } from "../../src/resolvers/gap-lifecycle-scan.js";

type Gap = { id: string; classification_metadata?: Record<string, any> } & Record<string, any>;

const DEV = "http://dev-vessel.fixture.invalid/v2/impulses/resolve";
let ws = "";
let priorRoot: string | undefined;
let priorStoreEndpoint: string | undefined;
let fetchSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "gls-armed-expiry-"));
  priorRoot = process.env["WORKSPACE_ROOT"];
  process.env["WORKSPACE_ROOT"] = ws;
  priorStoreEndpoint = process.env["GAP_STORE_ENDPOINT"];
  delete process.env["GAP_STORE_ENDPOINT"];
});

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
  if (priorRoot === undefined) delete process.env["WORKSPACE_ROOT"];
  else process.env["WORKSPACE_ROOT"] = priorRoot;
  if (priorStoreEndpoint !== undefined) process.env["GAP_STORE_ENDPOINT"] = priorStoreEndpoint;
  rmSync(ws, { recursive: true, force: true });
});

describe("gap-lifecycle-scan: expiry never closes a row its own armed check measures", () => {
  const H = 3_600_000;
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  // An open human-reported row untouched for 200 h, with attempt evidence (so hasNoAttemptEvidence does not exempt it).
  function staleRow(id: string, meta: Record<string, unknown>): Gap {
    return {
      id,
      category: "edit_intent_route",
      source: "human_reported",
      status: "open",
      summary: `fixture row ${id}`,
      created_at: iso(300 * H),
      updated_at: iso(200 * H),
      classification_metadata: { failed_attempts: 1, edit_site: "repos/development-vessel/src/resolvers/fixture.ts", ...meta },
    };
  }
  const armed = (armedAt: string) => ({ check_supply: { state: "armed", armed_at: armedAt, red_at_head: true, test_file: "test/checks/fixture.check.ts", vessel: "development-vessel", mode: "check_file" } });

  async function expiredBy(gaps: Gap[]): Promise<string[]> {
    mkdirSync(join(ws, "gaps"), { recursive: true });
    mkdirSync(join(ws, "proposals", ".applied"), { recursive: true });
    const gapsPath = join(ws, "gaps", "gaps.json");
    writeFileSync(gapsPath, JSON.stringify(gaps));
    const writes: Gap[] = [];
    fetchSpy?.mockRestore();
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_input: RequestInfo | URL, init?: RequestInit) => {
      const b = init?.body ? JSON.parse(String(init.body)) : {};
      const ptr = b?.impulse?.pointer ?? {};
      if (ptr.type === "substrateGap_write" && ptr.gap) writes.push(ptr.gap);
      return new Response(JSON.stringify({ shape: "ok", body: {} }), { status: 200 });
    }) as unknown as typeof fetch);
    await resolveGapLifecycleScan({
      type: "gap_lifecycle_scan",
      gapsPath,
      proposalsDir: join(ws, "proposals"),
      staleHours: 48,
      autoClose: true,
      falsify: false,
      devVesselImpulsesUrl: DEV,
    } as never);
    return writes
      .filter((w) => w.status === "closed" && w.classification_metadata?.closed_reason === "expired_not_redetected")
      .map((w) => w.id);
  }

  it("MUST-FAIL: a 200 h old row with attempt evidence and its OWN live arm is not expired", async () => {
    const row = staleRow("fixture-own-arm", armed(iso(201 * H)));
    expect(await expiredBy([row])).not.toContain(row.id);
  });

  it("control: the identical row without check_supply is still expired", async () => {
    const row = staleRow("fixture-no-arm", {});
    expect(await expiredBy([row])).toContain(row.id);
  });

  it("control: a narrowed child whose arm predates its narrowing (the parent's, copied) is still expired", async () => {
    const row = staleRow("fixture-parent-narrowed", { ...armed(iso(310 * H)), parent_gap_id: "fixture-parent", narrowed_at: iso(300 * H) });
    expect(await expiredBy([row])).toContain(row.id);
  });

  it("a narrowed child armed on its own check after its narrowing is not expired", async () => {
    const row = staleRow("fixture-child-own-arm", { ...armed(iso(210 * H)), parent_gap_id: "fixture-parent", narrowed_at: iso(300 * H) });
    expect(await expiredBy([row])).not.toContain(row.id);
  });

  it("control: a row whose check_supply is not armed (a goal still in flight) is still expired", async () => {
    const row = staleRow("fixture-dispatched", { check_supply: { state: "goal_dispatched", attempts: 1 } });
    expect(await expiredBy([row])).toContain(row.id);
  });
});
