// docs_align_scan contract.
//
// Two contract generations live here:
// - The ORIGINAL parked it.todo contract (bottom) envisioned an fs-reading
//   resolver (DOC_FIX_ROOT) that wrote substrateGaps itself with a dry_run
//   flag. That design was superseded for generalization: an fs-bound scan
//   cannot serve non-filesystem corpora (vault notes via obsidian:*), and
//   resolver-side gap writes couple detection to emission.
// - The CURRENT v1 contract: the resolver consumes an inline
//   documentCorpusSlice (documents as data), producers bind upstream in
//   activities (fs_read/fs_grep for repo docs, obsidian:note/obsidian:search
//   for the vault), and gap emission belongs to a downstream
//   findings-to-gaps activity (where the original dry_run gating now lives).
//   The original todos' INTENT is preserved: seed-live drift is a
//   setup_enablement/accuracy finding over a corpus document.
//
// Design constraints the v1 behavior honors:
// - CORPUS-ABSTRACT INPUT: never filesystem paths.
// - DATA-DRIVEN VOCABULARY: naming alignment reads memoryNote
//   canonical-naming-vocabulary at scan time; no hardcoded branding lists.
// - LIVE-TRUTH JOINS: accuracy/setup findings join against provided
//   live-truth slices (advertised shapes, endpoints, unit names, paths) —
//   supplied as inputs so the scan stays deterministic.
import { describe, it, expect } from "bun:test";
import { resolveDocsAlignScan } from "../../src/resolvers/docs-align-scan.js";

describe("docs_align_scan v1 (implemented behavior)", () => {
  it("scans an inline corpus for all four invariants with no fs access", async () => {
    const res = await resolveDocsAlignScan({
      type: "docs_align_scan",
      corpus: {
        documents: [
          {
            id: "durable.md",
            body: [
              "The trace store is repos/metabob-activity-api.",
              "Status as of 2026-07-09: working.",
              "Run scripts/nonexistent/foo.sh to start.",
              "The `bogus_shape_xyz` shape is served by the resolver.",
              "Use metabob-mcp to dispatch.",
            ].join("\n"),
            durability: "durable",
          },
          { id: "dated.md", body: "Changelog (2026-07-01): metabob-activity-api fix", durability: "dated" },
        ],
      },
      live_truth: {
        advertised_shapes: ["docs_align_scan", "memoryNote"],
        existing_paths: ["scripts/substrate/up.sh"],
      },
      vocabulary: {
        deprecated: [{ pattern: "metabob-activity-api", canonical: "activity-api" }],
        retained: ["metabob-mcp"],
      },
    });
    expect(res.shape).toBe("docsAlignReport");
    const body = res.body as {
      implemented: boolean;
      scanned_count: number;
      findings: Array<{ doc_id: string; invariant: string; evidence: string }>;
      truncated: boolean;
    };
    expect(body.implemented).toBe(true);
    expect(body.scanned_count).toBe(1); // dated doc excluded
    const invariants = body.findings.map((f) => f.invariant).sort();
    expect(invariants).toEqual(["accuracy", "naming_alignment", "setup_enablement", "timelessness"]);
    // retained branding not flagged
    expect(body.findings.some((f) => f.evidence.includes("metabob-mcp"))).toBe(false);
    // dated doc produced no findings
    expect(body.findings.every((f) => f.doc_id === "durable.md")).toBe(true);
  });

  it("returns an empty-findings report for an empty corpus", async () => {
    const res = await resolveDocsAlignScan({ type: "docs_align_scan" });
    expect(res.shape).toBe("docsAlignReport");
    const body = res.body as Record<string, unknown>;
    expect(body["implemented"]).toBe(true);
    expect(body["findings"]).toEqual([]);
  });

  it("caps findings at max_findings and sets truncated", async () => {
    const res = await resolveDocsAlignScan({
      type: "docs_align_scan",
      max_findings: 1,
      corpus: {
        documents: [
          {
            id: "d.md",
            body: "as of 2026-01-01 x\nas of 2026-01-02 y\n",
            durability: "durable",
          },
        ],
      },
      invariants: ["timelessness"],
    });
    const body = res.body as { findings: unknown[]; truncated: boolean };
    expect(body.findings.length).toBe(1);
    expect(body.truncated).toBe(true);
  });
});

describe("docs_align_scan v1 precision (constitutional-doc hardening)", () => {
  it("naming_alignment path_only: flags the deprecated token in a path but not as a bare package name", async () => {
    const res = await resolveDocsAlignScan({
      type: "docs_align_scan",
      invariants: ["naming_alignment"],
      corpus: {
        documents: [
          {
            id: "d.md",
            body: [
              "The package name is metabob-activity-api and that is correct.",
              "See repos/metabob-activity-api/src/config.ts for the wiring.",
            ].join("\n"),
            durability: "durable",
          },
        ],
      },
      vocabulary: {
        deprecated: [{ pattern: "metabob-activity-api", canonical: "activity-api", path_only: true }],
        retained: [],
      },
    });
    const findings = (res.body as { findings: Array<{ invariant: string; evidence: string }> }).findings;
    expect(findings.length).toBe(1);
    expect(findings[0]!.evidence).toContain("repos/metabob-activity-api/src/config.ts");
  });

  it("accuracy: flags an unadvertised shape only in DECLARATION context, not by mere proximity to 'shape'", async () => {
    // POLICY REVERSAL, deliberate — this case previously asserted that any backticked
    // token adjacent to the word "shape" was flagged. That was narrowed on purpose
    // (docs-align-scan.ts:249-262): proximity is not evidence, and the loose rule produced
    // false positives on field names (`columns`, `success`, `activity_variant_id`),
    // function names (`verifyGoalReached`) and deliberately FICTIONAL example shapes
    // (`cargoManifest` in "Example pass: Introduce `cargoManifest` shape"). As the
    // resolver puts it: a validator that fails on correct docs trains its readers to
    // ignore it. Re-asserting the old rule would restore exactly those false positives.
    //
    // The detector now requires a BACKTICKED token in a declaration — shape: `x` / type: `x`
    // (token extraction is backtick-only, docs-align-scan.ts:242) — so the test
    // asserts BOTH directions, which is what makes it a discriminator rather than a
    // one-sided pass: prose proximity must NOT flag, a real declaration MUST.
    const res = await resolveDocsAlignScan({
      type: "docs_align_scan",
      invariants: ["accuracy"],
      corpus: {
        documents: [
          {
            id: "d.md",
            body: [
              "The resolver reads `failure_mode` and `parent_execution_id` from the trace.",
              "The `bogus_shape_xyz` shape is served by no vessel.",
              "shape: `undeclared_shape_abc` is wired here.",
            ].join("\n"),
            durability: "durable",
          },
        ],
      },
      live_truth: { advertised_shapes: ["memoryNote"] },
    });
    const findings = (res.body as { findings: Array<{ invariant: string; evidence: string }> }).findings;
    // field/function names near "resolver" are never flagged
    expect(findings.every((f) => !f.evidence.includes("failure_mode"))).toBe(true);
    // prose proximity alone is NOT a finding — this is the narrowing being asserted
    expect(findings.some((f) => f.evidence.includes("bogus_shape_xyz"))).toBe(false);
    // ...but a declaration of an unadvertised shape IS, so the detector still discriminates
    expect(findings.some((f) => f.evidence.includes("undeclared_shape_abc"))).toBe(true);
  });

  it("timelessness: exempts explicit deprecation markers but flags embedded dated status", async () => {
    const res = await resolveDocsAlignScan({
      type: "docs_align_scan",
      invariants: ["timelessness"],
      corpus: {
        documents: [
          {
            id: "d.md",
            body: [
              "> **DEPRECATED (2026-07-04): canary Kubernetes.** Retained reference-only.",
              "As of 2026-06-24 this unit has been observed crash-looping.",
            ].join("\n"),
            durability: "durable",
          },
        ],
      },
    });
    const findings = (res.body as { findings: Array<{ invariant: string; evidence: string }> }).findings;
    expect(findings.some((f) => f.evidence.includes("DEPRECATED (2026-07-04)"))).toBe(false);
    expect(findings.some((f) => f.evidence.includes("As of 2026-06-24"))).toBe(true);
  });
});

describe("docs_align_scan v1 contract (remaining parked behaviors)", () => {
  it.todo(
    "each finding carries byte-anchored evidence (verbatim offending text) sufficient to seed a gap→repair pair without re-reading the corpus — evidence should include line offsets",
  );
  it.todo(
    "joins endpoint and systemd-unit claims against live_truth.vessel_endpoints / unit_names and flags mismatches (only advertised_shapes and existing_paths join today)",
  );
  it.todo(
    "instance-name detection reads the instance-name set from the vocabulary note rather than the literal 'substrate-live'",
  );
});

// Original parked contract (superseded design, intent preserved above and in
// the downstream findings-to-gaps activity):
describe("original fs-based contract — superseded, intent recast", () => {
  it.todo(
    "SUPERSEDED (was: detects drift when README has seed-live but not make -C scripts/substrate up) → now a setup_enablement/accuracy finding over a corpus document containing 'seed-live'",
  );
  it.todo(
    "SUPERSEDED (was: resolver writes substrateGap with dry_run gating) → gap emission and dry_run gating live in the downstream docs-align-findings-to-gaps activity, keeping detection pure",
  );
});
