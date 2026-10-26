/**
 * EVERY pinned drafter dispatch in src declares the drafter's write (the class form of
 * pattern-feeders-declare-drafter-write.test.ts, which drives three named feeders).
 *
 * goal-host's write door hands the executor a task-level door; on a pinned /run-goal not admitted as a change, the
 * drafter's register_variant (activity_create_variant) is skipped before it runs and recorded as success, skipped,
 * write_door_not_admitted, with no output. A dispatch is admitted only when its caller declares the change shape in
 * expected_output_shapes. Three feeders were fixed by name and a fourth (vessel_arrival_scan's cluster author) was
 * missed, so this test scans src instead of listing files: a new feeder that pins the drafter without declaring the
 * write fails here.
 *
 * A site is a `targetTemplateId` that pins the drafter LITERALLY: the DRAFTER_TEMPLATE_ID identifier or its string
 * value. A templated id (`{{drafter_template_id}}`) is NOT a site: it can render unbound, and then a write declaration
 * on what is no longer a pinned dispatch would admit a free walk as a change, the opposite of the door's purpose. That
 * exclusion is pinned below (refine-on-disagreement's templated dispatch is not required to declare). Its body is the
 * `JSON.stringify({ ... })` object that encloses it, brace-matched, and that object must carry
 * `expected_output_shapes`.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SRC = join(ROOT, "src");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const SITE = /targetTemplateId\s*:\s*(?:DRAFTER_TEMPLATE_ID\b|"development-vessel:draft-activity-from-pattern")/g;
/** A templated drafter id: deliberately not a site. */
const TEMPLATED = /targetTemplateId\s*:\s*"\{\{drafter_template_id\}\}"/;

/** The object literal that encloses `at`: the nearest unmatched `{` before it, matched to its `}`. */
function enclosingObject(text: string, at: number): string | null {
  let depth = 0;
  let open = -1;
  for (let i = at; i >= 0; i--) {
    const c = text[i];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth === 0) { open = i; break; }
      depth--;
    }
  }
  if (open < 0) return null;
  depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

interface Site { where: string; body: string | null; stringified: boolean }
const sites: Site[] = [];
for (const file of tsFiles(SRC)) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(SITE)) {
    const at = m.index ?? 0;
    const line = text.slice(0, at).split("\n").length;
    const body = enclosingObject(text, at);
    const open = body ? text.lastIndexOf(body, at) : -1;
    const stringified = open >= 0 && /JSON\.stringify\(\s*$/.test(text.slice(Math.max(0, open - 40), open));
    sites.push({ where: `${relative(ROOT, file)}:${line}`, body, stringified });
  }
}

describe("every pinned drafter dispatch in src declares expected_output_shapes", () => {
  test("the scan finds the known sites (not vacuous)", () => {
    expect(sites.length).toBeGreaterThanOrEqual(3);
    const files = new Set(sites.map((s) => s.where.replace(/:\d+$/, "")));
    for (const f of [
      "src/resolvers/trace-recurring-pattern-scan.ts",
      "src/resolvers/vessel-gap-to-cluster.ts",
      "src/resolvers/vessel-arrival-scan.ts",
    ]) expect(files.has(f)).toBe(true);
  });

  const seen = new Map<string, number>();
  for (const s of sites) {
    // Named by file and ordinal (not line), so a test keeps its name when lines above it move.
    const file = s.where.replace(/:\d+$/, "");
    const k = (seen.get(file) ?? 0) + 1;
    seen.set(file, k);
    const name = `${file}#${k}`;
    test(`MUST-FAIL: ${name}: the /run-goal body pinning the drafter declares expected_output_shapes`, () => {
      expect(s.body).not.toBeNull();
      expect(s.stringified).toBe(true);
      expect(s.body!).toMatch(/\bexpected_output_shapes\s*:/);
    });
  }
});

describe("CONTROL: a templated drafter id is excluded on purpose", () => {
  test("refine-on-disagreement's {{drafter_template_id}} dispatch is not a site and is not required to declare", () => {
    const rel = "src/seed/refine-on-disagreement.ts";
    const text = readFileSync(join(ROOT, rel), "utf8");
    const m = TEMPLATED.exec(text);
    expect(m).not.toBeNull();
    expect(sites.some((s) => s.where.startsWith(`${rel}:`))).toBe(false);
    // And it does not declare: a write declaration there could admit an unpinned dispatch as a change.
    expect(enclosingObject(text, m!.index)!).not.toMatch(/\bexpected_output_shapes\s*:/);
  });
});

describe("CONTROL: the window is the body object, not the file", () => {
  test("a body without the field fails the predicate even when a sibling body in the same text has it", () => {
    const text = [
      `a(JSON.stringify({ goal: "x", targetTemplateId: DRAFTER_TEMPLATE_ID, expected_output_shapes: W }));`,
      `b(JSON.stringify({ goal: "y", targetTemplateId: DRAFTER_TEMPLATE_ID, variables: { k: 1 } }));`,
    ].join("\n");
    const found = [...text.matchAll(SITE)].map((m) => enclosingObject(text, m.index ?? 0)!);
    expect(found.length).toBe(2);
    expect(/\bexpected_output_shapes\s*:/.test(found[0]!)).toBe(true);
    expect(/\bexpected_output_shapes\s*:/.test(found[1]!)).toBe(false);
  });
});
