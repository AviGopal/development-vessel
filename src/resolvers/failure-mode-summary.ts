import type { ResolverResult } from '../resolvers/types.js';
import { CONCEPT_DB_ENDPOINT } from '../config.js';

interface TraceRecord {
  execution_id: string;
  failure_mode?: {
    type: string;
    [key: string]: unknown;
  };
  timestamp: number;
  [key: string]: unknown;
}

interface FailureModeAggregate {
  type: string;
  count: number;
  example_execution_id: string;
}

export async function resolveFailureModeSummary(
  _pointer: unknown,
): Promise<ResolverResult> {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const url = new URL('/traces/query', CONCEPT_DB_ENDPOINT);
  url.searchParams.set('since', String(since));
  url.searchParams.set('limit', '10000');

  const response = await fetch(url.toString(), {
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    const text = await response.text();
    return {
      shape: 'structuredError',
      body: { error: `Failed to fetch traces: ${response.status} ${text}` },
    };
  }

  const data = (await response.json()) as { traces?: TraceRecord[] };
  const traces = data.traces ?? [];

  const failureModeMap = new Map<string, { count: number; example_execution_id: string }>();

  for (const trace of traces) {
    if (!trace.failure_mode?.type) continue;
    const type = trace.failure_mode.type;
    const existing = failureModeMap.get(type);
    if (!existing) {
      failureModeMap.set(type, { count: 1, example_execution_id: trace.execution_id });
    } else {
      existing.count += 1;
    }
  }

  const aggregates: FailureModeAggregate[] = Array.from(failureModeMap.entries())
    .map(([type, { count, example_execution_id }]) => ({ type, count, example_execution_id }))
    .sort((a, b) => b.count - a.count);

  return {
    shape: 'failure_mode_summary',
    body: { failure_modes: aggregates },
  };
}

const resolver = async (_pointer: unknown): Promise<ResolverResult> => {
  return resolveFailureModeSummary(_pointer);
};

export default resolver;