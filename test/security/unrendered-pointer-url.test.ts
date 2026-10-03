// AN UNRENDERED OR BLANK ENDPOINT FIELD IS NOT AN OVERRIDE.
//
// A live template (activity:auto-bridge-ui_legibility_scan) fills its pointer's endpoint fields from the
// goal: `devVesselImpulsesUrl: '{{goal.devVesselImpulsesUrl…'`, `obsidianEndpoint: '{{goal.obsidianEndpoint…'`.
// A goal that does not set those fields leaves the value empty, or leaves the placeholder text unrendered.
// Neither is a URL anyone chose. Read as an override, either one sends the scan to '' or to a literal
// '{{…}}' URL, and the call fails without the node key. Read as unset, the scan uses the configured
// endpoint, and the key goes with it as it should.
//
// A real override (http://attacker.invalid) still gets no key. That is the control for round 1's guard.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { resolveUiLegibilityScan } from "../../src/resolvers/ui-legibility-scan.js";

const NODE_KEY = "node-key-under-test";
const DEV_DEFAULT = "http://127.0.0.1:8090/v2/impulses/resolve";
const OBSIDIAN_DEFAULT = "http://127.0.0.1:27182/resolve";

type Seen = { url: string; authorization: string | null; type: string };
const realFetch = globalThis.fetch;
let priorKey: string | undefined;
beforeAll(() => {
  priorKey = process.env["METABOB_API_KEY"];
  process.env["METABOB_API_KEY"] = NODE_KEY;
});
afterAll(() => {
  if (priorKey === undefined) delete process.env["METABOB_API_KEY"];
  else process.env["METABOB_API_KEY"] = priorKey;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const uiView = JSON.stringify({ goal_dispatch: { open: true, effective_tokens: { "--sub-font-xs": "11px" }, component_counts: { max_chips_per_row: 3 } } });

function recordingFetch(): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const body = init?.body ? (JSON.parse(String(init.body)) as { impulse?: { pointer?: { type?: string } } }) : {};
    const type = String(body.impulse?.pointer?.type ?? "");
    seen.push({ url, authorization: new Headers(init?.headers ?? {}).get("authorization"), type });
    const payload =
      type === "obsidian:ui_view" ? { content: uiView }
        : type === "obsidian:note" ? { content: "" }
        : type === "substrateGap" ? { body: { gaps: [] } }
        : { ok: true };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return seen;
}

const gapWrites = (seen: Seen[]) => seen.filter((s) => s.type === "substrateGap_write");

describe("ui_legibility_scan: an unrendered or blank goal field is unset, not an override", () => {
  for (const value of ["", "   ", "{{goal.devVesselImpulsesUrl}}", "{{ goal.devVesselImpulsesUrl | default: '' }}"]) {
    it(`devVesselImpulsesUrl=${JSON.stringify(value)}: the gap write goes to the configured endpoint, with the node key`, async () => {
      const seen = recordingFetch();
      await resolveUiLegibilityScan({ type: "ui_legibility_scan", devVesselImpulsesUrl: value } as never);
      const writes = gapWrites(seen);
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.every((w) => w.url === DEV_DEFAULT && w.authorization === `ApiKey ${NODE_KEY}`)).toBe(true);
    });
  }

  for (const value of ["", "{{goal.obsidianEndpoint}}"]) {
    it(`obsidianEndpoint=${JSON.stringify(value)}: the view is read from the configured endpoint`, async () => {
      const seen = recordingFetch();
      await resolveUiLegibilityScan({ type: "ui_legibility_scan", obsidianEndpoint: value } as never);
      const views = seen.filter((s) => s.type === "obsidian:ui_view");
      expect(views.map((v) => v.url)).toEqual([OBSIDIAN_DEFAULT]);
    });
  }

  it("control: a real override still gets no node key", async () => {
    const seen = recordingFetch();
    await resolveUiLegibilityScan({ type: "ui_legibility_scan", devVesselImpulsesUrl: "http://attacker.invalid/v2/impulses/resolve" } as never);
    const toAttacker = seen.filter((s) => s.url.startsWith("http://attacker.invalid"));
    expect(toAttacker.length).toBeGreaterThan(0);
    expect(toAttacker.filter((s) => s.authorization !== null)).toEqual([]);
  });
});
