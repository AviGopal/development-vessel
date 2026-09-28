import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ResolverResult } from './types.js';

export type LedgerKind = "attemptIntent" | "stateSnapshot" | "attemptOutcome" | "attemptSettlement" | "landingEvent";

export function ledgerDir(): string {
  if (process.env.ATTEMPT_LEDGER_DIR) return process.env.ATTEMPT_LEDGER_DIR;
  // bun test sets NODE_ENV=test; a test run must never write the live ledger.
  if (process.env.NODE_ENV === "test") return join(tmpdir(), `attempt-ledger-test-${process.pid}`);
  return "/workspace/attempt-ledger";
}

const VALID_LEDGER_KINDS: ReadonlySet<string> = new Set<LedgerKind>([
  "attemptIntent",
  "stateSnapshot",
  "attemptOutcome",
  "attemptSettlement",
  "landingEvent",
]);

type LedgerRecord = {
  key: string;
  kind: LedgerKind;
  at: string;
  record: Record<string, unknown>;
};

function isLedgerRecord(obj: unknown): obj is LedgerRecord {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }
  const rec = obj as LedgerRecord;
  return (
    typeof rec.key === "string" &&
    VALID_LEDGER_KINDS.has(rec.kind) &&
    typeof rec.at === "string" &&
    typeof rec.record === "object" &&
    rec.record !== null &&
    !Array.isArray(rec.record)
  );
}

export function appendRecord(kind: LedgerKind, key: string, record: Record<string, unknown>): { appended: boolean; key: string } {
  const dir = ledgerDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const filePath = join(dir, `${kind}.jsonl`);

  if (existsSync(filePath)) {
    const fileContent = readFileSync(filePath, "utf-8");
    const lines = fileContent.split("\n");
    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed === "object" && parsed !== null && "key" in parsed && (parsed as { key: unknown }).key === key) {
          return { appended: false, key };
        }
      } catch (e) {
        // Ignore malformed lines
      }
    }
  }

  const newRecord: LedgerRecord = { key, kind, at: new Date().toISOString(), record };
  const newLine = JSON.stringify(newRecord) + "\n";
  appendFileSync(filePath, newLine, "utf-8");

  return { appended: true, key };
}

export function readRecords(
  kind: LedgerKind,
  opts?: { key?: string; limit?: number }
): Array<LedgerRecord> {
  const filePath = join(ledgerDir(), `${kind}.jsonl`);
  if (!existsSync(filePath)) {
    return [];
  }

  const fileContent = readFileSync(filePath, "utf-8");
  const lines = fileContent.split("\n");
  const records: LedgerRecord[] = [];

  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (isLedgerRecord(parsed)) {
        if (opts?.key && parsed.key !== opts.key) {
          continue;
        }
        records.push(parsed);
      }
    } catch (e) {
      // Ignore malformed lines
    }
  }

  if (opts?.limit && opts.limit > 0) {
    return records.slice(-opts.limit);
  }

  return records;
}

export async function resolveAttemptLedger(pointer: {
  type: "attemptLedger";
  kind: LedgerKind;
  key?: string;
  limit?: number;
}): Promise<ResolverResult> {
  const { kind, key, limit } = pointer;

  if (!VALID_LEDGER_KINDS.has(kind)) {
    return {
      shape: "structuredError",
      body: { error: "unknown ledger kind", kind },
    };
  }

  const records = readRecords(kind, { key, limit });
  return {
    shape: "attemptLedger",
    body: { kind, records },
  };
}