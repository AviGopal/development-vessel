// PARITY: lineageOrigin over a LineageIndex (the id rule's lookup built once per pass) returns exactly what it returns
// over the plain map, row by row: indexedLineageAncestors === lineageAncestors and indexedLineageUnknown ===
// lineageUnknown. Read over the vendored archive snapshot (fixtures/lineage-archive-rows.json, the real ids lineage
// reads) plus synthetic rows that exercise every link field, recommit depths, "-" prefixes and a cycle.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { indexedLineageAncestors, indexedLineageUnknown, lineageAncestors, lineageIndex, lineageOrigin, lineageUnknown, LineageIndex, type GapRow } from "../../src/resolvers/operator-acts.js";

const FIX = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "lineage-archive-rows.json"), "utf8")) as { rows: GapRow[] };
const SYN: GapRow[] = [
  { id: "a-root", source: "substrate_detected" }, { id: "a-root-narrowed", source: "development vessel" },
  { id: "recommit-a-root-narrowed", source: "substrate_detected" }, { id: "recommit-recommit-a-root-narrowed-step-2", source: "substrate_detected" },
  { id: "-lead", source: "substrate_detected" }, { id: "x", source: "substrate_detected" }, { id: "x-y-z", source: "operator" },
  { id: "linked", source: "substrate_detected", classification_metadata: { parent_gap_id: "a-root", root_gap: "gone-root" } },
  { id: "cyc-1", classification_metadata: { root_gap_id: "cyc-2" } }, { id: "cyc-2", parent_gap: "cyc-1", source: "substrate_detected" },
  { id: "recommit-orphan", source: "substrate_detected" },
];
const sorted = (s: Set<string>) => [...s].sort();

describe("lineage index parity", () => {
  for (const [name, rows] of [["archive snapshot", FIX.rows], ["synthetic", SYN], ["both", [...FIX.rows, ...SYN]]] as const) {
    it(`every row of the ${name}: same ancestors, same unseen, same origin`, () => {
      const plain = new Map<string, GapRow>(rows.map((r) => [String(r["id"]), r]));
      const idx = lineageIndex(plain);
      let n = 0;
      for (const id of plain.keys()) {
        expect(sorted(indexedLineageAncestors(id, idx))).toEqual(sorted(lineageAncestors(id, plain)));
        expect(indexedLineageUnknown(id, idx)).toEqual(lineageUnknown(id, plain));
        expect(lineageOrigin(id, plain.get(id), idx)).toEqual(lineageOrigin(id, plain.get(id), plain));
        n++;
      }
      expect(n).toBe(plain.size);
    });
  }
  it("a write through the index drops its lookup", () => {
    const idx = lineageIndex(new Map<string, GapRow>([["p-root", { id: "p-root", source: "substrate_detected" }]]));
    expect(idx).toBeInstanceOf(LineageIndex);
    expect(sorted(indexedLineageAncestors("p-root-narrowed", idx))).toEqual(["p-root"]);
    idx.set("p", { id: "p" });
    expect(sorted(indexedLineageAncestors("p-root-narrowed", idx))).toEqual(["p", "p-root"]);
    idx.delete("p-root");
    expect(sorted(indexedLineageAncestors("p-root-narrowed", idx))).toEqual(["p"]);
    expect(lineageIndex(idx)).toBe(idx);
  });
});
