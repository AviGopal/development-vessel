// PROTECTED: the localizationRecord schema (localization-record.schema.json) and the core's run-time check
// (src/resolvers/compose-admission-core.ts validLocalizationRecord, the same rule as goal-host's) agree, so "a file edit needs a valid localization record"
// means the same thing in the corpus, the schema the producer writes to, and production.
//   - a minimal evaluator of the schema's own keywords (type, required, anyOf/required, additionalProperties,
//     minLength, minItems, pattern, items, format date-time) judges each fixture; the validator must agree on every one;
//   - the file is byte-identical in goal-host's routing corpus (one schema across the fleet; checked there by review).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validLocalizationRecord } from "../../src/resolvers/compose-admission-core.js";

type Schema = Record<string, any>;
const SCHEMA = JSON.parse(readFileSync(join(import.meta.dir, "localization-record.schema.json"), "utf8")) as Schema;

export function schemaAccepts(s: Schema, v: unknown): boolean {
  if (s.type === "object") {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const o = v as Record<string, unknown>;
    if ((s.required ?? []).some((k: string) => !(k in o))) return false;
    if (s.anyOf && !s.anyOf.some((alt: Schema) => (alt.required ?? []).every((k: string) => k in o))) return false;
    if (s.additionalProperties === false && Object.keys(o).some((k) => !(k in (s.properties ?? {})))) return false;
    return Object.entries(s.properties ?? {}).every(([k, ps]) => !(k in o) || schemaAccepts(ps as Schema, o[k]));
  }
  if (s.type === "array") {
    if (!Array.isArray(v)) return false;
    if (s.minItems !== undefined && v.length < s.minItems) return false;
    return !s.items || v.every((x) => schemaAccepts(s.items, x));
  }
  if (s.type === "string") {
    if (typeof v !== "string") return false;
    if (s.minLength !== undefined && v.length < s.minLength) return false;
    if (s.pattern && !new RegExp(s.pattern).test(v)) return false;
    if (s.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T/.test(v) || Number.isNaN(Date.parse(v)))) return false;
    return true;
  }
  return false;
}

const F = "repos/example-vessel/src/x.ts";
const valid = { gap_id: "gap-x", file: F, evidence: [{ read: F, why: "the predicate lives here" }], method: "read-and-cite", created_at: "2026-10-12T00:00:00Z" };
const FIXTURES: Array<[string, unknown, boolean]> = [
  ["valid (gap_id)", valid, true],
  ["valid (dispatch_id)", { ...valid, gap_id: undefined, dispatch_id: "d-1" }, true],
  ["no gap_id or dispatch_id", { ...valid, gap_id: undefined }, false],
  ["empty evidence", { ...valid, evidence: [] }, false],
  ["evidence without why", { ...valid, evidence: [{ read: F }] }, false],
  ["evidence with an extra key", { ...valid, evidence: [{ read: F, why: "w", score: 1 }] }, false],
  ["a file that is not a repos path", { ...valid, file: "src/x.ts" }, false],
  ["no method", { ...valid, method: undefined }, false],
  ["created_at not a date-time", { ...valid, created_at: "yesterday" }, false],
  ["an extra key", { ...valid, verdict: "reached" }, false],
  ["not an object", "repos/example-vessel/src/x.ts", false],
];
const clean = (v: unknown) => JSON.parse(JSON.stringify(v ?? null));

describe("localizationRecord: schema and validator agree", () => {
  for (const [label, v, want] of FIXTURES) {
    test(`${label}: schema ${want ? "accepts" : "rejects"}, and so does the validator`, () => {
      expect(schemaAccepts(SCHEMA, clean(v))).toBe(want);
      expect(validLocalizationRecord(clean(v))).toBe(want);
    });
  }
  test("MUTANT a validator that accepts empty evidence disagrees with the schema", () => {
    const loose = (v: unknown) => !!v && typeof v === "object" && typeof (v as { file?: unknown }).file === "string";
    expect(FIXTURES.some(([, v, want]) => loose(clean(v)) !== want)).toBe(true);
  });
});
