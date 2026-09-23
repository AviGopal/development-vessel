import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolverResult } from './types.js';

export type LedgerKind = "attemptIntent" | "stateSnapshot" | "attemptOutcome" | "attemptSettlement" | "landingEvent";

export function ledgerDir(): string {
  return process.env.ATTEMPT_LEDGER_DIR ?? "/workspace/attempt-ledger";
}

export function appendRecord(kind: LedgerKind, key: string, record: Record<string, unknown>): { appended: boolean; key: string } {
  const dir = ledgerDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  const filePath = join(dir, `${kind}.jsonl`);
  const existingContent = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  
  // Check for existing key
  for (const line of existingContent.split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { key: string };
      if (parsed.key === key) {
        return { appended: false, key };
      }
    } catch {
      // Skip malformed lines
    }
  }
  
  const newLine = JSON.stringify({ key, kind, at: new Date().toISOString(), record }) + "\n";
  appendFileSync(filePath, newLine);
  return { appended: true, key };
}

export function readRecords(kind: LedgerKind, opts?: { key?: string; limit?: number }): Array<{ key: string; kind: string; at: string; record: Record<string, unknown> }> {
  const filePath = join(ledgerDir(), `${kind}.jsonl`);
  if (!existsSync(filePath)) return [];
  
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  let records: Array<{ key: string; kind: string; at: string; record: Record<string, unknown> }> = [];
  
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (opts?.key && parsed.key !== opts.key) continue;
      records.push(parsed);
    } catch {
      // Skip malformed lines
    }
  }
  
  if (opts?.limit) {
    records = records.slice(-opts.limit);
  }
  
  return records;
}

export async function resolveAttemptLedger(pointer: { type: "attemptLedger"; kind: LedgerKind; key?: string; limit?: number }): Promise<ResolverResult> {
  const { kind, key, limit } = pointer;
  const records = readRecords(kind, { key, limit });
  
  if (["attemptIntent", "stateSnapshot", "attemptOutcome", "attemptSettlement", "landingEvent"].includes(kind)) {
    return { 
      shape: "attemptLedger", 
      body: { kind, records } 
    };
  }
  
  return { 
    shape: "structuredError", 
    body: { error: "unknown ledger kind", kind } 
  };
}