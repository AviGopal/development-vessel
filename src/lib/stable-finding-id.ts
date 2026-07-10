/**
 * stable-finding-id.ts
 *
 * Utilities to produce stable, run-invariant finding IDs by stripping
 * volatile tokens (timestamps, monotonic counters, UUIDs) so that
 * re-emission of the same logical finding is recognised as a duplicate
 * rather than a novel event.
 *
 * Root cause addressed: selector_saturation_audit detected 8 redundant-pinned
 * detectors with mean_novel_fraction=0.25 because their finding IDs changed
 * every run, defeating pool-level deduplication.
 */

/** Patterns considered volatile / run-specific */
const VOLATILE_PATTERNS: RegExp[] = [
  // ISO-8601 timestamps (with or without ms / timezone)
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g,
  // Unix epoch timestamps (10-digit seconds or 13-digit ms)
  /(?<!\d)\d{13}(?!\d)/g,
  /(?<![\w-])\d{10}(?![\d])/g,
  // Version-4 UUIDs
  /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
  // Monotonic run-counters appended as -NNN or _NNN at end of segment
  /(?<=[_-])\d{1,6}$/g,
];

/**
 * Strip all volatile tokens from `raw` and return a stable string
 * suitable for use as a finding ID.
 *
 * @example
 *   stabilise('resolver-distribution-audit-2024-01-15T12:34:56Z')
 *   // => 'resolver-distribution-audit-'
 *
 *   stabilise('dead-end-decision-scan-1705318496123')
 *   // => 'dead-end-decision-scan-'
 */
export function stabilise(raw: string): string {
  let result = raw;
  for (const pattern of VOLATILE_PATTERNS) {
    // Reset lastIndex because we use global flag
    pattern.lastIndex = 0;
    result = result.replace(pattern, '');
  }
  // Collapse multiple trailing separators introduced by stripping
  result = result.replace(/[-_]{2,}/g, '-').replace(/[-_]+$/, '');
  return result;
}

/**
 * Build a stable finding ID from a fixed template name plus an optional
 * deterministic discriminator (e.g. a field name or category string).
 *
 * Using this helper instead of embedding `Date.now()` or `crypto.randomUUID()`
 * in IDs ensures the pool deduplication layer sees the same ID on every run
 * and does not count re-emissions as novel findings.
 *
 * @param template  The detector template key, e.g. 'development-vessel:resolver-distribution-audit-tick'
 * @param discriminator  Optional stable qualifier (category, field, selector name …)
 */
export function stableFindingId(template: string, discriminator?: string): string {
  const base = template.replace(/[^a-zA-Z0-9-]/g, '-');
  if (!discriminator) return base;
  const disc = discriminator.replace(/[^a-zA-Z0-9-]/g, '-').replace(/[-]+/g, '-').replace(/^-|-$/g, '');
  return `${base}--${disc}`;
}

/**
 * Wrap an existing finding object and return a new object with its `id`
 * field stabilised.  All other fields are preserved unchanged.
 *
 * @param finding  Any object that has at least an `id: string` field.
 */
export function withStableId<T extends { id: string }>(finding: T): T {
  return { ...finding, id: stabilise(finding.id) };
}
