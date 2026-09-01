import { describe, it, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";

// FALSIFIER ACCOUNTING ON THE GAP WRITE PATH (2026-09-01).
//
// THE MEASUREMENT these tests exist to protect. 487 open gaps in the live store;
// 5 (1.0%) carried any measurable closure predicate. `sweepPendingLandVerifications`
// closes a gap only on a MEASURED verdict, so a gap with no predicate yields
// 'pending' and the sweep correctly abstains — FOREVER; the 30-day TTL becomes its
// only exit. 34 consecutive sweep ticks that day were byte-identical:
//   checked=18 closed=0 {absent:0, present:6, pending:11, unknown:1}
//
// WHY THE WRITE PATH. Category is not the writer — `systematic_failure` alone holds
// 108 open gaps written by at least four distinct call sites — so a per-detector fix
// reaches a trickle while every gap from every writer passes through
// `resolveSubstrateGapWrite` exactly once.
//
// The mechanism is ACCOUNTING, not invention. Deriving a predicate from the summary
// was tried (be26a6b) and REVERTED as net-negative: of 15 summary-derived literals
// only ~4 named the actual defect; the rest quoted the FIX (inverted polarity) or
// named anchors the summary said were RETAINED, and since the cutover mirrors the fix
// BEFORE the stamp, a derived literal read 'present' by construction and manufactured
// re-lands. Nothing below asserts that a predicate was invented; every assertion is
// about a predicate the writer supplied.

// IMPORTANT: set WORKSPACE_ROOT BEFORE importing the resolver — config.ts snapshots
// the env var at module-load. Top-level statements run before any describe/beforeAll,
// so setting here is the only way to inject a test workspace.
const testWorkspace = join(tmpdir(), `dev-vessel-gap-falsifier-test-${Date.now()}`);
try {
  rmSync(testWorkspace, { recursive: true, force: true });
} catch {
  /* ignore */
}
process.env["WORKSPACE_ROOT"] = testWorkspace;
// Without this, every open-gap write below shells out to the REAL `systemctl start
// gap-compose.service` against whatever systemd this test process can reach — measured
// 2026-08-30, and it is a plausible contributor to chronic box saturation. Must be set
// before import, same as WORKSPACE_ROOT above.
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";

const { resolveSubstrateGap, resolveSubstrateGapWrite, classifyFalsifier, falsifierCoverage } =
  await import("../../src/resolvers/substrate-gap.js");

// A vocabulary plausible enough for the classifier to agree to judge with at all
// (configs_read >= 5 AND >= 50 names — the shared `vocabularyIsJudgeable` threshold).
// It is INJECTED rather than loaded: the real loader scans /vessels and
// /workspace/git/super-repo, which do not exist on a host-side test run, so relying on
// it would make every verdict here a function of the machine's mount layout.
// `trace_failure_pattern_report` is in it and `failurePatternReport` deliberately is
// NOT — that is the exact real pair (05458f4, 6b6068e).
const vocab = (extra: string[] = []): { shapes: Set<string>; configs_read: number } => ({
  shapes: new Set([
    "trace_failure_pattern_report",
    "substrateGap",
    "activity_template",
    "concept",
    ...extra,
    ...Array.from({ length: 60 }, (_, i) => `filler_shape_${i}`),
  ]),
  configs_read: 9,
});

// Captures console.log for the duration of fn. The mechanism MUST speak on the
// CONFIRMING case too — this codebase has repeatedly shipped mechanisms whose success
// path emitted nothing, and a classifier that only logs when it objects is
// indistinguishable from one that never ran.
const withCapturedLog = async <T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> => {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]): void => { logs.push(args.map(String).join(" ")); };
  try {
    return { result: await fn(), logs };
  } finally {
    console.log = original;
  }
};

const gapWith = (id: string, meta?: Record<string, unknown>): Record<string, unknown> => ({
  type: "substrateGap_write",
  gap: {
    id,
    category: "systematic_failure",
    source: "substrate_detected",
    status: "open",
    summary: `measured defect for ${id} — the resolver returns a stale row after a reopen`,
    detected_at: "2026-09-01T00:00:00Z",
    ...(meta ? { classification_metadata: meta } : {}),
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// The four classifications, from realistic gap objects.
// ─────────────────────────────────────────────────────────────────────────────
describe("classifyFalsifier — the four verdicts", () => {
  it('a usable hardcoded_url is "class1" — a literal the oracle watches go ABSENT', () => {
    const c = classifyFalsifier(
      { edit_site: "src/resolvers/reach-history.ts", hardcoded_url: "http://127.0.0.1:8080/impulses" },
      vocab(),
    );
    expect(c.falsifier).toBe("class1");
    expect(c.predicate_position).toBe("hardcoded_url");
  });

  it('an ADVERTISED evidence_resolve shape is "class2" — a re-measurement the sweep can run', () => {
    const c = classifyFalsifier(
      {
        evidence_resolve: {
          shape: "trace_failure_pattern_report",
          input: { template_id: "gap-to-feature" },
          nonzero_field: "occurrence_count",
        },
      },
      vocab(),
    );
    expect(c.falsifier).toBe("class2");
    expect(c.predicate_position).toBe("evidence_resolve.shape");
    expect(c.unadvertised_shape).toBeUndefined();
  });

  it('the verify_shape string shorthand is classified too (gap-to-feature.ts ~1604 documents both forms)', () => {
    expect(classifyFalsifier({ verify_shape: "substrateGap" }, vocab()).falsifier).toBe("class2");
    expect(classifyFalsifier({ verify_shape: "substrateGap" }, vocab()).predicate_position).toBe("verify_shape");
  });

  it('an UNADVERTISED shape is "unresolvable" — inert, but LOOKING measurable', () => {
    const c = classifyFalsifier({ evidence_resolve: { shape: "failurePatternReport" } }, vocab());
    expect(c.falsifier).toBe("unresolvable");
    // The NAME is what an escalation needs; the drafter guessed twice for want of it.
    expect(c.unadvertised_shape).toBe("failurePatternReport");
  });

  it('no predicate at all is "none" — the 99% case, and not an error', () => {
    expect(classifyFalsifier({ kind: "capability_gap" }, vocab()).falsifier).toBe("none");
    expect(classifyFalsifier({}, vocab()).falsifier).toBe("none");
    expect(classifyFalsifier(undefined, vocab()).falsifier).toBe("none");
  });

  it("hardcoded_url WINS over a Class-2 predicate, because that is the SWEEP's precedence", () => {
    // verifyGapCondition tests the literal first and never reaches the async evidence
    // branch when one is present. The stamp must describe what the sweep will actually
    // DO, not merely what the metadata contains — otherwise the census counts a class
    // of work that never happens.
    const c = classifyFalsifier(
      {
        hardcoded_url: "const PORT = 8080",
        // Class-1 only counts WITH an edit site — verifyGapCondition reads
        // `if (editSite && hardcodedUrl)`. Supplying one here keeps this test about
        // PRECEDENCE rather than accidentally re-testing the edit-site rule below.
        edit_site: "repos/development-vessel/src/config.ts",
        evidence_resolve: { shape: "failurePatternReport" },
      },
      vocab(),
    );
    expect(c.falsifier).toBe("class1");
  });

  it('a hardcoded_url with NO edit_site is "unresolvable" — the sweep can never read it', () => {
    // gap-to-feature.ts:1563 and its async twin at :1650 both gate the whole Class-1
    // branch on `if (editSite && hardcodedUrl)`. A literal with no file to read it in is
    // never measured, so stamping it class1 would reproduce the "looks measurable, is
    // inert" defect INSIDE the accounting built to expose it. Zero live instances today;
    // a census that can lie is worse than no census, because the lie is what gets acted on.
    const c = classifyFalsifier({ hardcoded_url: "const PORT = 8080" }, vocab());
    expect(c.falsifier).toBe("unresolvable");
    expect(c.predicate_position).toBe("hardcoded_url");
    expect(c.unresolvable_reason).toContain("edit_site");
    // and it must NOT be confused with the unadvertised-shape case
    expect(c.unadvertised_shape).toBeUndefined();
  });

  it('a SAMPLE-BODY evidence_resolve is class2 — mirror the sweep, do not undercount it', () => {
    // verifyGapConditionAsync (gap-to-feature.ts:1699-1712) does not require `.shape`: with
    // a sample body it derives from verify_shape, else from the gap id. Classifying such a
    // gap "none" asserts "can never close" about one the sweep CAN measure. This is the live
    // shape of the data — the store's single open evidence_resolve predicate is sample-body
    // form, and the documented `.shape` form has zero live instances.
    const c = classifyFalsifier(
      { evidence_resolve: { type: "trace_failure_pattern_report", week: "2026-08-17" } },
      vocab(),
    );
    expect(c.falsifier).toBe("class2");
    expect(c.predicate_position).toBe("evidence_resolve.type");
  });

  it('an evidence_resolve with NO usable shape is "none", not "unresolvable"', () => {
    // "unresolvable" means a NAME was supplied and does not resolve. No name at all is
    // the same nothing as no predicate. Saying "unresolvable" here would blame the
    // writer for a name it never wrote — and would inflate the very count that is
    // supposed to drive escalation at unadvertised literals.
    expect(classifyFalsifier({ evidence_resolve: { input: { x: 1 } } }, vocab()).falsifier).toBe("none");
    expect(classifyFalsifier({ evidence_resolve: {} }, vocab()).falsifier).toBe("none");
    expect(classifyFalsifier({ verify_shape: "   " }, vocab()).falsifier).toBe("none");
  });

  it("an UNBOUND {{template slot}} measures nothing, so it is not a predicate", () => {
    // A gap once persisted `created_at: "{{goal.created_at}}"` verbatim (2026-08-05).
    // A slot in a predicate position would be counted as coverage while resolving to a
    // literal that can never match.
    expect(classifyFalsifier({ hardcoded_url: "{{defect.literal}}" }, vocab()).falsifier).toBe("none");
    expect(classifyFalsifier({ verify_shape: "{{gap.shape}}" }, vocab()).falsifier).toBe("none");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Constraint D — FAIL OPEN. An unreadable filesystem must never invent a defect.
// ─────────────────────────────────────────────────────────────────────────────
describe("classifyFalsifier — fail-open on an unusable vocabulary (constraint D)", () => {
  const cases: Array<[string, { shapes: Set<string>; configs_read: number } | null]> = [
    ["vocabulary could not be loaded at all", null],
    ["scan read too few configs (host-side layout / isolated worktree)", { shapes: new Set(Array.from({ length: 80 }, (_, i) => `s${i}`)), configs_read: 2 }],
    ["scan produced an implausibly small vocabulary", { shapes: new Set(["a", "b", "c"]), configs_read: 9 }],
  ];
  for (const [label, v] of cases) {
    it(`${label} → "class2", NOT "unresolvable"`, () => {
      // A scan that did not demonstrably work is not evidence that a shape is
      // unadvertised — it is evidence that the scan did not run. The missed catch
      // costs a stale gap; the invented defect costs a false accusation against a
      // correct predicate. Credit the predicate.
      const c = classifyFalsifier({ evidence_resolve: { shape: "utterly_not_a_real_shape" } }, v);
      expect(c.falsifier).toBe("class2");
      expect(c.unadvertised_shape).toBeUndefined();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end through the write path.
// ─────────────────────────────────────────────────────────────────────────────
describe("resolveSubstrateGapWrite — stamps the falsifier on every write", () => {
  it("THE ANTI-REGRESSION (constraint A): a gap with NO predicate is WRITTEN, and classified none", async () => {
    // THE MOST IMPORTANT TEST IN THIS FILE. 99% of gaps carry no predicate. If this
    // path ever rejects, detection stops fleet-wide — a far worse outcome than the
    // unclosable-gap problem this whole mechanism addresses. Classify and log; NEVER
    // refuse. Note the existing identity and description gates DO reject; this one
    // deliberately does not follow them.
    const { result, logs } = await withCapturedLog(() =>
      resolveSubstrateGapWrite(gapWith("falsifier-none-001"), { vocabulary: vocab() }),
    );
    expect(result.shape).toBe("substrateGapWriteResult");
    const body = result.body as { action: string; falsifier: string };
    expect(body.action).toBe("created");
    expect(body.falsifier).toBe("none");
    // The confirming case must emit evidence too.
    expect(logs.some((l) => l.includes("[gap-falsifier]") && l.includes("falsifier=none"))).toBe(true);

    const read = await resolveSubstrateGap({ type: "substrateGap", id: "falsifier-none-001" });
    const g = (read.body as { gaps: Array<Record<string, unknown>> }).gaps[0]!;
    expect((g["classification_metadata"] as Record<string, unknown>)["falsifier"]).toBe("none");
  });

  it("stamps class1 and class2 through the resolver, and persists the stamp", async () => {
    await resolveSubstrateGapWrite(
      gapWith("falsifier-c1-001", { edit_site: "src/x.ts", hardcoded_url: "http://127.0.0.1:8080/impulses" }),
      { vocabulary: vocab() },
    );
    await resolveSubstrateGapWrite(
      gapWith("falsifier-c2-001", { evidence_resolve: { shape: "trace_failure_pattern_report", nonzero_field: "occurrence_count" } }),
      { vocabulary: vocab() },
    );
    const read = await resolveSubstrateGap({ type: "substrateGap", limit: 100 });
    const byId = new Map(
      (read.body as { gaps: Array<Record<string, unknown>> }).gaps.map((g) => [g["id"], g]),
    );
    const meta = (id: string): Record<string, unknown> =>
      (byId.get(id)!["classification_metadata"] ?? {}) as Record<string, unknown>;
    expect(meta("falsifier-c1-001")["falsifier"]).toBe("class1");
    expect(meta("falsifier-c2-001")["falsifier"]).toBe("class2");
  });

  it("an unadvertised Class-2 shape is 'unresolvable' AND the writer's predicate survives UNTOUCHED (constraint C)", async () => {
    // The exact real case: the substrate authored `shape: "failurePatternReport"` and
    // landed it TWICE (05458f4, 6b6068e). The advertised name is
    // `trace_failure_pattern_report`.
    //
    // Silently rewriting the caller's data is how the field-name mismatches in this
    // store became invisible in the first place. The verdict is a LABEL on the data,
    // never a correction of it — so the original object must come back byte-identical.
    const supplied = {
      evidence_resolve: {
        shape: "failurePatternReport",
        input: { template_id: "gap-to-feature" },
        nonzero_field: "occurrence_count",
      },
      detector: "trace-recurring-pattern-scan",
    };
    const { result, logs } = await withCapturedLog(() =>
      resolveSubstrateGapWrite(gapWith("falsifier-unresolvable-001", structuredClone(supplied)), { vocabulary: vocab() }),
    );
    const body = result.body as { falsifier: string; falsifier_unadvertised_shape?: string };
    expect(body.falsifier).toBe("unresolvable");
    expect(body.falsifier_unadvertised_shape).toBe("failurePatternReport");
    // The log must NAME the bad literal — that name is what an escalation acts on.
    expect(logs.some((l) => l.includes("[gap-falsifier]") && l.includes("failurePatternReport"))).toBe(true);

    const read = await resolveSubstrateGap({ type: "substrateGap", id: "falsifier-unresolvable-001" });
    const meta = ((read.body as { gaps: Array<Record<string, unknown>> }).gaps[0]!["classification_metadata"] ??
      {}) as Record<string, unknown>;
    expect(meta["evidence_resolve"]).toEqual(supplied.evidence_resolve);
    expect(meta["detector"]).toBe("trace-recurring-pattern-scan");
    expect(meta["falsifier"]).toBe("unresolvable");
    expect(meta["falsifier_unadvertised_shape"]).toBe("failurePatternReport");
  });

  it("the advertised/unadvertised PAIR is discriminated — same field, one character class apart", async () => {
    await resolveSubstrateGapWrite(
      gapWith("falsifier-pair-good", { evidence_resolve: { shape: "trace_failure_pattern_report" } }),
      { vocabulary: vocab() },
    );
    const bad = await resolveSubstrateGapWrite(
      gapWith("falsifier-pair-bad", { evidence_resolve: { shape: "failurePatternReport" } }),
      { vocabulary: vocab() },
    );
    const good = await resolveSubstrateGap({ type: "substrateGap", id: "falsifier-pair-good" });
    const goodMeta = ((good.body as { gaps: Array<Record<string, unknown>> }).gaps[0]!["classification_metadata"] ??
      {}) as Record<string, unknown>;
    expect(goodMeta["falsifier"]).toBe("class2");
    expect((bad.body as { falsifier: string }).falsifier).toBe("unresolvable");
  });

  it("classifies the MERGED metadata, so a predicate-free RE-EMISSION does not downgrade a class2 row", async () => {
    // Detectors re-emit the same logical gap every cycle with fresh metadata carrying
    // no predicate; the write path's carry-forward loop preserves the existing
    // `evidence_resolve`. Classifying the INCOMING metadata instead of the merged
    // result would stamp "none" onto a row that still holds a usable predicate —
    // the stamp would lie about exactly the population it exists to count.
    await resolveSubstrateGapWrite(
      gapWith("falsifier-merge-001", { evidence_resolve: { shape: "trace_failure_pattern_report" } }),
      { vocabulary: vocab() },
    );
    const reemit = await resolveSubstrateGapWrite(
      gapWith("falsifier-merge-001", { detector: "some-scan", cycle: 2 }),
      { vocabulary: vocab() },
    );
    const body = reemit.body as { action: string; falsifier: string };
    expect(body.action).toBe("updated");
    expect(body.falsifier).toBe("class2");
  });

  it("a stale unresolvable accusation is CLEARED when a later write supplies an advertised shape", async () => {
    await resolveSubstrateGapWrite(
      gapWith("falsifier-heal-001", { evidence_resolve: { shape: "failurePatternReport" } }),
      { vocabulary: vocab() },
    );
    await resolveSubstrateGapWrite(
      gapWith("falsifier-heal-001", { evidence_resolve: { shape: "trace_failure_pattern_report" } }),
      { vocabulary: vocab() },
    );
    const read = await resolveSubstrateGap({ type: "substrateGap", id: "falsifier-heal-001" });
    const meta = ((read.body as { gaps: Array<Record<string, unknown>> }).gaps[0]!["classification_metadata"] ??
      {}) as Record<string, unknown>;
    expect(meta["falsifier"]).toBe("class2");
    // Carried forward blindly, this key would keep accusing a name that is no longer there.
    expect(meta["falsifier_unadvertised_shape"]).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The aggregate. The store is the authority; the operator should not be grepping it.
// ─────────────────────────────────────────────────────────────────────────────
describe("falsifier coverage census", () => {
  it("every read carries the store-wide open-gap census", async () => {
    const read = await resolveSubstrateGap({ type: "substrateGap", limit: 1 });
    const cov = (read.body as { falsifier_coverage: Record<string, number> }).falsifier_coverage;
    // Counted over the WHOLE open store, not the one-row page that was requested.
    expect(cov["class1"]).toBeGreaterThanOrEqual(1);
    expect(cov["class2"]).toBeGreaterThanOrEqual(1);
    expect(cov["unresolvable"]).toBeGreaterThanOrEqual(1);
    expect(cov["none"]).toBeGreaterThanOrEqual(1);
  });

  it('"unstamped" is NOT folded into "none" — pre-existing rows are a distinct fact', () => {
    // Conflating "we looked and found nothing" with "we never looked" is the exact
    // ambiguity this mechanism exists to remove: the 487-open-gap store predates the
    // stamp entirely, and reading those rows as `none` would assert a measurement that
    // was never taken.
    const cov = falsifierCoverage([
      { id: "a", status: "open", classification_metadata: { falsifier: "none" } },
      { id: "b", status: "open" },
      { id: "c", status: "open", classification_metadata: {} },
      // Closed rows are settled history — their closability is no longer a question.
      { id: "d", status: "closed" },
    ] as never);
    expect(cov["none"]).toBe(1);
    expect(cov["unstamped"]).toBe(2);
    expect(cov["class1"]).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The gates that DO reject must be unchanged — this change is additive only.
// ─────────────────────────────────────────────────────────────────────────────
describe("the existing rejection gates are untouched", () => {
  it("identity gate: a gap without an id is still rejected", async () => {
    const r = await resolveSubstrateGapWrite(
      { type: "substrateGap_write", gap: { category: "other", source: "substrate_detected", summary: "no id here" } } as never,
      { vocabulary: vocab() },
    );
    expect(r.shape).toBe("structuredError");
    const b = r.body as { failure_mode: string; field: string };
    expect(b.failure_mode).toBe("validation_rejected");
    expect(b.field).toBe("gap.id");
  });

  it("description gate: an OPEN gap with an empty summary is still rejected", async () => {
    const r = await resolveSubstrateGapWrite(
      { type: "substrateGap_write", gap: { id: "falsifier-gate-empty", category: "other", source: "substrate_detected", status: "open", summary: "   " } } as never,
      { vocabulary: vocab() },
    );
    expect(r.shape).toBe("structuredError");
    expect((r.body as { failure_mode: string }).failure_mode).toBe("validation_rejected");
  });

  it("description gate: an uninterpolated {{placeholder}} in the id is still rejected", async () => {
    const r = await resolveSubstrateGapWrite(
      { type: "substrateGap_write", gap: { id: "gap-{{goal.id}}", category: "other", source: "substrate_detected", status: "open", summary: "a real summary" } } as never,
      { vocabulary: vocab() },
    );
    expect(r.shape).toBe("structuredError");
    expect((r.body as { detail: string }).detail).toContain("placeholder");
  });

  it("a rejected gap is NEVER a falsifier verdict — nothing was persisted to classify", async () => {
    // The stamp lives past the early returns on purpose: a validation reject, the
    // consumption gate and the close-without-open-row skip all persist nothing, so
    // stamping there would announce a classification of a row that does not exist.
    const r = await resolveSubstrateGapWrite(
      { type: "substrateGap_write", gap: { category: "other", source: "substrate_detected", summary: "no id" } } as never,
      { vocabulary: vocab() },
    );
    expect((r.body as Record<string, unknown>)["falsifier"]).toBeUndefined();
  });
});
