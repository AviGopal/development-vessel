import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendRecord, ledgerDir, readRecords } from "./attempt-ledger.js";
import type { ResolverResult } from "./types.js";

// From spool file, written by git hooks
interface LandingEvent {
  event: "commit" | "rewrite" | "ref_update";
  repo: string;
  branch: string;
  at: string; // ISO8601 string
  execution_id: string;
  sha?: string;
  author?: string;
  subject?: string;
  attempt_id?: string;
  rewritten_from?: string;
  old?: string;
  new?: string;
  ref?: string;
}

interface UnaccountedCommit {
  sha: string;
  repo: string;
  branch: string;
  author: string;
  subject: string;
  execution_id: string;
}

interface LedgerRecord<T> {
  key: string;
  kind: string;
  at: string;
  record: T;
}

export async function resolveUnaccountedLandingScan(
  pointer: { type: "unaccounted_landing_scan"; dry_run?: boolean },
): Promise<ResolverResult> {
  const spoolDir = join(ledgerDir(), "spool");

  if (!existsSync(spoolDir)) {
    return {
      shape: "unaccountedLandingReport",
      body: {
        spool_readable: false,
        ingested: 0,
        bad: 0,
        commits_seen: 0,
        accounted: 0,
        unaccounted: [],
      },
    };
  }

  let spoolFiles: string[];
  try {
    spoolFiles = readdirSync(spoolDir).filter(f => f.endsWith(".json")).sort();
  } catch (err) {
    // This case covers permissions errors etc. on a directory that exists.
    return {
      shape: "unaccountedLandingReport",
      body: {
        spool_readable: false,
        ingested: 0,
        bad: 0,
        commits_seen: 0,
        accounted: 0,
        unaccounted: [],
      },
    };
  }

  let ingested = 0;
  let bad = 0;

  const ingestedKeys = new Set((await readRecords("landingEvent")).map((r) => r.key));
  for (const fileName of spoolFiles) {
    if (ingestedKeys.has("spool:" + fileName)) { ingested++; continue; }
    const filePath = join(spoolDir, fileName);
    try {
      const content = readFileSync(filePath, "utf-8");
      const event = JSON.parse(content) as LandingEvent;

      if (!event.event || !event.repo) { // Basic validation
          bad++;
          continue;
      }
      
      ingested++;
      if (!pointer.dry_run) {
        await appendRecord("landingEvent", "spool:" + fileName, event as unknown as Record<string, unknown>);
      }
    } catch (e) {
      bad++;
    }
  }

  const landingEvents = (await readRecords("landingEvent")) as LedgerRecord<any>[];

  const relevantCommits = landingEvents.filter(
    (r): r is LedgerRecord<LandingEvent> =>
      (r.record.event === "commit" || r.record.event === "rewrite") &&
      !!r.record.sha &&
      !r.record.repo.startsWith("/tmp/")
  );

  const seenShas = new Set<string>();
  const uniqueCommits: LedgerRecord<LandingEvent>[] = [];
  // Deduplicate by sha, keeping the first seen (which will be oldest due to file sort + ledger append order)
  for (const commit of relevantCommits.reverse()) { // Newest first
    if (commit.record.sha && !seenShas.has(commit.record.sha)) {
      seenShas.add(commit.record.sha);
      uniqueCommits.unshift(commit);
    }
  }
  
  let accountedCount = 0;
  const unaccountedCommits: UnaccountedCommit[] = [];

  const intentKeys = new Set((await readRecords("attemptIntent")).map((r) => r.key));
  for (const record of uniqueCommits) {
    const isAccounted =
      record.record.attempt_id &&
      record.record.attempt_id.length > 0 &&
      intentKeys.has(record.record.attempt_id);

    if (isAccounted) {
      accountedCount++;
    } else {
      unaccountedCommits.push({
        sha: record.record.sha!, // known to be present from `relevantCommits` filter
        repo: record.record.repo,
        branch: record.record.branch,
        author: record.record.author ?? "unknown_author",
        subject: record.record.subject ?? "unknown_subject",
        execution_id: record.record.execution_id,
      });
    }
  }

  return {
    shape: "unaccountedLandingReport",
    body: {
      spool_readable: true,
      ingested,
      bad,
      commits_seen: uniqueCommits.length,
      accounted: accountedCount,
      unaccounted: unaccountedCommits,
    },
  };
}