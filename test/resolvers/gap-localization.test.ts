// A GAP'S LOCALIZATION IS A GRADED, PERSISTED DECISION (development-vessel:gap-localization).
//
// localizeGap's answer was used once by decomposeGap and the compose pick and never persisted, traced or graded; the
// check supply's I1 persisted its own but traced nothing. The decision now runs after every localizer call.
//
//   [MUST-FAIL] variant-1 persists a non-null answer for a row with no edit site, in the check supply's form, and
//               traces it; the gap's next read of the persisted site credits reached, a different site not reached;
//               a scope that is unreadable or excludes the site, or a region not literal once in it, writes nothing;
//               a null is traced, never written; the check supply's own write is traced, not repeated.
//   [CONTROL]   variant-0 writes nothing, posts nothing, logs one decision line; a row that already had an edit site
//               is never rewritten; every caller passes the answer it used.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setGapLocalizationDepsForTests, noteGapLocalization, type GapLocalizationDeps } from "../../src/resolvers/gap-localization.js";

const ACTIVITY = "development-vessel:gap-localization";
const mask = (v: number) => () => [{ id: "m1", body: { activity_id: ACTIVITY, active_variant: v, from: "2000-01-01T00:00:00Z", until: "2099-01-01T00:00:00Z", by: "operator:test", reason: "test" } }];
const FILE = "repos/development-vessel/src/resolvers/widget.ts";
const GAP = { id: "g-1", category: "missing_behaviour", source: "test", summary: "the widget never retries", detected_at: "2000-01-01T00:00:00Z", status: "open", classification_metadata: { falsifier: { class: "class2" } } };
const ANSWER = { file: FILE, method: "grep_unique", description: "the only file naming the widget retry", candidates: 1 };
const readable = { excluded: ["repos/development-vessel/src/judge/"], readable: true, reason: "" };

afterEach(() => __setGapLocalizationDepsForTests(null));

function setup(v: number, over: Partial<GapLocalizationDeps> = {}) {
  const posted: Array<Record<string, unknown>> = [];
  const writes: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  let now = Date.parse("2000-01-01T00:00:00Z");
  const dir = mkdtempSync(join(tmpdir(), "gl-"));
  __setGapLocalizationDepsForTests({
    readMasks: mask(v), postTrace: async (t) => { posted.push(t); return 201; },
    write: async (w) => { writes.push(w); return { shape: "substrateGap" }; },
    scope: async () => readable as never, regionVerdict: () => ({ ok: true }), nowMs: () => now, stateFile: join(dir, "s.json"), ...over,
  });
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  return { posted, writes, lines, advance: (ms: number) => { now += ms; }, restore: () => { console.log = log; } };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("variant-0, the control", () => {
  it("[CONTROL] writes nothing, posts nothing, and logs one decision line, for an answer and for a null", async () => {
    const s = setup(0);
    try {
      const d1 = await noteGapLocalization({ caller: "compose_pick", gap: GAP, answer: ANSWER });
      const d2 = await noteGapLocalization({ caller: "decompose", gap: GAP, answer: null });
      await flush();
      expect([d1.written, d2.written]).toEqual([false, false]);
      expect(s.writes).toHaveLength(0);
      expect(s.posted).toHaveLength(0);
      expect(s.lines.filter((l) => l.includes(`[${ACTIVITY}] decision=`))).toHaveLength(2);
      expect(s.lines.some((l) => l.includes("variant=0") && l.includes("used once (as before)"))).toBe(true);
      expect(s.lines.some((l) => l.includes("null (parks as before)"))).toBe(true);
    } finally { s.restore(); }
  });
});

describe("variant-1", () => {
  it("[MUST-FAIL] a non-null answer for a row with no edit site is persisted in the check supply's form and traced", async () => {
    const s = setup(1);
    try {
      const d = await noteGapLocalization({ caller: "decompose", gap: GAP, answer: ANSWER });
      await flush();
      expect(d.written).toBe(true);
      expect(s.writes).toHaveLength(1);
      const g = s.writes[0]!["gap"] as Record<string, unknown>;
      expect(g["classification_metadata"]).toEqual({ edit_site: FILE, localized_by: "gap-localization:decompose", localization_method: "grep_unique" });
      expect(g["localization"]).toMatchObject({ gap_id: "g-1", file: FILE, method: "grep_unique" });
      expect(s.posted.map((t) => t["activity_id"])).toEqual([`${ACTIVITY}-v1`]);
      expect(s.posted[0]!["output_shapes"]).toEqual(["gapLocalization"]);
    } finally { s.restore(); }
  });

  it("[MUST-FAIL] the gap's next read of the persisted site credits reached; a different site credits not reached", async () => {
    const s = setup(1);
    try {
      const d = await noteGapLocalization({ caller: "compose_pick", gap: GAP, answer: ANSWER });
      const sited = { ...GAP, classification_metadata: { ...GAP.classification_metadata, edit_site: FILE } };
      await noteGapLocalization({ caller: "compose_pick", gap: sited, answer: { file: FILE, method: "metadata_edit_site", description: "named" } });
      await flush();
      const credit = s.posted.find((t) => t["activity_id"] === `${ACTIVITY}-credit`)!;
      expect(credit["success"]).toBe(true);
      expect(credit["composition_chain"]).toEqual([d.traceId]);
      await noteGapLocalization({ caller: "decompose", gap: { ...GAP, id: "g-2" }, answer: ANSWER });
      await noteGapLocalization({ caller: "compose_pick", gap: { ...GAP, id: "g-2" }, answer: { file: "repos/development-vessel/src/other.ts", method: "metadata_edit_site" } });
      await flush();
      const credits = s.posted.filter((t) => t["activity_id"] === `${ACTIVITY}-credit`);
      expect(credits).toHaveLength(2);
      expect(credits[1]!["success"]).toBe(false);
    } finally { s.restore(); }
  });

  it("[MUST-FAIL] an unreadable scope, an excluded site, or a region not literal once in it writes nothing", async () => {
    for (const over of [
      { scope: async () => ({ excluded: [], readable: false, reason: "lookup failed" }) as never },
      { scope: async () => { throw new Error("down"); } },
      { scope: async () => ({ excluded: ["repos/development-vessel/src/resolvers/"], readable: true, reason: "" }) as never },
    ]) {
      const s = setup(1, over);
      try {
        const d = await noteGapLocalization({ caller: "decompose", gap: GAP, answer: ANSWER });
        expect(d.written, d.outcome).toBe(false);
        expect(d.outcome).toContain("not written");
        expect(s.writes).toHaveLength(0);
      } finally { s.restore(); }
    }
    const s = setup(1, { regionVerdict: () => ({ ok: false }) });
    try {
      const d = await noteGapLocalization({ caller: "decompose", gap: { ...GAP, classification_metadata: { ...GAP.classification_metadata, region: "retry()" } }, answer: ANSWER });
      expect(d.outcome).toContain("region not literal once");
      expect(s.writes).toHaveLength(0);
    } finally { s.restore(); }
  });

  it("[MUST-FAIL] a null is traced and never written; the check supply's sited answer is traced and not written again", async () => {
    const s = setup(1);
    try {
      await noteGapLocalization({ caller: "decompose", gap: GAP, answer: null });
      await noteGapLocalization({ caller: "check_supply", gap: GAP, answer: { file: FILE, method: "check_supply_site" } });
      await flush();
      expect(s.writes).toHaveLength(0);
      expect(s.posted).toHaveLength(2);
      expect(s.posted.map((t) => (t["metadata"] as Record<string, Record<string, unknown>>)["gapLocalization"]!["file"])).toEqual([null, FILE]);
    } finally { s.restore(); }
  });

  it("[CONTROL] a row that already had an edit site is never rewritten", async () => {
    const s = setup(1);
    try {
      const d = await noteGapLocalization({ caller: "compose_pick", gap: { ...GAP, classification_metadata: { edit_site: "repos/development-vessel/src/x.ts" } }, answer: ANSWER });
      expect(d.written).toBe(false);
      expect(s.writes).toHaveLength(0);
    } finally { s.restore(); }
  });

  it("[CONTROL] a decision with no localizer read in 48 h is dropped ungraded", async () => {
    const s = setup(1);
    try {
      await noteGapLocalization({ caller: "decompose", gap: GAP, answer: ANSWER });
      s.advance(48 * 3_600_000);
      await noteGapLocalization({ caller: "compose_pick", gap: { ...GAP, id: "g-other" }, answer: null });
      await noteGapLocalization({ caller: "compose_pick", gap: GAP, answer: { file: FILE, method: "metadata_edit_site" } });
      await flush();
      expect(s.posted.filter((t) => t["activity_id"] === `${ACTIVITY}-credit`)).toHaveLength(0);
      expect(s.lines.some((l) => l.includes("ungraded") && l.includes("within 48 h"))).toBe(true);
    } finally { s.restore(); }
  });
});

describe("the callers", () => {
  it("[MUST-FAIL] decomposeGap, the compose pick and the check supply each record the answer they used", () => {
    const src = (f: string) => readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", f), "utf8");
    // decomposeGap was lifted to src/landing/gap-decompose.ts: its record is read there, the compose pick's in gap-to-feature.
    const g2f = src("gap-to-feature.ts") + "\n" + readFileSync(join(import.meta.dir, "..", "..", "src", "landing", "gap-decompose.ts"), "utf8");
    expect(g2f).toContain('const loc = await localizeGap(parent, { useLlm: true });\n    await noteGapLocalization({ caller: "decompose", gap: parent, answer: loc });');
    expect(g2f).toMatch(/catch \{ localized = null; \}\n    await noteGapLocalization\(\{ caller: "compose_pick", gap, answer: localized \}\);/);
    const gcs = src("gap-check-supply.ts");
    expect(gcs.match(/noteGapLocalization\(\{ caller: "check_supply"/g)?.length).toBe(2);
  });
});
