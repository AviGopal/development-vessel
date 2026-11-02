import { describe, test, expect, spyOn, afterEach } from "bun:test";
import * as _ from "../../src/resolvers/gap-check-supply.ts";

// A minimal Row type for the test
type Row = Record<string, any>;

describe("gap-check-supply: autonomyScope exclusion", () => {
  let fetchSpy: any;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  test("FAIL: a gap in an excluded site should be routed to a human", async () => {
    const excludedPath = "src/resolvers/foo.ts";

    fetchSpy = spyOn(global, "fetch").mockImplementation(async (url, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (body?.impulse?.shape === "autonomyScope") {
        return new Response(
          JSON.stringify({
            body: {
              impulses: [
                {
                  body: {
                    excluded_paths: [excludedPath],
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });

    // Dynamically import the module to ensure it picks up the mocked fetch,
    // especially if it performs a fetch at the top level for caching.
    const mod = await import(`../../src/resolvers/gap-check-supply.ts?t=${Date.now()}`);

    const excludedGap: Row = {
      id: "gap-excluded-site",
      vessel: "development-vessel",
      // This structure is a guess based on checkSupplySite function signature and common patterns
      evidence_v2: {
        "check:supply": {
          site_rel: excludedPath,
          vessel: "development-vessel",
        }
      },
      summary: "A gap in an excluded file",
      state: "open",
      falsifier_spec: "none", // As per spec, many of these have falsifier:none
    };

    // Assuming checkSupplyDisposition is the sync function that determines the fate of a single gap,
    // and that it relies on a pre-loaded/cached scope, which the dynamic import handles.
    const disposition = mod.checkSupplyDisposition(excludedGap);

    // The bug is that this gap is only marked 'scope_excluded' and not routed.
    // The failing test asserts the correct, future behavior.
    expect(disposition).toEqual(
      expect.objectContaining({
        state: "human_required",
        owner: expect.any(String),
        review_by: expect.any(String),
      })
    );
  });

  test("PASS: a gap in a non-excluded site is processed normally", async () => {
    const excludedPath = "src/resolvers/foo.ts";
    const nonExcludedPath = "src/resolvers/bar.ts";

    fetchSpy = spyOn(global, "fetch").mockImplementation(async (url, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (body?.impulse?.shape === "autonomyScope") {
        return new Response(
          JSON.stringify({
            body: {
              impulses: [
                {
                  body: {
                    excluded_paths: [excludedPath],
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });

    const mod = await import(`../../src/resolvers/gap-check-supply.ts?t=${Date.now()}`);

    const normalGap: Row = {
      id: "gap-normal-site",
      vessel: "development-vessel",
      evidence_v2: {
        "check:supply": {
          site_rel: nonExcludedPath,
          vessel: "development-vessel",
        }
      },
      summary: "A gap in a normal file",
      state: "open",
    };

    const disposition = mod.checkSupplyDisposition(normalGap);

    // This control test asserts that behavior for non-excluded gaps remains correct.
    // We expect it to not be marked as excluded.
    expect(disposition?.state).not.toBe('scope_excluded');
  });
});
