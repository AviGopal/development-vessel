// THE LOCALIZER READS THE LOCATION A DETECTOR ROW ALREADY CARRIES.
//
// The env-gate detector (src/resolvers/env-gate-scan.ts) writes classification_metadata.sites: [{vessel, file, line}],
// file as a bare "<vessel>/src/…", and no edit_site. localizeGap's metadata loop read only suspected_real_location,
// edit_site, change_site and file_path, so these rows were never sited from their own evidence, and every
// "investigate and decompose" walk declined needs_information (no readable edit site). And identifyVessel's id rule
// needed a hyphen (or the end) after a vessel name, so a capability detector's "…-<vessel>_<capability>-zero" id named
// no vessel. Expected (fixture runtime tree and clone root, scope injected, fetch refused):
//   - [MUST-FAIL] an env-gated row whose sites[].file exists is sited there (metadata_edit_site);
//   - [MUST-FAIL] identifyVessel takes "development-vessel" from "systematic-failure-development-vessel_…-zero";
//   - CONTROL: a row without sites (and nothing else to go on) is unchanged (no site); a row with an edit_site keeps it;
//   - CONTROL: an id whose "<name>_" prefix is no existing vessel, or is only part of a longer token, names none;
//   - CONTROL: a sites[] file the autonomy scope excludes is no site (directed work: taken); a missing sites[] file is
//     skipped for the next one.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "localize-sites-"));
const RUNTIME = join(ROOT, "runtime");
const CLONES = join(ROOT, "clones");
const ENV_KEYS = ["MITOSIS_RUNTIME_DIR", "VESSELS_CLONE_ROOT"] as const;
const saved: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const FILES = ["activity-api/src/lib/prior-seed.ts", "development-vessel/src/resolvers/fs-write.ts", "development-vessel/src/resolvers/other.ts"];
for (const rel of FILES) for (const base of [RUNTIME, CLONES]) {
  mkdirSync(join(base, rel, ".."), { recursive: true });
  writeFileSync(join(base, rel), "export const x = 1;\n");
}
process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
process.env["VESSELS_CLONE_ROOT"] = CLONES;

const gp = (await import("../../src/judge/gap-policy.js")) as Record<string, any>;
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const RUN = Math.random().toString(36).slice(2, 8);
const realFetch = globalThis.fetch;
let excluded: string[] = [];
/** The fixture scope for the next read (autonomyScope caches a read, so each change resets the policy reads). */
const scopeExcluding = (paths: string[]): void => { excluded = paths; gp.__resetPolicyReadsForTests(); };
beforeAll(() => {
  globalThis.fetch = (async () => { throw new Error("fetch refused (fixture)"); }) as unknown as typeof fetch;
  gp.__setAutonomyScopeDepsForTests({ live: async () => ({ excluded, readable: true, reason: "fixture scope", requireFalsifierClasses: [], exceptions: gp.parseScopeExceptions([]) }), boundS: () => 0, now: () => Date.now() });
});
afterAll(() => {
  globalThis.fetch = realFetch;
  gp.__setAutonomyScopeDepsForTests(null);
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(ROOT, { recursive: true, force: true });
});

const envGated = (id: string, sites: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  id: `${id}-${RUN}`, category: "systematic_failure", summary: "an env var gates a capability",
  classification_metadata: { falsifier: "none", disposition: "needs_localization", sites, ...extra },
});
const PRIOR = { vessel: "activity-api", env_name: "PRIOR_SEED_ENABLED", file: "activity-api/src/lib/prior-seed.ts", line: 74 };

describe("localizeGap reads a detector row's structured sites; identifyVessel reads a <vessel>_ id", () => {
  it("[MUST-FAIL] an env-gated row whose sites[].file exists is sited there", async () => {
    scopeExcluding([]);
    const r = await g2f.localizeGap(envGated("gap-env-gated-prior-seed-enabled", [PRIOR]), { useLlm: false });
    expect(r?.file).toBe("repos/activity-api/src/lib/prior-seed.ts");
    expect(r?.method).toBe("metadata_edit_site");
    expect(r?.vessel).toBe("activity-api");
  });

  it("[MUST-FAIL] identifyVessel takes the vessel from a capability detector's <vessel>_ id", () => {
    expect(gp.identifyVessel({ id: "systematic-failure-development-vessel_own-check-baseline-zero" }, {})).toBe("development-vessel");
    expect(gp.identifyVessel({ id: "systematic-failure-development-vessel_draft-gap-closing-activity-zero" }, {})).toBe("development-vessel");
  });

  it("[CONTROL] a row without sites is unchanged; a row with an edit_site keeps it", async () => {
    scopeExcluding([]);
    expect(await g2f.localizeGap({ id: `gap-env-gated-nothing-${RUN}`, summary: "no evidence", classification_metadata: { falsifier: "none" } }, { useLlm: false })).toBeNull();
    const own = await g2f.localizeGap(envGated("gap-env-gated-own", [PRIOR], { edit_site: "repos/development-vessel/src/resolvers/other.ts" }), { useLlm: false });
    expect(own?.file).toBe("repos/development-vessel/src/resolvers/other.ts");
    expect(own?.description).toContain("(edit_site)");
  });

  it("[CONTROL] an invalid vessel prefix is still rejected", () => {
    expect(gp.identifyVessel({ id: "systematic-failure-no-such-vessel_own-check-baseline-zero" }, {})).toBeNull();
    expect(gp.identifyVessel({ id: "systematic-failure-xdevelopment-vessel_own-check-baseline-zero" }, {})).toBeNull();
    expect(gp.identifyVessel({ id: "systematic-failure-development-vessels_x-zero" }, {})).toBeNull();
  });

  it("[CONTROL] the autonomy scope is honored for a sites[] file; a missing sites[] file is skipped", async () => {
    scopeExcluding(["repos/activity-api/src/lib/"]);
    expect(await g2f.localizeGap(envGated("gap-env-gated-excluded", [PRIOR]), { useLlm: false })).toBeNull();
    const directed = await g2f.localizeGap(envGated("gap-env-gated-excluded-directed", [PRIOR]), { useLlm: false, directed: true });
    expect(directed?.file).toBe("repos/activity-api/src/lib/prior-seed.ts");
    scopeExcluding([]);
    const next = await g2f.localizeGap(envGated("gap-env-gated-missing-first", [{ vessel: "development-vessel", file: "development-vessel/src/resolvers/not-there.ts", line: 1 }, { vessel: "development-vessel", file: "development-vessel/src/resolvers/fs-write.ts", line: 30 }]), { useLlm: false });
    expect(next?.file).toBe("repos/development-vessel/src/resolvers/fs-write.ts");
  });
});
