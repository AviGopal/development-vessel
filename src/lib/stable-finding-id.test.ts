import { describe, it, expect } from 'bun:test';
import { stabilise, stableFindingId, withStableId } from './stable-finding-id';

describe('stabilise', () => {
  it('strips ISO timestamps', () => {
    expect(stabilise('audit-2024-01-15T12:34:56Z')).toBe('audit');
  });

  it('strips ISO timestamps with ms', () => {
    expect(stabilise('audit-2024-01-15T12:34:56.789Z')).toBe('audit');
  });

  it('strips 13-digit epoch ms', () => {
    expect(stabilise('scan-1705318496123')).toBe('scan');
  });

  it('strips UUID v4', () => {
    expect(stabilise('finding-550e8400-e29b-4d00-a456-426614174000')).toBe('finding');
  });

  it('leaves stable strings unchanged', () => {
    expect(stabilise('resolver-distribution-audit-tick')).toBe('resolver-distribution-audit-tick');
  });

  it('collapses trailing separators', () => {
    const result = stabilise('my-detector-2024-01-15T00:00:00Z');
    expect(result).not.toMatch(/[-_]$/);
  });
});

describe('stableFindingId', () => {
  it('produces a stable id without discriminator', () => {
    const id = stableFindingId('development-vessel:resolver-distribution-audit-tick');
    expect(id).toBe('development-vessel-resolver-distribution-audit-tick');
  });

  it('appends discriminator when provided', () => {
    const id = stableFindingId('development-vessel:dead-end-decision-scan-tick', 'category-X');
    expect(id).toBe('development-vessel-dead-end-decision-scan-tick--category-X');
  });

  it('is idempotent across calls', () => {
    const a = stableFindingId('development-vessel:model-opportunity-tick', 'gpt-4o');
    const b = stableFindingId('development-vessel:model-opportunity-tick', 'gpt-4o');
    expect(a).toBe(b);
  });
});

describe('withStableId', () => {
  it('replaces volatile id while preserving other fields', () => {
    const finding = {
      id: 'finding-2024-05-01T10:00:00Z',
      severity: 'warn',
      message: 'test',
    };
    const stable = withStableId(finding);
    expect(stable.id).toBe('finding');
    expect(stable.severity).toBe('warn');
    expect(stable.message).toBe('test');
  });
});
