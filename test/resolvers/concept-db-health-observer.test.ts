import { describe, it, expect } from "bun:test";
import { resolveConceptDbHealthObserver } from "../../src/resolvers/concept-db-health-observer.js";

describe("concept_db_health_observer", () => {
  it("degrades to overall_reachable=false on a closed port", async () => {
    const result = await resolveConceptDbHealthObserver({
      type: "concept_db_health_observer",
      endpoint: "http://127.0.0.1:1",
      timeoutMs: 500,
    });
    expect(result.shape).toBe("conceptDbHealth");
    const body = result.body as {
      overall_reachable: boolean;
      control_plane: { reachable: boolean; error: string | null };
      data_plane: { reachable: boolean; error: string | null };
    };
    expect(body.overall_reachable).toBe(false);
    expect(body.control_plane.reachable).toBe(false);
    expect(body.control_plane.error).not.toBeNull();
    expect(body.data_plane.reachable).toBe(false);
    expect(body.data_plane.error).not.toBeNull();
  });

  it("emits a well-formed impulse on a timeout against a non-routable host", async () => {
    const result = await resolveConceptDbHealthObserver({
      type: "concept_db_health_observer",
      endpoint: "http://192.0.2.1",
      timeoutMs: 250,
    });
    const body = result.body as {
      overall_reachable: boolean;
      generated_at: string;
      control_plane: { error: string | null };
    };
    expect(body.overall_reachable).toBe(false);
    expect(typeof body.generated_at).toBe("string");
    expect(body.control_plane.error).not.toBeNull();
  });

  it("uses default endpoint when none supplied", async () => {
    const result = await resolveConceptDbHealthObserver({
      type: "concept_db_health_observer",
      timeoutMs: 500,
    });
    const body = result.body as { endpoint: string };
    expect(body.endpoint).toMatch(/^https?:\/\//);
  });
});
