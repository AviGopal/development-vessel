// The additive registration rule (gap-policy.ts additiveRegistration, the cutover's rule) also runs at the compose's
// autonomy-scope floor. Before, an autonomous compose that wrote a vessel's two registration files was withheld at the
// floor, so the rule never ran (0 "ADDITIVE REGISTRATION" lines on either compose node over 7 d) and no missing-producer
// compose could land. Fixtures mirror the rule's own suite (cutover-autonomy-scope.test.ts).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as fc from "../../src/resolvers/feature-compose";

const additiveRegistrationAtFloor = (fc as unknown as { additiveRegistrationAtFloor?: (h: string[], p: string[], io: unknown) => Promise<{ admitted: boolean; why: string }> }).additiveRegistrationAtFloor;
const V = "development-vessel";
const BASE_CONFIG = `export const config = {\n  discovery: {\n    shapes: [\n      "alpha_report",\n      "beta_summary",\n    ],\n  },\n  labels: [\n    "x",\n  ],\n};\n`;
const BASE_ROUTES = `import { resolveAlpha } from "../resolvers/alpha.js";\nexport async function dispatch(pointer: any): Promise<unknown> {\n  switch (pointer.type) {\n    case "alpha_report": return resolveAlpha(pointer as any);\n    default:\n      throw new Error("Unknown pointer type");\n  }\n}\n`;
const NEW_MODULE = `export async function resolveGammaDigest(pointer: any): Promise<unknown> {\n  return { shape: "gamma_digest", body: { rows: [] as unknown[], pointer } };\n}\n`;
const CONFIG_AFTER = BASE_CONFIG.replace('      "beta_summary",\n', '      "beta_summary",\n      "gamma_digest",\n');
const ROUTES_AFTER = BASE_ROUTES
  .replace(`import { resolveAlpha } from "../resolvers/alpha.js";\n`, `import { resolveAlpha } from "../resolvers/alpha.js";\nimport { resolveGammaDigest } from "../resolvers/gamma-digest.js";\n`)
  .replace("    default:\n", `    case "gamma_digest": return resolveGammaDigest(pointer as any);\n    default:\n`);

type Files = Record<string, { before: string | null; after: string | null }>;
const files = (over: Files = {}): Files => ({
  "src/config.ts": { before: BASE_CONFIG, after: CONFIG_AFTER },
  "src/routes/impulses.ts": { before: BASE_ROUTES, after: ROUTES_AFTER },
  "src/resolvers/gamma-digest.ts": { before: null, after: NEW_MODULE },
  ...over,
});
const io = (f: Files, advertised: boolean | null = false) => ({
  before: async (_v: string, rel: string) => f[rel]?.before ?? null,
  after: async (_v: string, rel: string) => f[rel]?.after ?? null,
  advertised: async () => advertised,
});
const HITS = [`repos/${V}/src/config.ts`, `repos/${V}/src/routes/impulses.ts`];
const pathsOf = (f: Files) => Object.keys(f).map((rel) => `repos/${V}/${rel}`);

describe("additive registration at the compose floor", () => {
  test("[MUST-FAIL] a pure new-shape registration of a new module is admitted at the floor", async () => {
    expect(typeof additiveRegistrationAtFloor).toBe("function");
    const r = await additiveRegistrationAtFloor!(HITS, pathsOf(files()), io(files()));
    expect(r.admitted).toBe(true);
    expect(r.why).toContain("gamma_digest");
  });
  test("[CONTROL] modifying an existing registry line is still withheld", async () => {
    const f = files({ "src/config.ts": { before: BASE_CONFIG, after: CONFIG_AFTER.replace('"alpha_report"', '"alpha_reports"') } });
    expect((await additiveRegistrationAtFloor!(HITS, pathsOf(f), io(f))).admitted).toBe(false);
  });
  test("[CONTROL] any other excluded hit is still withheld", async () => {
    const r = await additiveRegistrationAtFloor!([...HITS, `repos/${V}/src/judge/gap-policy.ts`], pathsOf(files()), io(files()));
    expect(r.admitted).toBe(false);
    expect(r.why).toContain("src/judge/gap-policy.ts");
  });
  test("[CONTROL] a registration with no new module in the change is still withheld", async () => {
    const f = files(); delete f["src/resolvers/gamma-digest.ts"];
    expect((await additiveRegistrationAtFloor!(HITS, pathsOf(f), io(f))).admitted).toBe(false);
  });
  test("[CONTROL] hits in two vessels, an advertised shape, or an unreadable worktree are withheld", async () => {
    expect((await additiveRegistrationAtFloor!([HITS[0]!, "repos/other-vessel/src/config.ts"], pathsOf(files()), io(files()))).admitted).toBe(false);
    expect((await additiveRegistrationAtFloor!(HITS, pathsOf(files()), io(files(), true))).admitted).toBe(false);
    expect((await additiveRegistrationAtFloor!(HITS, pathsOf(files()), io(files(), null))).admitted).toBe(false);
    const unreadable = { before: async () => null, after: async () => null, advertised: async () => false };
    expect((await additiveRegistrationAtFloor!(HITS, pathsOf(files()), unreadable)).admitted).toBe(false);
  });
  test("[MUST-FAIL] the floor branch consults the rule before withholding a registration-only hit", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "feature-compose.ts"), "utf8");
    const at = src.indexOf("autonomy-scope floor: WITHHELD FAVORABLE - autonomous compose touched excluded path(s)");
    const window = src.slice(Math.max(0, at - 1200), at);
    expect(window).toContain("additiveRegistrationAtFloor(scopeHits, floorInput.paths, floorRegistrationIo(ws))");
  });
});

describe("the floor's WITHHELD line is unchanged unless the rule actually ran", () => {
  test("a non-registration excluded hit is not 'considered' (its WITHHELD line stays byte-identical)", async () => {
    const r = await additiveRegistrationAtFloor!([`repos/${V}/src/judge/gap-policy.ts`], pathsOf(files()), io(files()));
    expect((r as { considered?: boolean }).considered).toBe(false);
  });
  test("a registration-only change is 'considered' whether admitted or refused", async () => {
    expect(((await additiveRegistrationAtFloor!(HITS, pathsOf(files()), io(files()))) as { considered?: boolean }).considered).toBe(true);
    expect(((await additiveRegistrationAtFloor!(HITS, pathsOf(files()), io(files(), true))) as { considered?: boolean }).considered).toBe(true);
  });
});
