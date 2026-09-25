import * as fs from "node:fs";
import * as path from "node:path";
import { appendRecord, readRecords, ledgerDir } from "./attempt-ledger.js";
import { invariantSelect, takeSnapshot, type CheckResult } from "./attempt-checks.js";
import { resolveUnaccountedLandingScan } from "./unaccounted-landing-scan.js";
import { resolveSubstrateGap, resolveSubstrateGapWrite } from "./substrate-gap.js";
import type { ResolverResult } from "./types.js";

export const CHECK_DEFINITION_FILES = ["src/resolvers/attempt-checks.ts", "src/resolvers/attempt-register.ts", "src/resolvers/systemd-unit-health-observer.ts", "src/resolvers/gate-self-probe.ts", "src/fixtures/attempt-ledger-canary.json"];

export interface Prediction {
  expect_pass: string[];
  expect_change: string[];
}

export interface AttemptOutcome {
  intended: "met" | "unmet" | "unknown";
  intended_vacuous: boolean;
  unexpected_flips: Array<{ id: string; pre: string; post: string }>;
  unknown_checks: string[];
  edits_check_definition: boolean;
  surprise: boolean;
}

export function compareOutcome(pre: CheckResult[], post: CheckResult[], prediction: Prediction, touched_files: string[]): AttemptOutcome {
  const preById = new Map(pre.map(r => [r.id, r]));
  const postById = new Map(post.map(r => [r.id, r]));

  let intended: "met" | "unmet" | "unknown" = "met";
  const intended_vacuous = prediction.expect_pass.length === 0;
  if (!intended_vacuous) {
    for (const id of prediction.expect_pass) {
      const postResult = postById.get(id);
      if (!postResult) {
        intended = "unknown";
        break;
      }
      if (postResult.verdict === "fail") {
        intended = "unmet";
        break;
      }
      if (postResult.verdict === "unknown" || postResult.verdict === "timeout") {
        intended = "unknown";
      }
    }
  }

  const unexpected_flips: Array<{ id: string; pre: string; post: string }> = [];
  for (const preResult of pre) {
    if (preResult.verdict === "pass") {
      const postResult = postById.get(preResult.id);
      if (postResult && postResult.verdict === "fail") {
        if (!prediction.expect_change.includes(preResult.id) && !prediction.expect_pass.includes(preResult.id)) {
          unexpected_flips.push({ id: preResult.id, pre: preResult.verdict, post: postResult.verdict });
        }
      }
    }
  }

  const unknown_checks: string[] = [];
  for (const preResult of pre) {
    if (preResult.verdict === "pass") {
      const postResult = postById.get(preResult.id);
      if (!postResult || postResult.verdict === "unknown" || postResult.verdict === "timeout") {
        unknown_checks.push(preResult.id);
      }
    }
  }

  const edits_check_definition = touched_files.some(f => CHECK_DEFINITION_FILES.some(def => f.endsWith(def)));

  const surprise = unexpected_flips.length > 0 || intended === "unmet" || edits_check_definition;

  return { intended, intended_vacuous, unexpected_flips, unknown_checks, edits_check_definition, surprise };
}

export function settleVerdict(pre: CheckResult[], now: CheckResult[], prediction: Prediction): { verdict: "held" | "regressed" | "unresolved"; regressed_checks: string[]; unresolved_checks: string[] } {
  const nowById = new Map(now.map(r => [r.id, r]));
  const regressed_checks: string[] = [];
  const unresolved_checks: string[] = [];

  const allPrePassIds = new Set(pre.filter(r => r.verdict === 'pass').map(r => r.id));

  for (const id of prediction.expect_pass) {
    allPrePassIds.add(id);
  }

  for (const id of allPrePassIds) {
    const nowResult = nowById.get(id);
    if (nowResult?.verdict === "fail") {
      if (!prediction.expect_change.includes(id)) {
        regressed_checks.push(id);
      }
    } else if (!nowResult || nowResult.verdict === "unknown" || nowResult.verdict === "timeout") {
      unresolved_checks.push(id);
    }
  }

  const verdict = regressed_checks.length > 0 ? "regressed" : (unresolved_checks.length > 0 ? "unresolved" : "held");

  return { verdict, regressed_checks: [...new Set(regressed_checks)], unresolved_checks: [...new Set(unresolved_checks)] };
}

export async function registerAttempt(input: { route: string; repo: string; touched_files: string[]; gap_id?: string | null; proposal_id?: string | null; authoring_execution_id?: string | null; attempt_id?: string; prediction?: Partial<Prediction> }): Promise<{ attempt_id: string | null; registered: boolean; error?: string }> {
  try {
    const attempt_id = input.attempt_id ?? `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

    const existing = await readRecords("attemptIntent", { key: attempt_id });
    if (existing.length > 0) {
      return { attempt_id: (existing[0]!.record as any).attempt_id, registered: false };
    }

    const snapshot = await takeSnapshot({
      checks: invariantSelect({ touched_files: input.touched_files }).checks,
      context: `pre:${attempt_id}`,
      repos: [input.repo]
    });
    const pre_snapshot_id = (snapshot as any).snapshot_id;

    const intent = {
      attempt_id,
      route: input.route,
      repo: input.repo,
      touched_files: input.touched_files,
      gap_id: input.gap_id ?? null,
      proposal_id: input.proposal_id ?? null,
      authoring_execution_id: input.authoring_execution_id ?? null,
      node: null,
      prediction: {
        expect_pass: input.prediction?.expect_pass ?? [],
        expect_change: input.prediction?.expect_change ?? [],
      },
      pre_snapshot_id,
      registered_at: new Date().toISOString(),
    };

    await appendRecord("attemptIntent", attempt_id, intent);

    return { attempt_id, registered: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { attempt_id: null, registered: false, error };
  }
}

export function settleWindowMs(): number {
  const policyPath = path.join(ledgerDir(), "policy", "settlementPolicy.json");
  try {
    if (fs.existsSync(policyPath)) {
      const policy = JSON.parse(fs.readFileSync(policyPath, "utf-8"));
      if (typeof policy.window_ms === "number") {
        return policy.window_ms;
      }
    }
  } catch {
    // ignore errors and use default
  }
  return 900000;
}

export async function sweepAttempts(opts?: { now?: number }): Promise<{ drained: unknown; outcomes_written: number; settlements_written: number; lessons_written: number; errors: string[] }> {
  const now = opts?.now ?? Date.now();
  const errors: string[] = [];
  let outcomes_written = 0;
  let settlements_written = 0;
  let lessons_written = 0;

  // Fold legacy per-commit unaccounted-landing gaps into per-repo aggregates
  try {
    const scan = await resolveSubstrateGap({ type: "substrateGap", category: "unaccounted_landing", limit: 2000 } as any);
    const allGaps = Array.isArray((scan.body as any)?.gaps) ? ((scan.body as any).gaps as any[]) : [];
    const legacy = allGaps.filter((g: any) => typeof g?.id === "string" && g.id.startsWith("unaccounted-landing-") && g.status === "open");

    const byRepo = new Map<string, any[]>();
    for (const g of legacy) {
      const repoFull = String(g?.classification_metadata?.repo ?? "unknown");
      const repoKey = repoFull.split("/").filter(Boolean).pop() ?? "unknown";
      const list = byRepo.get(repoKey);
      if (list) list.push(g); else byRepo.set(repoKey, [g]);
    }

    for (const [repoKey, group] of byRepo) {
      const aggregateId = "unaccounted-landings-" + repoKey;
      const existingRes = await resolveSubstrateGap({ type: "substrateGap", id: aggregateId, limit: 1 });
      const existing = (existingRes.body as any)?.gaps?.[0];
      const existingShas: string[] = (existing?.status === "open" && Array.isArray(existing.classification_metadata?.shas)) ? [...existing.classification_metadata.shas] : [];

      const repoFull = String(group[0]?.classification_metadata?.repo ?? repoKey);
      const legacyShas: string[] = group
        .map((g: any) => String(g?.classification_metadata?.sha ?? ""))
        .filter((s: string) => /^[0-9a-f]{7,40}$/.test(s));
      const shas = Array.from(new Set<string>([...existingShas, ...legacyShas]));

      const existingFirst = existing?.classification_metadata?.first_seen as string | undefined;
      const existingLast = existing?.classification_metadata?.last_seen as string | undefined;
      const ts: number[] = [];
      for (const g of group) {
        const cmeta: any = (g as any).classification_metadata ?? {};
        const candidates = [cmeta.first_seen, cmeta.at, (g as any).at, cmeta.last_seen];
        for (const v of candidates) {
          if (typeof v === "string") {
            const t = Date.parse(v);
            if (Number.isFinite(t)) ts.push(t);
          }
        }
      }
      const nowIso = new Date(now).toISOString();
      const first_seen = existingFirst ?? (ts.length ? new Date(Math.min(...ts)).toISOString() : nowIso);
      const last_seen = ts.length ? new Date(Math.max(...ts)).toISOString() : (existingLast ?? nowIso);

      await resolveSubstrateGapWrite({
        type: "substrateGap_write",
        gap: {
          id: aggregateId,
          category: "unaccounted_landing",
          source: "substrate_detected",
          status: "open",
          summary: `${shas.length} commit(s) in <${repoFull}> landed with no registered attempt; folded from legacy`,
          classification_metadata: {
            repo: repoFull,
            detector: "attempt_sweep",
            shas,
            count: shas.length,
            first_seen,
            last_seen,
          },
        },
      });

      for (const g of group) {
        await resolveSubstrateGapWrite({
          type: "substrateGap_write",
          gap: {
            ...(g as any),
            status: "superseded",
            classification_metadata: { ...(g as any).classification_metadata, duplicate_of: aggregateId },
          },
        });
      }
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  const unaccountedScanResult = await resolveUnaccountedLandingScan({ type: "unaccounted_landing_scan" });
  const drained = unaccountedScanResult.body;
  const shasWrittenThisSweep = new Set<string>();
  if (unaccountedScanResult.shape === 'unaccountedLandingReport' && Array.isArray((unaccountedScanResult.body as any).unaccounted)) {
    for (const landing of (unaccountedScanResult.body as any).unaccounted) {
      if (typeof landing.sha === 'string' && /^[0-9a-f]{7,40}$/.test(landing.sha) && !shasWrittenThisSweep.has(landing.sha)) {
        try {
          const repoKey = String(landing.repo ?? "unknown").split("/").filter(Boolean).pop() ?? "unknown";
          const gap_id = "unaccounted-landings-" + repoKey;

          const existingGapResult = await resolveSubstrateGap({ type: "substrateGap", id: gap_id, limit: 1 });
          const existingGap = (existingGapResult.body as any)?.gaps?.[0];

          const shas = (existingGap?.status === "open" && Array.isArray(existingGap.classification_metadata?.shas)) ? [...existingGap.classification_metadata.shas] : [];
          const first_seen = (existingGap?.status === "open" && existingGap.classification_metadata) ? existingGap.classification_metadata.first_seen : undefined;

          if (!shas.includes(landing.sha)) {
            shas.push(landing.sha);
          }

          await resolveSubstrateGapWrite({
            type: "substrateGap_write",
            gap: {
              id: gap_id,
              category: "unaccounted_landing",
              source: "substrate_detected",
              status: "open",
              summary: `${shas.length} commit(s) in <${landing.repo}> landed with no registered attempt; latest <${landing.sha}> (<${landing.subject}>)`,
              classification_metadata: {
                repo: landing.repo,
                detector: "attempt_sweep",
                shas,
                count: shas.length,
                first_seen: first_seen ?? landing.at ?? new Date(now).toISOString(),
                last_seen: landing.at ?? new Date(now).toISOString(),
                close_predicate: "closes when this repo's next landing carries a registered attempt",
              },
            },
          });
          shasWrittenThisSweep.add(landing.sha);
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
        }
      }
    }
  }

  const intents = await readRecords("attemptIntent");
  for (const intentRec of intents) {
    try {
      const intent = intentRec.record as any;
      const attempt_id = intent.attempt_id;

      const landingEvents = (await readRecords("landingEvent")).filter(r => (r.record as any).attempt_id === attempt_id && ((r.record as any).event === "commit" || (r.record as any).event === "rewrite"));
      if (landingEvents.length === 0) continue;

      const landedShas = landingEvents.map(e => (e.record as any).sha);

      const outcomeRecs = await readRecords("attemptOutcome", { key: attempt_id });
      let outcomeRec = outcomeRecs[0];

      if (!outcomeRec) {
        const earliestLanding = Math.min(...landingEvents.map(e => new Date(e.at).getTime()));
        if (now - earliestLanding >= 60000) {
          const preSnapshotRecs = await readRecords("stateSnapshot", { key: intent.pre_snapshot_id });
          const preSnapshot = preSnapshotRecs?.[0]?.record as { results: CheckResult[] } | undefined;
          if (!preSnapshot) throw new Error(`Pre-snapshot ${intent.pre_snapshot_id} not found for attempt ${attempt_id}`);

          const postSnapshotResult = await takeSnapshot({
            checks: invariantSelect({ touched_files: intent.touched_files }).checks,
            context: `post:${attempt_id}`,
            repos: [intent.repo]
          });
          const post_snapshot_id = (postSnapshotResult as any).snapshot_id;

          const postSnapshotRecs = await readRecords("stateSnapshot", { key: post_snapshot_id });
          const postSnapshot = postSnapshotRecs?.[0]?.record as { results: CheckResult[] } | undefined;
          if (!postSnapshot) throw new Error(`Post-snapshot ${post_snapshot_id} not found for attempt ${attempt_id}`);

          const outcome = compareOutcome(preSnapshot.results, postSnapshot.results, intent.prediction, intent.touched_files);

          const outcomeRecord = {
            attempt_id,
            authoring_execution_id: intent.authoring_execution_id,
            shas: landedShas,
            post_snapshot_id,
            node: intent.node,
            at: new Date().toISOString(),
            ...outcome
          };
          await appendRecord("attemptOutcome", attempt_id, outcomeRecord);
          outcomes_written++;
          const refreshed = await readRecords("attemptOutcome", { key: attempt_id });
          outcomeRec = refreshed[0];
        }
      }

      if (outcomeRec) {
        const settlementRecs = await readRecords("attemptSettlement", { key: `${attempt_id}#1` });
        const outcomeRecord = outcomeRec.record as any;
        if (settlementRecs.length === 0) {
          if (now - new Date(outcomeRec.at).getTime() >= settleWindowMs()) {
            const preSnapshotRecs = await readRecords("stateSnapshot", { key: intent.pre_snapshot_id });
            const preSnapshot = preSnapshotRecs?.[0]?.record as { results: CheckResult[] } | undefined;
            if (!preSnapshot) throw new Error(`Pre-snapshot ${intent.pre_snapshot_id} not found for attempt ${attempt_id}`);

            const settleSnapshotResult = await takeSnapshot({
              checks: invariantSelect({ touched_files: intent.touched_files }).checks,
              context: `settle:${attempt_id}`,
              repos: [intent.repo]
            });
            const settle_snapshot_id = (settleSnapshotResult as any).snapshot_id;
            const settleSnapshotRecs = await readRecords("stateSnapshot", { key: settle_snapshot_id });
            const settleSnapshot = settleSnapshotRecs?.[0]?.record as { results: CheckResult[] } | undefined;
            if (!settleSnapshot) throw new Error(`Settle-snapshot ${settle_snapshot_id} not found for attempt ${attempt_id}`);

            const verdict = settleVerdict(preSnapshot.results, settleSnapshot.results, intent.prediction);

            const settlementRecord = {
              attempt_id,
              settlement_seq: 1,
              authoring_execution_id: intent.authoring_execution_id,
              shas: landedShas,
              snapshot_id: settle_snapshot_id,
              ...verdict,
              credit_eligible: verdict.verdict === "held",
            };

            await appendRecord("attemptSettlement", `${attempt_id}#1`, settlementRecord);
            settlements_written++;

            if (verdict.verdict === "regressed" && intent.gap_id && !intent.gap_id.startsWith("unknown")) {
              lessons_written += await writeLesson(intent, attempt_id, landedShas, `broke: ${verdict.regressed_checks.join(", ")}`);
            }
          }
        }

        if (outcomeRecord.surprise && ((outcomeRecord.unexpected_flips?.length ?? 0) > 0 || outcomeRecord.intended === "unmet") && intent.gap_id && !intent.gap_id.startsWith("unknown")) {
          const reason = `broke: ${outcomeRecord.unexpected_flips.map((f: any) => f.id).join(", ")}`;
          lessons_written += await writeLesson(intent, attempt_id, landedShas, reason);
        }
      }
    } catch (e) {
      errors.push(e instanceof Error ? `Attempt ${(intentRec.record as any).attempt_id}: ${e.message}` : String(e));
    }
  }

  return { drained, outcomes_written, settlements_written, lessons_written, errors };
}

async function writeLesson(intent: any, attempt_id: string, shas: string[], reason_suffix: string): Promise<number> {
  const gapResult = await resolveSubstrateGap({ type: "substrateGap", id: intent.gap_id, limit: 1 });
  const gap = (gapResult.body as any)?.gaps?.[0];
  let lessonWrittenInGap = 0;
  if (gap) {
    if (!gap.classification_metadata) gap.classification_metadata = {};
    if (!gap.classification_metadata.failure_lessons) gap.classification_metadata.failure_lessons = [];

    const lessonExists = gap.classification_metadata.failure_lessons.some((l: any) => l.attempt_id === attempt_id && l.class === 'attempt_consequence');
    if (!lessonExists) {
      gap.classification_metadata.failure_lessons.push({
        class: "attempt_consequence",
        reason: `<${attempt_id}> landed <${shas.join(', ')}> and ${reason_suffix}`,
        at: new Date().toISOString(),
        attempt_id,
      });
      await resolveSubstrateGapWrite({ type: "substrateGap_write", gap });
      lessonWrittenInGap = 1;
    }
  } else if (intent.gap_id && !String(intent.gap_id).startsWith("unknown")) {
    const now = new Date().toISOString();
    const reason = `<${attempt_id}> landed <${shas.join(', ')}> and ${reason_suffix}`;
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id: intent.gap_id,
        category: "attempt_consequence",
        source: "substrate_detected",
        status: "open",
        detected_at: now,
        summary: `Attempt ${attempt_id} landed ${shas.join(", ")} and ${reason_suffix}. The landing's own gap was never recorded, so this gap carries the consequence to address.`,
        classification_metadata: {
          edit_site: Array.isArray(intent.touched_files) ? intent.touched_files[0] : undefined,
          attempt_id,
          failure_lessons: [{ class: "attempt_consequence", reason, at: now, attempt_id }],
        },
      },
    } as never);
    lessonWrittenInGap = 1;
  }

  const lessonFile = "/workspace/proposals/compose-file-lessons.jsonl";
  let lessonWrittenToFile = 0;
  try {
    let fileContent = "";
    if (fs.existsSync(lessonFile)) {
      fileContent = fs.readFileSync(lessonFile, 'utf-8');
    }
    if (!fileContent.includes(`"attempt_id":"${attempt_id}"`)) {
      const reason = `<${attempt_id}> landed <${shas.join(', ')}> and ${reason_suffix}`;
      const lessonLine = JSON.stringify({
        at: new Date().toISOString(),
        files: intent.touched_files,
        tsc: reason,
        kind: "attempt_consequence",
        attempt_id
      }) + "\n";
      fs.appendFileSync(lessonFile, lessonLine);
      lessonWrittenToFile = 1;
    }
  } catch {
    // ignore fs errors on lesson file
  }
  return Math.max(lessonWrittenInGap, lessonWrittenToFile);
}


export async function resolveAttemptRegister(pointer: { type: "attempt_register"; action?: "register" | "sweep" | "status"; attempt_id?: string } & Record<string, unknown>): Promise<ResolverResult> {
  const { action = "status", attempt_id } = pointer;

  switch (action) {
    case "register": {
      const route = typeof (pointer as any).route === "string" ? (pointer as any).route : undefined;
      const repo = typeof (pointer as any).repo === "string" ? (pointer as any).repo : undefined;
      const touched_files = Array.isArray((pointer as any).touched_files) && (pointer as any).touched_files.every((f: unknown) => typeof f === "string") ? (pointer as any).touched_files as string[] : undefined;
      if (!route || !repo || !touched_files) {
        return { shape: "structuredError", body: { message: "route, repo, and touched_files (string[]) are required for register action" } };
      }
      const body = await registerAttempt({
        route,
        repo,
        touched_files,
        gap_id: typeof (pointer as any).gap_id === "string" || (pointer as any).gap_id === null ? (pointer as any).gap_id : undefined,
        proposal_id: typeof (pointer as any).proposal_id === "string" || (pointer as any).proposal_id === null ? (pointer as any).proposal_id : undefined,
        authoring_execution_id: typeof (pointer as any).authoring_execution_id === "string" || (pointer as any).authoring_execution_id === null ? (pointer as any).authoring_execution_id : undefined,
        attempt_id: typeof (pointer as any).attempt_id === "string" ? (pointer as any).attempt_id : undefined,
        prediction: typeof (pointer as any).prediction === "object" && (pointer as any).prediction !== null ? (pointer as any).prediction as Partial<Prediction> : undefined,
      });
      return { shape: "attemptIntent", body };
    }
    case "sweep": {
      const body = await sweepAttempts();
      return { shape: "attemptSweepReport", body };
    }
    case "status":
    default: {
      if (!attempt_id) {
        return { shape: "structuredError", body: { message: "attempt_id is required for status action" } };
      }
      const [intentRecs, outcomeRecs, settlementRecs, landingEvents] = await Promise.all([
        readRecords("attemptIntent", { key: attempt_id }),
        readRecords("attemptOutcome", { key: attempt_id }),
        readRecords("attemptSettlement", { key: `${attempt_id}#1` }),
        readRecords("landingEvent"),
      ]);
      const body = {
        intent: intentRecs[0]?.record ?? null,
        outcome: outcomeRecs[0]?.record ?? null,
        settlement: settlementRecs[0]?.record ?? null,
        landing_events: landingEvents.filter(r => (r.record as any).attempt_id === attempt_id),
      };
      return { shape: "attemptStatus", body };
    }
  }
}