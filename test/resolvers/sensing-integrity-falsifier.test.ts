import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { DISCOVERY_SHAPES } from "../../src/config.js";
import {
  SENSING_PROBE_PREDICATES,
  buildSensingGapWrite,
} from "../../src/resolvers/sensing-integrity-tick.js";
import { classifyFalsifier } from "../../src/resolvers/substrate-gap.js";

// A DETECTOR MUST EMIT THE FALSIFIER IT ALREADY HOLDS (2026-09-01).
//
// sensing-integrity-tick fires when a known-answer probe returns EMPTY SUCCESS.
// "Empty" is a measurement the probe already made against a fixture guaranteed to
// answer nonzero — and it was discarded at write time, so the gap was born with
// nothing to test. 488 of 490 open gaps classified `falsifier:"none"` for exactly
// this reason, and 703 of 1207 settled gaps left by the 30-day timer rather than by
// anyone knowing they were fixed.
//
// These tests pin the three things that make such a predicate real rather than
// decorative: the shape name is one the REGISTRY ADVERTISES (a return-shape name
// resolves to nothing and is inert), the polarity is health-not-defect (heuristic 2
// reads zero as "defect present"), and the store's own census agrees it is class2.

const REPO_ROOT = join(import.meta.dir, "..", "..");

describe("sensing-integrity-tick emits a class-2 falsifier", () => {
  it("every probe predicate names an ADVERTISED shape, read from config.ts", () => {
    // Read the advertised vocabulary from the source of truth rather than a copy:
    // the substrate wrote `trace_failure` and then `failurePatternReport` into a
    // predicate where the advertised name is `trace_failure_pattern_report`, and
    // both typechecked. Only the registry's list can catch that.
    const advertised = new Set(DISCOVERY_SHAPES);
    expect(advertised.size).toBeGreaterThan(50);
    for (const [probe, p] of Object.entries(SENSING_PROBE_PREDICATES)) {
      expect(`${probe}:${p.shape}:${advertised.has(p.shape)}`).toBe(
        `${probe}:${p.shape}:true`,
      );
    }
  });

  it("the advertised names also appear literally in src/config.ts", () => {
    // DISCOVERY_SHAPES is derived from the inline literal; assert against the file
    // text too, so a refactor that decouples the export from the literal is caught.
    const configText = readFileSync(join(REPO_ROOT, "src", "config.ts"), "utf8");
    for (const p of Object.values(SENSING_PROBE_PREDICATES)) {
      expect(configText.includes(`"${p.shape}"`) || configText.includes(`'${p.shape}'`)).toBe(true);
    }
  });

  it("each failing probe's gap write carries evidence_resolve with the probe's own fixture", () => {
    const scaGap = buildSensingGapWrite("source-code-analysis", new Date("2026-09-01T00:00:00Z"))
      .gap as Record<string, unknown>;
    const scaMeta = scaGap.classification_metadata as Record<string, unknown>;
    expect(scaMeta.evidence_resolve).toEqual({
      shape: "sourceCodeAnalysis",
      input: { target_path: "repos/development-vessel" },
      nonzero_field: "file_count",
    });

    const fsGap = buildSensingGapWrite("fs-list", new Date("2026-09-01T00:00:00Z"))
      .gap as Record<string, unknown>;
    const fsMeta = fsGap.classification_metadata as Record<string, unknown>;
    expect(fsMeta.evidence_resolve).toEqual({
      shape: "fs_list",
      input: { path: "/vessels/development-vessel" },
      nonzero_field: "count",
    });
  });

  it("the write is otherwise unchanged — id, summary, category, edit_site, status", () => {
    const gap = buildSensingGapWrite("fs-list", new Date("2026-09-01T12:34:56Z")).gap as Record<string, unknown>;
    expect(gap.id).toBe("sensing-empty-success-fs-list-2026-09-01");
    expect(gap.category).toBe("systematic_failure");
    expect(gap.source).toBe("sensing-integrity-tick");
    expect(gap.status).toBe("open");
    expect(String(gap.summary)).toContain("EMPTY SUCCESS");
    expect((gap.classification_metadata as Record<string, unknown>).edit_site).toBe(
      "repos/development-vessel/src/resolvers/fs-list.ts",
    );
    expect((gap.classification_metadata as Record<string, unknown>).failing_capability).toBe("fs-list");
  });

  it("classifyFalsifier grades each new predicate class2 — not none, not unresolvable", () => {
    const vocab = { shapes: new Set(DISCOVERY_SHAPES), configs_read: 99 } as never;
    for (const probe of Object.keys(SENSING_PROBE_PREDICATES)) {
      const meta = (buildSensingGapWrite(probe).gap as Record<string, unknown>)
        .classification_metadata as Record<string, unknown>;
      const c = classifyFalsifier(meta, vocab);
      expect(`${probe}:${c.falsifier}`).toBe(`${probe}:class2`);
      expect(c.predicate_position).toBe("evidence_resolve.shape");
    }
  });

  it("a probe with no registered predicate still emits — bare, with no fabricated one", () => {
    // "none" is an honest answer. The tick's third probe is a placeholder fixture
    // and holds nothing measurable; it must not acquire a decorative predicate.
    const gap = buildSensingGapWrite("probe-3-placeholder").gap as Record<string, unknown>;
    const meta = gap.classification_metadata as Record<string, unknown>;
    expect(gap.id).toContain("sensing-empty-success-probe-3-placeholder");
    expect("evidence_resolve" in meta).toBe(false);
    expect(classifyFalsifier(meta, { shapes: new Set(DISCOVERY_SHAPES), configs_read: 99 } as never).falsifier).toBe("none");
  });
});

describe("the deliberately skipped detectors stay honest", () => {
  // self-interference-scan CONSUMES its own evidence: it unlinks the inflight marker
  // (`unlink(markerDir/entry)`) and the stale live-edit pulse at scan time, so nothing
  // is re-measurable afterwards. obsidian-request-scan records a transient human-mid-edit
  // deferral. Neither can state what "fixed" would look like, so neither gets a predicate.
  for (const detector of ["self-interference-scan", "obsidian-request-scan"]) {
    it(`${detector} emits no evidence_resolve`, () => {
      const src = readFileSync(join(REPO_ROOT, "src", "resolvers", `${detector}.ts`), "utf8");
      expect(src.includes("evidence_resolve")).toBe(false);
      expect(src.includes("resolveSubstrateGapWrite")).toBe(true);
    });
  }

  it("a transient incident's metadata classifies none, and that is the correct census answer", () => {
    const meta = { incident_kind: "killed_authoring_run", detail: "…pid 4242 dead; marker removed" };
    expect(classifyFalsifier(meta, { shapes: new Set(DISCOVERY_SHAPES), configs_read: 99 } as never).falsifier).toBe("none");
  });
});
