/**
 * gate_self_probe — make the substrate test its OWN gates.
 *
 * WHY THIS EXISTS. On 2026-09-05 the .surql effect gate was wrong four times in a row, and
 * every single defect was found by an operator hand-writing a hostile input:
 *
 *   v1  missed a foreign SQL dialect entirely (drafter wrote ANSI `ALTER TABLE ... ADD COLUMN`)
 *   v2  missed MySQL's OPTIONAL `COLUMN` keyword, so the short form slipped through
 *   v3  fired on the wrong clause — refused a file for its trailing `END`, while the ANSI
 *       statement it was built to catch sat unexamined inside a DEFINE EVENT body
 *   v4  correct
 *
 * None of those were caught by the unit tests, which were green throughout: a test asserts
 * what its author already thought of. They were caught by running a deliberately hostile
 * artifact through the real pipeline. That made gate quality a function of operator attention,
 * which is exactly the dependency the S1->S3 trajectory is supposed to remove.
 *
 * So: for every deterministic refusal rule, keep an artifact it MUST refuse and an artifact it
 * MUST NOT, run both through the REAL exported function, and report per rule. A regression in
 * either direction mints a gap.
 *
 * BOTH DIRECTIONS ARE LOAD-BEARING. A gate that refuses everything is as broken as one that
 * refuses nothing — worse, in fact, because this repo has already shipped a fail-closed gate
 * that "WEDGED autonomous landings within the hour" and stalled pull-sync for 30 minutes. The
 * abstain case is what catches that, and it is the case a smoke test omits.
 *
 * WE CALL THE EXPORTED FUNCTIONS, NEVER A REIMPLEMENTATION. A probe that re-derives the rule
 * tests the probe, not the gate.
 */

import type { ResolverResult } from "./types.js";
import { resolveSubstrateGapWrite } from "./substrate-gap.js";
import {
  inertRegexEditRefusal,
  cjsInEsmRefusal,
  unresolvableImpulseEndpointRefusal,
} from "./feature-compose.js";
import { surqlBreakingFieldRefusal } from "./vessel-mitosis-evaluate.js";

export interface GateProbeCase {
  /** Rule under test, named as it appears in the refusal chain. */
  rule: string;
  /** What the hostile artifact is, in one line, for the report. */
  hostile_desc: string;
  /** What the benign artifact is. */
  benign_desc: string;
  /** Substring the refusal must cite, so a right-verdict-wrong-reason still fails. */
  expect_cites: string;
  probeHostile: () => string | null;
  probeBenign: () => string | null;
}

export interface GateProbeOutcome {
  rule: string;
  refused_hostile: boolean;
  cited_expected: boolean;
  refused_benign: boolean;
  ok: boolean;
  detail: string;
}

const diff = (path: string, added: string[]): string =>
  [`--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,2 @@", ...added.map((l) => `+${l}`)].join("\n");

/**
 * The probe corpus. Each hostile case is a REAL artifact that reached a real gate, not an
 * invention — a case the pipeline actually produced is the only kind proven to be reachable.
 */
export function gateProbeCases(): GateProbeCase[] {
  return [
    {
      rule: "surqlBreakingFieldRefusal/ansi-dialect",
      hostile_desc: "ANSI `ALTER TABLE ... ADD COLUMN` — the live drafter output that reached origin/dev on 2026-09-05",
      benign_desc: "`ALTER TABLE ... PERMISSIONS`, which SurrealDB 3.0.0 really uses (migration 121)",
      expect_cites: "ANSI/MySQL",
      probeHostile: () =>
        surqlBreakingFieldRefusal([
          { path: "sql/migrations/probe.surql", sql: "ALTER TABLE t ADD COLUMN c STRING NOT NULL;" },
        ]),
      probeBenign: () =>
        surqlBreakingFieldRefusal([
          {
            path: "sql/migrations/probe.surql",
            sql: "ALTER TABLE t PERMISSIONS FOR select WHERE org_id = $auth.org_id;",
          },
        ]),
    },
    {
      rule: "surqlBreakingFieldRefusal/non-optional-field",
      hostile_desc: "`DEFINE FIELD x ON t TYPE string` — valid SQL that broke every write to `activity`",
      benign_desc: "the same field declared `option<string>`",
      expect_cites: "NON-OPTIONAL",
      probeHostile: () =>
        surqlBreakingFieldRefusal([
          { path: "sql/migrations/probe.surql", sql: "DEFINE FIELD probe_col ON activity TYPE string;" },
        ]),
      probeBenign: () =>
        surqlBreakingFieldRefusal([
          { path: "sql/migrations/probe.surql", sql: "DEFINE FIELD probe_col ON activity TYPE option<string>;" },
        ]),
    },
    {
      rule: "cjsInEsmRefusal",
      hostile_desc: "`module.exports` added to an ESM vessel — typechecks, inert at runtime",
      benign_desc: "an ordinary ESM `export function`",
      expect_cites: "",
      probeHostile: () => cjsInEsmRefusal(diff("src/x.ts", ["module.exports = { a: 1 };"])),
      probeBenign: () => cjsInEsmRefusal(diff("src/x.ts", ["export function a() { return 1; }"])),
    },
    {
      rule: "unresolvableImpulseEndpointRefusal",
      hostile_desc: "a call to /v2/impulses/<verb> that no vessel serves",
      benign_desc: "the real /v2/impulses/resolve endpoint",
      expect_cites: "",
      probeHostile: () =>
        unresolvableImpulseEndpointRefusal(diff("src/x.ts", ['await fetch("/v2/impulses/definitely_not_a_verb");'])),
      probeBenign: () =>
        unresolvableImpulseEndpointRefusal(diff("src/x.ts", ['await fetch("/v2/impulses/resolve");'])),
    },
    {
      rule: "inertRegexEditRefusal",
      hostile_desc: "a regex alternative that is already matched — bytes change, behaviour does not",
      benign_desc: "a regex widening that genuinely changes what matches",
      expect_cites: "",
      probeHostile: () =>
        inertRegexEditRefusal(
          [
            "--- a/src/x.ts",
            "+++ b/src/x.ts",
            "@@ -1,1 +1,1 @@",
            "-const RE = /alpha|beta/;",
            "+const RE = /alpha|beta|alpha/;",
          ].join("\n"),
        ),
      probeBenign: () =>
        inertRegexEditRefusal(
          [
            "--- a/src/x.ts",
            "+++ b/src/x.ts",
            "@@ -1,1 +1,1 @@",
            "-const RE = /alpha/;",
            "+const RE = /alpha|gamma/;",
          ].join("\n"),
        ),
    },
  ];
}

/** Run the corpus. Pure over the cases, so tests can inject their own. */
export function runGateProbes(cases: GateProbeCase[]): GateProbeOutcome[] {
  return cases.map((c) => {
    let hostile: string | null = null;
    let benign: string | null = null;
    let threw = "";
    try {
      hostile = c.probeHostile();
    } catch (e) {
      threw += `hostile threw: ${(e as Error).message}; `;
    }
    try {
      benign = c.probeBenign();
    } catch (e) {
      threw += `benign threw: ${(e as Error).message}; `;
    }
    const refused_hostile = hostile !== null;
    const refused_benign = benign !== null;
    // An empty expect_cites means "any refusal counts"; a non-empty one means the gate must
    // refuse for the STATED reason. v3 of the surql gate refused the right file citing the
    // wrong clause, and a check that only asked "did something refuse?" would have passed it.
    const cited_expected =
      refused_hostile && (c.expect_cites === "" || (hostile ?? "").includes(c.expect_cites));
    const ok = refused_hostile && cited_expected && !refused_benign && threw === "";
    const detail = threw
      ? threw.trim()
      : !refused_hostile
        ? `MISS: hostile artifact was NOT refused (${c.hostile_desc})`
        : !cited_expected
          ? `WRONG REASON: refused, but did not cite "${c.expect_cites}" — got: ${(hostile ?? "").slice(0, 140)}`
          : refused_benign
            ? `FALSE POSITIVE: benign artifact refused (${c.benign_desc}) — got: ${(benign ?? "").slice(0, 140)}`
            : "ok";
    return { rule: c.rule, refused_hostile, cited_expected, refused_benign, ok, detail };
  });
}

export async function resolveGateSelfProbe(
  pointer: Record<string, unknown>,
): Promise<ResolverResult> {
  const outcomes = runGateProbes(gateProbeCases());
  const failures = outcomes.filter((o) => !o.ok);
  const emit = pointer["emit_gap"] !== false;

  let gapEmitted: string | null = null;
  if (emit && failures.length > 0) {
    const id = "a-deterministic-refusal-gate-no-longer-refuses-what-it-was-built-to-refuse";
    try {
      await resolveSubstrateGapWrite({
        type: "substrateGap_write",
        gap: {
          id,
          category: "systematic_failure",
          source: "substrate_detected",
          status: "open",
          summary:
            `gate self-probe: ${failures.length} of ${outcomes.length} deterministic refusal rule(s) ` +
            `no longer behave as built. Each rule is exercised with an artifact it MUST refuse and ` +
            `one it MUST NOT, using the exported function itself. ` +
            failures.map((f) => `[${f.rule}] ${f.detail}`).join(" | "),
          classification_metadata: {
            detector: "gate_self_probe",
            failing_rules: failures.map((f) => f.rule),
            rules_total: outcomes.length,
            rules_failing: failures.length,
            probed_at: new Date().toISOString(),
          },
        },
      } as never);
      gapEmitted = id;
    } catch {
      /* non-fatal: losing the reading is not a reason to lose the measurement */
    }
  }

  return {
    shape: "gateSelfProbe",
    body: {
      outcomes,
      rules_total: outcomes.length,
      rules_failing: failures.length,
      all_pass: failures.length === 0,
      gap_emitted: gapEmitted,
      probed_at: new Date().toISOString(),
    },
  };
}
