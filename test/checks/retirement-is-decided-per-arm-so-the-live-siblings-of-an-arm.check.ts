import { afterEach, describe, expect, test } from "bun:test";
import * as mod from "../../src/resolvers/dispatch-latest-auto-draft";

type TemplateRow = {
  id: string;
  deprecated?: boolean;
  retired?: boolean;
  template?: unknown;
  body?: string;
};

type AutoDraftBody = {
  dispatched?: string | null;
  would_dispatch?: string | null;
};

const originalFetch = globalThis.fetch;

function stubListing(templates: TemplateRow[]): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.includes("/v2/activities/templates")) {
      return new Response(JSON.stringify({ templates }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/v2/activities/execution-traces")) {
      return new Response(JSON.stringify({ executions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function bodyOf(result: Awaited<ReturnType<typeof mod.resolveDispatchLatestAutoDraft>>): AutoDraftBody {
  return result.body as unknown as AutoDraftBody;
}

describe("retirement is decided per arm, not per family", () => {
  test("a live sibling with the same template body as a retired arm is not dispatched", async () => {
    const retiredArm = "gap-closing:auto-1700000000000-observe-orthogonal-refresh-519113";
    const liveSibling = "gap-closing:auto-1700000001000-observe-orthogonal-refresh-43490";
    const sharedTemplate = {
      body: "observe orthogonal refresh",
      write_target: "/workspace/observe-orthogonal-refresh",
      tasks: [{ id: "observe-orthogonal-refresh", type: "noop", write_target: "/workspace/observe-orthogonal-refresh" }],
    };

    stubListing([
      { id: retiredArm, retired: true, template: sharedTemplate, body: "observe orthogonal refresh" },
      { id: liveSibling, retired: false, template: sharedTemplate, body: "observe orthogonal refresh" },
    ]);

    const result = await mod.resolveDispatchLatestAutoDraft({ dry_run: true });
    expect(result.shape).toBe("autoDraftDispatchResult");
    expect(bodyOf(result).would_dispatch).not.toBe(liveSibling);
  });

  test("CONTROL: a live arm with a different body, or no retired sibling, is still picked", async () => {
    const retiredArm = "gap-closing:auto-1700000000000-observe-orthogonal-refresh-519113";
    const liveControl = "gap-closing:auto-1700000002000-some-other-family-11111";

    stubListing([
      { id: retiredArm, retired: true, template: { body: "retired for another reason", write_target: "/workspace/other" }, body: "retired for another reason" },
      { id: liveControl, retired: false, template: { body: "some other family", write_target: "/workspace/some-other-family" }, body: "some other family" },
    ]);

    const controlResult = await mod.resolveDispatchLatestAutoDraft({ dry_run: true });
    expect(bodyOf(controlResult).would_dispatch).toBe(liveControl);

    const liveOnly = "gap-closing:auto-1700000003000-no-retired-sibling-22222";
    stubListing([
      { id: liveOnly, retired: false, template: { body: "no retired sibling", write_target: "/workspace/no-retired-sibling" }, body: "no retired sibling" },
    ]);

    const liveOnlyResult = await mod.resolveDispatchLatestAutoDraft({ dry_run: true });
    expect(bodyOf(liveOnlyResult).would_dispatch).toBe(liveOnly);
  });
});
