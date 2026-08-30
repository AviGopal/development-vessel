/**
 * escalation_disposition_apply — the escalation-disposition executor.
 * Input shapes (closure linkage): solicitationOutcomeReport, substrateGap
 * Output shape: escalationDispositionReport
 *
 * THE CONSUMER `solicitationOutcomeReport` NEVER HAD. The category seal
 * (`gap-to-feature.ts` `hopeless()`) excludes a whole category at >=8 attempts / 0 lands,
 * and its ONLY designed escape is a human decision — see
 * `openspec/changes/2026-08-28-escalation-disposition-executor/proposal.md` for the
 * ledger citations. `143212a` (2026-08-06) traded the automatic re-test path FOR that
 * human answer ("permanently removes 106 currently-open gaps … that is the intended
 * effect"), predicating the exclusion on the row being "already escalated". But nothing
 * ever applied the answer, so the trade was one-directional and the seal became permanent.
 *
 * This resolver closes that link: it reads the answered escalations (reusing
 * solicitation_outcome_scan rather than re-deriving the read-back), parses the disposition
 * the human gave, and applies it to the gap. The four verbs are not invented here — they
 * are the ones the escalation body already asks for at `gap-to-feature.ts:831`:
 * "redefine the goal, provide missing information, grant access, or drop it."
 *
 * THE BOUNDED RE-TEST PATH IS THE LOAD-BEARING HALF. Because `143212a` traded the re-test
 * path away in exchange for the human answer, `redefine` / `provide_information` /
 * `grant_access` must give it back — that is exactly what they replaced. It is BOUNDED so
 * it cannot reopen the flood `143212a` deliberately closed: the answered gap becomes
 * selectable again for a limited number of attempts and its category stays sealed for
 * every other member. The seal is not lifted; one row gets a human-authorized exemption.
 *
 * Per SUBSTRATE_AS_MDP.md §12.6, this is the sound direction: validity is "measurement
 * against the un-authorable referent", and a human answer is un-authorable by the
 * substrate — the referent the section requires, not another self-authored certificate.
 *
 * DELIBERATELY NOT DONE HERE:
 *  - No write to `expectation-calibration.json`. That store is `predictLand`'s baseline for
 *    whether COMPOSE can land a gap like this (`gap-to-feature.ts:1945-1948`); a human
 *    disposition is not evidence of composer capability and would corrupt the self-model.
 *  - No call to `recordOperatorEngagement`. That tally calibrates the close-oracle's
 *    RE-LAND abstentions — a different evidence class.
 *  - No change to `hopeless()` thresholds. Only the per-gap exemption this resolver grants
 *    is read there.
 */

import type { ResolverResult } from "./types.js";
import { resolveSolicitationOutcomeScan } from "./solicitation-outcome-scan.js";
import { resolveSubstrateGap, resolveSubstrateGapWrite } from "./substrate-gap.js";

/** Attempts a human-answered gap is granted before the seal applies to it again. */
export const HUMAN_EXEMPTION_ATTEMPTS = 3;

export type DispositionVerb = "drop" | "redefine" | "provide_information" | "grant_access";

export interface EscalationDispositionApplyPointer {
  type: "escalation_disposition_apply";
  /** Do everything except write. For probing what WOULD be applied. */
  dry_run?: boolean;
  [key: string]: unknown;
}

/**
 * Parse the human's verb out of a free-text answer.
 *
 * Ordered longest/most-specific first so "provide missing information" is not shadowed by
 * a bare "information", and `drop` is checked last because the word appears incidentally
 * ("drop it", "dropped") far more often than the other three.
 *
 * Returns null when no verb is recognisable. THAT IS THE SAFE OUTCOME AND IT IS DELIBERATE:
 * an unparsed answer is reported as `unparsed` and the gap is left exactly as it was. A
 * guess here would mutate a gap on the strength of a keyword the human never intended,
 * which is worse than leaving the escalation outstanding — the human can always answer
 * again more explicitly.
 */
export function parseDisposition(answer: string): DispositionVerb | null {
  const t = String(answer ?? "").toLowerCase();
  if (!t.trim()) return null;
  if (/\bredefine\b|\bre-define\b|\brescope\b|\breword\b/.test(t)) return "redefine";
  if (/\bgrant[\s_-]+access\b|\baccess\s+granted\b|\bcredential/.test(t)) return "grant_access";
  if (/\bprovide[sd]?[\s_-]+(missing[\s_-]+)?info(rmation)?\b|\bmissing\s+info(rmation)?\b|\bhere'?s\s+the\s+fact\b|\bstore\s+the\s+answer\s+as\s+prose\b/.test(t)) {
    return "provide_information";
  }
  if (/\bdrop\b|\bwon'?t\s+fix\b|\bwontfix\b|\bnot\s+worth\s+closing\b|\babandon\b/.test(t)) return "drop";
  return null;
}

/** `needs-human-<gapId>` / `reland-needs-human-<gapId>` -> `<gapId>`. */
export function gapIdFromPanelId(panelId: string): string {
  const p = String(panelId ?? "");
  if (p.startsWith("reland-needs-human-")) return p.slice("reland-needs-human-".length);
  if (p.startsWith("needs-human-")) return p.slice("needs-human-".length);
  return "";
}

type FeedbackRecord = { id?: string; pointer?: { panel_id?: string; value?: unknown; kind?: string } };

/**
 * Latest non-dismiss answer per panel_id, read from the durable interactor log that
 * dev-vessel's interactor passthrough appends to. Later lines win, so a human who answers
 * again supersedes their earlier answer rather than being ignored.
 */
async function readAnswersByPanel(): Promise<Map<string, { value: string; recordId: string }>> {
  const out = new Map<string, { value: string; recordId: string }>();
  try {
    const root = process.env["WORKSPACE_ROOT"] ?? "/workspace";
    const logFile = Bun.file(root + "/interactor-log/uiFeedback_write.jsonl");
    if (!(await logFile.exists())) return out;
    for (const line of (await logFile.text()).split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as FeedbackRecord;
        const pid = rec.pointer?.panel_id;
        if (typeof pid !== "string" || !pid) continue;
        if (rec.pointer?.kind === "dismiss") continue;
        const v = rec.pointer?.value;
        out.set(pid, { value: typeof v === "string" ? v : JSON.stringify(v ?? ""), recordId: String(rec.id ?? "") });
      } catch { /* skip malformed line */ }
    }
  } catch { /* fail open -> empty map */ }
  return out;
}

export async function resolveEscalationDispositionApply(
  pointer: EscalationDispositionApplyPointer,
): Promise<ResolverResult> {
  const dryRun = pointer.dry_run === true;

  // Reuse the read-back rather than re-deriving it (law 3). This is also what gives
  // solicitationOutcomeReport its first consumer.
  const scan = await resolveSolicitationOutcomeScan({ type: "solicitation_outcome_scan" });
  const scanBody = (scan as { body?: Record<string, unknown> }).body ?? {};
  const outcomes = Array.isArray(scanBody.outcomes)
    ? (scanBody.outcomes as Array<{ solicitation_id?: string; outcome?: string }>)
    : [];
  const answeredIds = outcomes
    .filter((o) => o.outcome === "answered")
    .map((o) => String(o.solicitation_id ?? ""))
    .filter(Boolean);

  if (answeredIds.length === 0) {
    return {
      shape: "escalationDispositionReport",
      body: { authored: true, answered: 0, applied: 0, dispositions: [], note: "no answered escalations" },
    };
  }

  const answers = await readAnswersByPanel();
  const dispositions: Array<Record<string, unknown>> = [];
  let applied = 0;

  for (const panelId of answeredIds) {
    const gapId = gapIdFromPanelId(panelId);
    if (!gapId) { dispositions.push({ panel_id: panelId, outcome: "unrecognised_panel_id" }); continue; }

    const answer = answers.get(panelId);
    if (!answer) { dispositions.push({ panel_id: panelId, gap_id: gapId, outcome: "answer_text_absent" }); continue; }

    const verb = parseDisposition(answer.value);
    if (!verb) { dispositions.push({ panel_id: panelId, gap_id: gapId, outcome: "unparsed" }); continue; }

    const read = await resolveSubstrateGap({ type: "substrateGap", id: gapId } as never);
    const gaps = ((read as { body?: { gaps?: Array<Record<string, unknown>> } }).body?.gaps ?? []);
    const gap = gaps.find((g) => String(g.id) === gapId);
    if (!gap) { dispositions.push({ panel_id: panelId, gap_id: gapId, outcome: "gap_absent" }); continue; }

    const meta = { ...((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>) };

    // IDEMPOTENCE: key on the ANSWER RECORD id, not a timestamp and not the verb. The tick
    // re-runs on a cadence and the same answer stays in the log forever; without this the
    // exemption would be re-granted on every pass and the bound would never bind.
    if (meta.human_disposition_record_id === answer.recordId) {
      dispositions.push({ panel_id: panelId, gap_id: gapId, verb, outcome: "already_applied" });
      continue;
    }

    meta.human_disposition = verb;
    meta.human_disposition_record_id = answer.recordId;
    meta.human_disposition_at = new Date().toISOString();
    meta.human_disposition_answer = String(answer.value).slice(0, 2000);

    let status = String(gap.status ?? "open");
    if (verb === "drop") {
      status = "closed";
      meta.closed_reason = "human_dropped";
      meta.resolution = "closed by human disposition: drop (escalation answered)";
      meta.closed_at = new Date().toISOString();
      delete meta.human_exemption_attempts_remaining;
    } else {
      // Restore the bounded re-test path 143212a traded away for this answer.
      meta.human_exemption_attempts_remaining = HUMAN_EXEMPTION_ATTEMPTS;
      meta.human_exemption_granted_at = new Date().toISOString();
      // The gap has new information, so its prior failures no longer describe it.
      meta.failed_attempts = 0;
      status = "open";
    }

    if (!dryRun) {
      await resolveSubstrateGapWrite({
        type: "substrateGap_write",
        gap: {
          id: gapId,
          category: gap.category,
          source: gap.source,
          summary: gap.summary,
          detected_at: gap.detected_at,
          classification_metadata: meta,
          status,
        },
      } as never);
    }
    applied += 1;
    dispositions.push({
      panel_id: panelId,
      gap_id: gapId,
      verb,
      outcome: dryRun ? "would_apply" : "applied",
      status,
      exemption_attempts: verb === "drop" ? 0 : HUMAN_EXEMPTION_ATTEMPTS,
    });
  }

  return {
    shape: "escalationDispositionReport",
    body: {
      authored: true,
      answered: answeredIds.length,
      applied,
      dry_run: dryRun,
      dispositions,
    },
  };
}
