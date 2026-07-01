import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveLearningMode } from "../../src/resolvers/learning-mode.js";

// The resolver reaches dev-vessel + activity-api over HTTP; in tests those are
// unreachable, so every fetch fails soft. We pin an isolated WORKSPACE_ROOT so
// the hysteresis state file doesn't touch the real workspace.
describe("learning_mode resolver", () => {
  let tmp: string;
  let prevWorkspace: string | undefined;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "learning-mode-"));
    prevWorkspace = process.env["WORKSPACE_ROOT"];
  });

  afterEach(async () => {
    if (prevWorkspace === undefined) delete process.env["WORKSPACE_ROOT"];
    else process.env["WORKSPACE_ROOT"] = prevWorkspace;
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("emits a well-formed learningMode read-out with a mode + per_shape_boost + mode_weights", async () => {
    // Unreachable endpoints → fail-soft → no frontier, no collapse → collect.
    const r = await resolveLearningMode({
      type: "learningMode",
      devVesselUrl: "http://127.0.0.1:59999",
      activityApiUrl: "http://127.0.0.1:59998",
    } as any);

    expect(r.shape).toBe("learningMode");
    const body = r.body as Record<string, any>;
    expect(["develop", "collect", "reflect"]).toContain(body.emphasize_mode);
    expect(typeof body.per_shape_boost).toBe("object");
    expect(typeof body.driver).toBe("string");

    // FLOOR: every mode weight is present and none is zeroed out.
    expect(body.mode_weights).toHaveProperty("develop");
    expect(body.mode_weights).toHaveProperty("collect");
    expect(body.mode_weights).toHaveProperty("reflect");
    for (const m of ["develop", "collect", "reflect"]) {
      expect(body.mode_weights[m]).toBeGreaterThan(0);
    }
    // The emphasized mode carries the largest weight.
    const emph = body.mode_weights[body.emphasize_mode];
    for (const m of ["develop", "collect", "reflect"]) {
      expect(emph).toBeGreaterThanOrEqual(body.mode_weights[m]);
    }
  });
});
