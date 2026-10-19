// THE GAP FALSIFIER GRAMMAR'S GOLDEN TABLE, on this side: classifyFalsifier and class2PredicateKey (substrate-gap.ts)
// over test/fixtures/falsifier-grammar-golden.json. goal-host mirrors the grammar in its closed judge core
// (goal-host-vessel src/judge/falsifier-grammar.ts) to write a user goal's frozen predicate in it, and runs the
// byte-identical table through its mirror — a COPY of this grammar, named debt; its replacement is one implementation
// in a shared package both repos import (ias-executor-ts, or a super-repo packages/ module), after which this table and
// its two-sided pin are deleted. This file runs in this vessel's normal `bun test`, so a grammar change here reddens
// this side at its next gate. Both sides pin the table's sha256: a change to the table on one side reddens
// that side until the other changes with it, and a change to either implementation reddens its own side. Rows carry no
// edit site, since class-1 site reads are this vessel's alone.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFalsifier, class2PredicateKey } from "../../src/resolvers/substrate-gap.js";

const PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "falsifier-grammar-golden.json");
const RAW = readFileSync(PATH, "utf8");
export const GOLDEN_SHA256 = "568db1833e7950addded9282657fc373e7e02b7b224cb3535901a9cedecb1b11";
const golden = JSON.parse(RAW) as { vocabulary: string[]; cases: Array<{ name: string; meta: Record<string, unknown>; expect: Record<string, unknown> }> };
// A judgeable vocabulary (vocabularyIsJudgeable: >= 5 configs, >= 50 names): the table's names plus filler.
const vocab = { shapes: new Set<string>([...golden.vocabulary, ...Array.from({ length: 60 }, (_, i) => `filler_shape_${i}`)]), configs_read: 10 };

describe("the gap falsifier grammar's golden table (shared with goal-host's mirror)", () => {
  test("the table is the pinned one (both sides pin this sha256)", () => {
    expect(createHash("sha256").update(RAW).digest("hex")).toBe(GOLDEN_SHA256);
  });
  for (const c of golden.cases) test(c.name, () => {
    const r = classifyFalsifier(c.meta, vocab);
    expect({ falsifier: r.falsifier, predicate_position: r.predicate_position ?? null, predicate_shape: r.predicate_shape ?? null, predicate_mode: r.predicate_mode ?? null, unadvertised_shape: r.unadvertised_shape ?? null, key: class2PredicateKey(c.meta) }).toEqual(c.expect);
  });
});
