import type { ResolverResult } from "./types.js";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * self_alteration_funnel_scan — deterministic detector for the EMERGENT health of
 * the self-alteration pipeline as a whole, not any single step.
 *
 * The substrate already has per-step failure detection (detect-unclassified_failure_*
 * fires for draft / apply / mitosis / cutover individually). What it lacked — and
 * what an operator had to notice by hand — is the FUNNEL: across the whole
 * draft → apply → stage → cutover pipeline, what fraction of authored proposals
 * actually become landed cutovers? A per-step detector sees its own tree; this sees
 * the forest. It rolls up the Observational state (proposals on disk, staged mitosis
 * dirs, mitosis-applied.jsonl) into stage counts and emits a substrateGap when
 * end-to-end conversion collapses, CITING the stuck stage + the likely cause so the
 * gap is actionable.
 *
 * Same shape as cost_expectation_scan: one server-side deterministic resolver, no
 * LLM, reads signals the loop already writes, conditional emit-per-finding.
 *
 * Findings:
 *  1. self_alteration_throughput_zero — >= minProposals authored in the window but
 *     0 cutovers landed. Localizes the stuck stage: staged==0 ⇒ stuck at APPLY
 *     (proposals not converting to staged — stale backlog / non-actionable proposals);
 *     staged>0 ⇒ stuck at EVALUATE/CUTOVER.
 *  2. stale_proposal_backlog — a large un-applied proposal backlog dominated by
 *     stale/non-actionable reports (freshness_violation / precondition-rejection /
 *     arch-pattern analytics), which FIFO apply churns through fruitlessly.
 */

export interface SelfAlterationFunnelScanPointer {
  type: "self_alteration_funnel_scan";
  proposalsDir?: string;       // default /workspace/proposals
  vesselsRoot?: string;        // default /vessels
  appliedLog?: string;         // default /workspace/mitosis-applied.jsonl
  windowHours?: number;        // default 6
  minProposals?: number;       // min authored-in-window to call a stall. default 5
  backlogThreshold?: number;   // backlog size to flag stale-backlog. default 100
  staleFracThreshold?: number; // fraction stale to flag. default 0.5
  devVesselImpulsesUrl?: string;
  dry_run?: boolean;
  maxEmits?: number;
}

const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";
const DEFAULT_MAX_EMITS = 4;
const STALE_RE = /freshness_violation|precondition-rejection|arch-pattern-catalogue-bloat/i;

interface Finding {
  gap_id: string;
  subtype: string;
  summary: string;
  metadata: Record<string, unknown>;
  posted?: boolean;
  post_status?: number | "error";
}

function listFiles(dir: string): Array<{ name: string; mtimeMs: number }> {
  try {
    return readdirSync(dir)
      .filter((n) => !n.startsWith("."))
      .map((n) => {
        try { return { name: n, mtimeMs: statSync(join(dir, n)).mtimeMs }; } catch { return null; }
      })
      .filter((x): x is { name: string; mtimeMs: number } => x !== null);
  } catch { return []; }
}

export async function resolveSelfAlterationFunnelScan(
  pointer: SelfAlterationFunnelScanPointer,
): Promise<ResolverResult> {
  const proposalsDir = pointer.proposalsDir ?? "/workspace/proposals";
  const vesselsRoot = pointer.vesselsRoot ?? "/vessels";
  const appliedLog = pointer.appliedLog ?? "/workspace/mitosis-applied.jsonl";
  const windowHours = pointer.windowHours ?? 6;
  const minProposals = pointer.minProposals ?? 5;
  const backlogThreshold = pointer.backlogThreshold ?? 100;
  const staleFracThreshold = pointer.staleFracThreshold ?? 0.5;
  const maxEmits = pointer.maxEmits ?? DEFAULT_MAX_EMITS;
  const dryRun = pointer.dry_run === true;
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const windowStart = Date.now() - windowHours * 3_600_000;

  // STAGE 1 — proposals authored in window (drafter output: proposal-*.json or *-report.json).
  const allProps = listFiles(proposalsDir).filter(
    (f) => (f.name.endsWith("-report.json") || (f.name.startsWith("proposal-") && f.name.endsWith(".json"))),
  );
  const authored = allProps.filter((f) => f.mtimeMs >= windowStart).length;

  // Un-applied backlog (those not yet marked in .applied/) + stale fraction.
  const applied = new Set(listFiles(join(proposalsDir, ".applied")).map((f) => f.name));
  const backlog = allProps.filter((f) => !applied.has(f.name));
  const staleBacklog = backlog.filter((f) => STALE_RE.test(f.name)).length;
  const staleFrac = backlog.length > 0 ? staleBacklog / backlog.length : 0;

  // STAGE 2 — staged mitosis dirs created in window.
  const staged = listFiles(vesselsRoot).filter((f) => /-mitosis-/.test(f.name) && f.mtimeMs >= windowStart).length;

  // STAGE 3 — cutovers landed in window (mitosis-applied.jsonl), with push breakdown.
  let landed = 0; let pushed = 0;
  try {
    for (const line of readFileSync(appliedLog, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line) as { body?: { applied_at?: string; push_status?: string } };
        const at = d.body?.applied_at ? Date.parse(d.body.applied_at) : NaN;
        if (Number.isFinite(at) && at >= windowStart) { landed++; if (d.body?.push_status === "pushed") pushed++; }
      } catch { /* skip */ }
    }
  } catch { /* no applied log yet */ }

  const findings: Finding[] = [];

  // FINDING 1 — a pipeline stage converts ~nothing. Key on STAGED, not landed:
  // landed can be inflated by operator/manual cutovers, but staged===0 despite
  // authored proposals unambiguously means the AUTONOMOUS apply stage produced
  // nothing. staged>0 yet landed===0 isolates the evaluate→cutover gate instead.
  const applyStalled = authored >= minProposals && staged === 0;
  const cutoverStalled = staged > 0 && landed === 0;
  if (applyStalled || cutoverStalled) {
    const stuckAtApply = applyStalled;
    const stage = stuckAtApply ? "apply" : "evaluate_or_cutover";
    findings.push({
      gap_id: `self-alteration-throughput-zero-${stage}`,
      subtype: "self_alteration_throughput_zero",
      summary:
        `Self-alteration pipeline landed 0 cutovers in the last ${windowHours}h despite ${authored} ` +
        `proposal(s) authored (staged=${staged}, landed=${landed}). Stuck at ${stage.toUpperCase()}: ` +
        (stuckAtApply
          ? `proposals are NOT converting to staged mitoses — apply-proposal-as-patch is either fed ` +
            `non-actionable proposals (stale backlog: ${staleBacklog}/${backlog.length} stale) or ` +
            `patch_with_tools cannot construct an edit. The loop is detecting work but not landing it.`
          : `${staged} mitosis(es) staged but none cut over — the evaluate→cutover gate (FAVORABLE / ` +
            `freshness / push) is rejecting them.`),
      metadata: {
        gap_subtype: "self_alteration_throughput_zero",
        window_hours: windowHours,
        funnel: { authored, staged, landed, pushed },
        backlog_size: backlog.length,
        stale_backlog: staleBacklog,
        stale_fraction: Number(staleFrac.toFixed(2)),
        stuck_stage: stage,
        cited_evidence: stuckAtApply
          ? ["repos/development-vessel/src/resolvers/apply-proposal-as-patch.ts"]
          : ["repos/development-vessel/src/resolvers/vessel-mitosis-cutover.ts"],
        remediation_hint: stuckAtApply
          ? "Make apply-proposal-as-patch PREFER fresh proposals carrying required_code_modifications/new_files " +
            "and skip the stale/analytic backlog (freshness_violation / precondition-rejection / arch-pattern " +
            "reports), so patch_with_tools converges on a real code fix instead of churning dead proposals."
          : "Inspect the evaluate→cutover gate: check vessel-mitosis-evaluate verdicts and the freshness gate " +
            "for the staged mitoses that aren't landing.",
      },
    });
  }

  // FINDING 2 — stale-backlog poisoning (independent of throughput).
  if (backlog.length >= backlogThreshold && (staleFrac >= staleFracThreshold || staleBacklog >= 200)) {
    findings.push({
      gap_id: "self-alteration-stale-proposal-backlog",
      subtype: "stale_proposal_backlog",
      summary:
        `Proposal backlog is ${backlog.length} with ${(staleFrac * 100).toFixed(0)}% stale ` +
        `(${staleBacklog} freshness/precondition/analytic reports). FIFO apply churns these dead ` +
        `proposals before reaching fresh actionable ones, wasting its rare selection slots.`,
      metadata: {
        gap_subtype: "stale_proposal_backlog",
        backlog_size: backlog.length,
        stale_backlog: staleBacklog,
        stale_fraction: Number(staleFrac.toFixed(2)),
        cited_evidence: ["repos/development-vessel/src/resolvers/apply-proposal-as-patch.ts"],
        remediation_hint:
          "Sweep stale proposals (freshness_violation / precondition-rejection / arch-pattern-bloat older " +
          "than N days) into .applied or .rejected, and/or have apply skip them, so the actionable backlog is small.",
      },
    });
  }

  // Emit one substrateGap per finding (unless dry_run).
  const apiKey = process.env["METABOB_API_KEY"];
  const authHeader: Record<string, string> = apiKey ? { Authorization: `ApiKey ${apiKey}` } : {};
  if (!dryRun) {
    for (const f of findings.slice(0, maxEmits)) {
      const body = {
        impulse: {
          pointer: {
            type: "substrateGap_write",
            gap: {
              id: f.gap_id,
              category: "architectural_pattern",
              source: "substrate_detected",
              summary: f.summary,
              detected_at: new Date().toISOString(),
              status: "open",
              classification_metadata: f.metadata,
            },
          },
        },
      };
      try {
        const resp = await fetch(emitUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        f.post_status = resp.status;
        f.posted = resp.ok;
      } catch {
        f.post_status = "error";
      }
    }
  }

  return {
    shape: "selfAlterationFunnelReport",
    body: {
      window_hours: windowHours,
      funnel: { authored, staged, landed, pushed },
      // Honesty: `landed` is read from mitosis-applied.jsonl and may include
      // operator/manual cutovers — it is NOT purely autonomous throughput.
      landed_caveat: "landed may include operator/manual cutovers; not purely autonomous",
      conversion: {
        authored_to_staged: authored > 0 ? Number((staged / authored).toFixed(3)) : null,
        staged_to_landed: staged > 0 ? Number((landed / staged).toFixed(3)) : null,
        authored_to_landed: authored > 0 ? Number((landed / authored).toFixed(3)) : null,
      },
      backlog_size: backlog.length,
      stale_backlog: staleBacklog,
      stale_fraction: Number(staleFrac.toFixed(2)),
      finding_count: findings.length,
      findings,
      dry_run: dryRun,
      completed_at: new Date().toISOString(),
    },
  };
}
