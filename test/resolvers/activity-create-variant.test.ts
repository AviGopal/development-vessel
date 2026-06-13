import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  resolveActivityCreateVariant,
  checkPermissiveInvariants,
  MAX_COMPOSITION_DEPTH,
} from "../../src/resolvers/activity-create-variant.js";

const originalFetch = globalThis.fetch;

describe("activity-create-variant resolver", () => {
  beforeAll(() => {
    process.env["METABOB_ENDPOINT"] = "https://activity.test";
    process.env["METABOB_API_KEY"] = "test-key";
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns activityRegistryChange shape on success", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "activity:new-variant" }), { status: 200 })) as unknown as typeof fetch;

    const result = await resolveActivityCreateVariant({
      type: "activity_create_variant",
      template: { id: "test:t1", name: "t1", tasks: [] },
    });
    // activityRegistryChange signals minibob to include this in output_shapes when emitting
    // lifecycle:execution:succeeded, which triggers the registry-change observer.
    expect(result.shape).toBe("activityRegistryChange");
    const body = result.body as { variantId: string; accepted: boolean };
    expect(body.variantId).toBe("activity:new-variant");
    expect(body.accepted).toBe(true);
  });

  it("returns structuredError on 403 — NOT activityRegistryChange (no registry change occurred)", async () => {
    globalThis.fetch = (async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch;

    const result = await resolveActivityCreateVariant({
      type: "activity_create_variant",
      template: { id: "test:t1", name: "t1", tasks: [] },
    });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { status: number; adminNote?: string };
    expect(body.status).toBe(403);
    expect(typeof body.adminNote).toBe("string");
    expect(body.adminNote).toContain("admin");
  });

  it("returns structuredError on other 4xx without an admin note", async () => {
    globalThis.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;

    const result = await resolveActivityCreateVariant({
      type: "activity_create_variant",
      template: { id: "test:t1", name: "t1", tasks: [] },
    });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { status: number; adminNote?: string };
    expect(body.status).toBe(400);
    expect(body.adminNote).toBeUndefined();
  });

  it("strips and re-timestamps id when strip_id is set", async () => {
    let postedBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_url: string, opts?: RequestInit) => {
      postedBody = JSON.parse(String(opts?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: "v:timestamped" }), { status: 200 });
    }) as unknown as typeof fetch;

    await resolveActivityCreateVariant({
      type: "activity_create_variant",
      template: { id: "test:original", name: "t1", tasks: [] },
      strip_id: true,
    });
    expect(typeof postedBody?.["id"]).toBe("string");
    expect(String(postedBody?.["id"])).not.toBe("test:original");
    expect(String(postedBody?.["id"])).toMatch(/^test:original-\d+$/);
  });

  // ───────────────────────────────────────────────────────────────────
  // Phase 2 (2026-06-01) — permissive-scope registration-time invariants.
  // Gated on `proposed_pattern_authored_` id prefix OR validate_permissive_scope=true.
  // ───────────────────────────────────────────────────────────────────

  const validDesc = (extra = "") =>
    `A task description that is comfortably above the forty character minimum length floor ${extra}`.trim();

  const baseValidTemplate = () => ({
    id: "proposed_pattern_authored_alpha",
    name: "alpha",
    description: "A substrate-authored template for the alpha pattern cluster.",
    inputShapes: ["fileContent"],
    outputShapes: ["editAuditLog"],
    max_composition_depth: 2,
    authored_from_pattern: { pattern_id: "alpha_v1", observation_window: "2026-05-01/2026-05-30", contrast_examples: 3 },
    tasks: [
      {
        id: "load_input",
        resolver: "fs_read",
        description: validDesc("load the file"),
        outputShapes: ["editAuditLog"],
      },
    ],
  });

  it("permissive-scope acceptance case: a fully-valid template passes all six invariants", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ id: "v:ok" }), { status: 200 })) as unknown as typeof fetch;
    const result = await resolveActivityCreateVariant({
      type: "activity_create_variant",
      template: baseValidTemplate(),
      _registryLookupFn: async () => [],
    });
    expect(result.shape).toBe("activityRegistryChange");
  });

  it("I1 — refuses max_composition_depth > MAX_COMPOSITION_DEPTH", async () => {
    const tpl = { ...baseValidTemplate(), max_composition_depth: MAX_COMPOSITION_DEPTH + 1 };
    const verdict = await checkPermissiveInvariants(tpl, async () => []);
    expect(verdict?.invariant).toBe("I1");
    expect(verdict?.detail).toContain("max_composition_depth");
  });

  it("I2 — refuses inputShape without a producer and not in KNOWN_SEEDABLE_SHAPES", async () => {
    const tpl = { ...baseValidTemplate(), inputShapes: ["someExoticUnregisteredShape"] };
    const verdict = await checkPermissiveInvariants(tpl, async () => []);
    expect(verdict?.invariant).toBe("I2");
    expect(verdict?.detail).toContain("someExoticUnregisteredShape");
  });

  it("I2 — accepts inputShape when a registry template advertises it as outputShape", async () => {
    const tpl = { ...baseValidTemplate(), inputShapes: ["customProducedShape"] };
    const verdict = await checkPermissiveInvariants(tpl, async () => [
      { id: "some_producer", output_shapes: ["customProducedShape"] },
    ]);
    expect(verdict).toBeNull();
  });

  it("I3 — refuses circular compose dispatch", async () => {
    const tpl = {
      ...baseValidTemplate(),
      tasks: [
        {
          id: "produce_audit",
          resolver: "fs_read",
          description: validDesc("local task"),
          outputShapes: ["editAuditLog"],
        },
        {
          id: "delegate",
          resolver: "compose",
          subActivityId: "child_a",
          description: validDesc("delegate to a sibling activity that recurses back"),
        },
      ],
    };
    const verdict = await checkPermissiveInvariants(tpl, async () => [
      { id: "child_a", tasks: [{ id: "back", resolver: "compose", subActivityId: "proposed_pattern_authored_alpha" }] },
    ]);
    expect(verdict?.invariant).toBe("I3");
    expect(verdict?.detail).toContain("cycle");
  });

  it("I4 — refuses task with empty / sub-40-char / id-equals-description", async () => {
    const tooShort = { ...baseValidTemplate(), tasks: [{ id: "t1", resolver: "fs_read", description: "short", outputShapes: ["editAuditLog"] }] };
    expect((await checkPermissiveInvariants(tooShort, async () => []))?.invariant).toBe("I4");

    const todo = { ...baseValidTemplate(), tasks: [{ id: "t1", resolver: "fs_read", description: "TODO", outputShapes: ["editAuditLog"] }] };
    expect((await checkPermissiveInvariants(todo, async () => []))?.invariant).toBe("I4");

    const dupOfId = { ...baseValidTemplate(), tasks: [{ id: "load_file_into_pool_with_some_specific_handle", resolver: "fs_read", description: "load_file_into_pool_with_some_specific_handle", outputShapes: ["editAuditLog"] }] };
    expect((await checkPermissiveInvariants(dupOfId, async () => []))?.invariant).toBe("I4");
  });

  it("I5 — refuses output_shape not produced by any task", async () => {
    const tpl = {
      ...baseValidTemplate(),
      outputShapes: ["editAuditLog", "ghostlyShapeNobodyProduces"],
      tasks: [
        { id: "t1", resolver: "fs_read", description: validDesc(), outputShapes: ["editAuditLog"] },
      ],
    };
    const verdict = await checkPermissiveInvariants(tpl, async () => []);
    expect(verdict?.invariant).toBe("I5");
    expect(verdict?.detail).toContain("ghostlyShapeNobodyProduces");
  });

  it("I6 — refuses proposed=true template without authored_from_pattern", async () => {
    const tpl = { ...baseValidTemplate(), proposed: true } as Record<string, unknown>;
    delete tpl["authored_from_pattern"];
    const verdict = await checkPermissiveInvariants(tpl, async () => []);
    expect(verdict?.invariant).toBe("I6");
    expect(verdict?.detail).toContain("authored_from_pattern");
  });

  it("I6 — accepts proposed=false template without authored_from_pattern (operator-seeded exemption)", async () => {
    const tpl = { ...baseValidTemplate(), proposed: false } as Record<string, unknown>;
    delete tpl["authored_from_pattern"];
    const verdict = await checkPermissiveInvariants(tpl, async () => []);
    expect(verdict).toBeNull();
  });

  it("permissive scope is NOT applied to templates without the proposed_pattern_authored_ prefix", async () => {
    // A template missing every invariant should still register if the prefix isn't there
    // and the validate_permissive_scope flag isn't set.
    globalThis.fetch = (async () => new Response(JSON.stringify({ id: "v:legacy" }), { status: 200 })) as unknown as typeof fetch;
    const result = await resolveActivityCreateVariant({
      type: "activity_create_variant",
      template: { id: "operator-seeded-legacy", name: "legacy", tasks: [] },
      _registryLookupFn: async () => {
        throw new Error("registry lookup should not be invoked for non-permissive-scope templates");
      },
    });
    expect(result.shape).toBe("activityRegistryChange");
  });

  it("permissive scope IS applied when id starts with proposed_pattern_authored_", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ id: "v:should-not-reach" }), { status: 200 })) as unknown as typeof fetch;
    // Invalid template: missing authored_from_pattern on a proposed=true id.
    const result = await resolveActivityCreateVariant({
      type: "activity_create_variant",
      template: {
        id: "proposed_pattern_authored_invalid",
        name: "invalid",
        tasks: [],
        // proposed defaults to true via the resolver; authored_from_pattern absent → I6 fires.
      },
      _registryLookupFn: async () => [],
    });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { failure_mode: string; invariant?: string };
    expect(body.failure_mode).toBe("activity_registration_invariant");
    expect(body.invariant).toBe("I6");
  });

  it("body carries variantId from API response", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "v:my-id" }), { status: 200 })) as unknown as typeof fetch;

    const result = await resolveActivityCreateVariant({
      type: "activity_create_variant",
      template: { id: "test:t2", name: "t2", tasks: [] },
      parentTemplateId: "test:parent",
    });
    const body = result.body as { variantId: string; parentTemplateId?: string };
    expect(body.variantId).toBe("v:my-id");
    expect(body.parentTemplateId).toBe("test:parent");
  });

  // ───────────────────────────────────────────────────────────────────
  // Output-shape reachability (2026-06-13) — output_shapes_override must
  // not stamp an aspirational shape no task produces, and the general gate
  // rejects substrate-authored variants whose declared outputs are unreachable.
  // Regression: gap-closing drafter cloned itself (tasks emit patch_proposal)
  // while output_shapes_override force-labeled it substrateTopologyShowcase.
  // ───────────────────────────────────────────────────────────────────

  const renderTask = (shape: string) => ({
    id: "render",
    resolver: "fs_write",
    description: "Render and write the substrate topology surface into the vault directory.",
    outputShapes: [shape],
  });

  it("rejects an output_shapes_override that names a shape no task produces", async () => {
    // fetch should never be reached — registration is refused pre-POST.
    let posted = false;
    globalThis.fetch = (async () => { posted = true; return new Response(JSON.stringify({ id: "v:x" }), { status: 200 }); }) as unknown as typeof fetch;

    const result = await resolveActivityCreateVariant({
      type: "activity_create_variant",
      // tasks emit patch_proposal; the override aspirationally claims the gap shape.
      template: { id: "test:showcase", name: "showcase", tasks: [renderTask("patch_proposal")] },
      output_shapes_override: ["substrateTopologyShowcase"],
    });

    expect(result.shape).toBe("structuredError");
    const body = result.body as { failure_mode: string; detail: string };
    expect(body.failure_mode).toBe("output_shape_unreachable");
    expect(body.detail).toContain("substrateTopologyShowcase");
    expect(posted).toBe(false);
  });

  it("applies an output_shapes_override when every override shape is task-produced", async () => {
    let postedBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_url: string, opts?: RequestInit) => {
      postedBody = JSON.parse(String(opts?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: "v:showcase" }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await resolveActivityCreateVariant({
      type: "activity_create_variant",
      template: { id: "test:showcase", name: "showcase", tasks: [renderTask("substrateTopologyShowcase")] },
      output_shapes_override: ["substrateTopologyShowcase"],
    });

    expect(result.shape).toBe("activityRegistryChange");
    expect(postedBody?.["output_shapes"] as unknown as string[]).toEqual(["substrateTopologyShowcase"]);
  });

  it("general gate rejects a substrate-authored variant with an unreachable declared output shape", async () => {
    let posted = false;
    globalThis.fetch = (async () => { posted = true; return new Response(JSON.stringify({ id: "v:x" }), { status: 200 }); }) as unknown as typeof fetch;

    const result = await resolveActivityCreateVariant({
      type: "activity_create_variant",
      // empty override array is not applied, but its presence marks the variant
      // substrate-authored so the general gate inspects the declared output_shapes.
      template: {
        id: "test:ghost",
        name: "ghost",
        output_shapes: ["ghostShape"],
        tasks: [renderTask("realShape")],
      },
      output_shapes_override: [],
    });

    expect(result.shape).toBe("structuredError");
    const body = result.body as { failure_mode: string; detail: string };
    expect(body.failure_mode).toBe("output_shape_unreachable");
    expect(body.detail).toContain("ghostShape");
    expect(posted).toBe(false);
  });

  it("does NOT gate operator-seeded templates (proposed=false) with externally-produced shapes", async () => {
    let posted = false;
    globalThis.fetch = (async () => { posted = true; return new Response(JSON.stringify({ id: "v:seed" }), { status: 200 }); }) as unknown as typeof fetch;

    const result = await resolveActivityCreateVariant({
      type: "activity_create_variant",
      // operator seed: a declared output shape produced by a composed child, not a
      // local task. proposed=false + non-gap-closing id + no override => exempt.
      template: {
        id: "test:operator-seed",
        name: "seed",
        proposed: false,
        output_shapes: ["composedChildShape"],
        tasks: [renderTask("localShape")],
      },
    });

    expect(result.shape).toBe("activityRegistryChange");
    expect(posted).toBe(true);
  });
});
