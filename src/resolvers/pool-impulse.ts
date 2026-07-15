import { join } from 'node:path';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WORKSPACE_ROOT } from '../config.js';

const POOL_DIR = join(WORKSPACE_ROOT, 'pool');
const POOL_FILE = join(POOL_DIR, 'standing.json');

export interface StandingImpulse {
  id: string;
  shape: string;
  body: unknown;
  source: string;
  status: 'open' | 'consumed' | 'retired';
  injected_at: string;
  updated_at: string;
}

function loadImpulses(): StandingImpulse[] {
  if (!existsSync(POOL_FILE)) return [];
  try {
    const raw = readFileSync(POOL_FILE, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as StandingImpulse[];
    return [];
  } catch {
    return [];
  }
}

function saveImpulses(impulses: StandingImpulse[]): void {
  mkdirSync(POOL_DIR, { recursive: true });
  const tmp = POOL_FILE + '.tmp.' + Date.now();
  writeFileSync(tmp, JSON.stringify(impulses, null, 2), 'utf8');
  // atomic rename
  const fs = require('node:fs') as typeof import('node:fs');
  fs.renameSync(tmp, POOL_FILE);
}

export function resolvePoolImpulse(pointer: {
  type: string;
  id?: string;
  shape?: string;
  status?: string;
  limit?: number;
}): { shape: string; body: { impulses: StandingImpulse[]; count: number } } {
  const all = loadImpulses();
  const statusFilter = pointer.status ?? 'open';
  let filtered = all.filter((imp) => imp.status === statusFilter);
  if (pointer.id !== undefined) {
    filtered = filtered.filter((imp) => imp.id === pointer.id);
  }
  if (pointer.shape !== undefined) {
    filtered = filtered.filter((imp) => imp.shape === pointer.shape);
  }
  const limit = pointer.limit;
  const sorted = filtered.slice().sort((a, b) => {
    const ta = a.updated_at ?? a.injected_at ?? '';
    const tb = b.updated_at ?? b.injected_at ?? '';
    return tb < ta ? -1 : tb > ta ? 1 : 0;
  });
  const limited = limit !== undefined ? sorted.slice(0, limit) : sorted;
  return {
    shape: 'poolImpulse',
    body: { impulses: limited, count: limited.length },
  };
}

export function resolvePoolImpulseWrite(pointer: {
  type: string;
  id?: string;
  shape?: string;
  body?: unknown;
  source?: string;
  status?: 'open' | 'consumed' | 'retired';
  injected_at?: string;
  updated_at?: string;
}): { shape: string; body: { ok: boolean; id: string } } {
  const all = loadImpulses();
  const now = new Date().toISOString();
  const id = pointer.id ?? randomUUID();
  const idx = all.findIndex((imp) => imp.id === id);
  if (idx >= 0) {
    const existing = all[idx]!;
    all[idx] = {
      id,
      shape: pointer.shape ?? existing.shape,
      body: pointer.body !== undefined ? pointer.body : existing.body,
      source: pointer.source ?? existing.source,
      status: pointer.status ?? existing.status,
      injected_at: existing.injected_at,
      updated_at: now,
    };
  } else {
    const entry: StandingImpulse = {
      id,
      shape: pointer.shape ?? '',
      body: pointer.body ?? null,
      source: pointer.source ?? '',
      status: pointer.status ?? 'open',
      injected_at: pointer.injected_at ?? now,
      updated_at: now,
    };
    all.push(entry);
  }
  saveImpulses(all);
  return { shape: 'poolImpulse_write', body: { ok: true, id } };
}
