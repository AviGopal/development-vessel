import type { ResolverResult } from './types.js';

export async function resolveCompositionCoverageReport(pointer: {
  type: 'composition_coverage_report';
}): Promise<ResolverResult> {
  // Fetch REAL substrate data and compute coverage report
  const response = await fetch(`${process.env.SUBSTRATE_API_URL ?? 'http://localhost:8765'}/v1/composition/coverage`, {
    headers: process.env.SUBSTRATE_API_KEY ? { Authorization: `ApiKey ${process.env.SUBSTRATE_API_KEY}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    return {
      shape: 'structuredError',
      body: {
        message: `Failed to fetch composition coverage: HTTP ${response.status}`,
        details: await response.text(),
      },
    };
  }
  const coverage = (await response.json()) as any;
  return {
    shape: 'composition_coverage_report',
    body: coverage,
  };
}