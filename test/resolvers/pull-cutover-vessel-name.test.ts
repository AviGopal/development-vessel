// PULL_CUTOVER'S VESSEL NAME IS SHAPE-CHECKED BEFORE IT REACHES A SHELL (security, check-first).
//
// pull_cutover takes vessel_name from its caller. When the vessel inventory is missing or empty it probes
// for a local clone or release checkout with `bash -lc '[ -d "<dir>" ] …'`, the directory built from
// vessel_name inside hand-written double quotes, in which bash expands a command substitution.
//
// Expected: a vessel_name that is not a plain vessel name ([A-Za-z0-9_.-], no '..') is refused before any
// shell command; the probe quotes its directory as one single-quoted word. CONTROL: a plain unknown name
// with an empty inventory is still probed and refused as "not in vessels.inventory", as before.
//
// AT BASE the hostile probe really runs under bash: its payload only touches a file inside this test's own
// mkdtemp sandbox (an absolute path into it), so the red is observable without touching anything else.
import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BOX = mkdtempSync(join(tmpdir(), "pull-cutover-name-"));
// The inventory is read through this env at module load: point it at a file that does not exist (empty inventory).
process.env["VESSELS_INVENTORY"] = join(BOX, "absent-inventory.json");
const { resolvePullCutover } = await import("../../src/resolvers/pull-cutover.js");
afterAll(() => rmSync(BOX, { recursive: true, force: true }));

describe("pull_cutover: vessel_name", () => {
  for (const [label, name, mark] of [
    ["a command substitution", `x$(touch ${BOX}/M1)`, "M1"],
    ["backticks", `x\`touch ${BOX}/M2\``, "M2"],
    ["a closing double quote", `x"; touch ${BOX}/M3; "`, "M3"],
  ] as const) {
    it(`MUST-FAIL: a name with ${label} is refused and its payload never runs`, async () => {
      const r = await resolvePullCutover({ type: "pull_cutover", vessel_name: name, dry_run: true });
      expect(r.body.valid).toBe(false);
      expect(existsSync(join(BOX, mark))).toBe(false);
      expect(String(r.body.note ?? "")).toContain("plain vessel name");
    });
  }
  it("CONTROL: a plain name missing from an empty inventory is probed and refused as before", async () => {
    const r = await resolvePullCutover({ type: "pull_cutover", vessel_name: "no-such-vessel-fixture", dry_run: true });
    expect(r.body.valid).toBe(false);
    expect(String(r.body.note ?? "")).toContain("not in vessels.inventory");
  });
  it("MUST-FAIL: the probe passes its directory as one single-quoted word", () => {
    const text = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "pull-cutover.ts"), "utf8");
    expect((text.match(/\[ -d "\$\{/g) ?? []).length).toBe(0);
    expect(text.split("[ -d ${shq(").length - 1).toBe(3);
  });
});
