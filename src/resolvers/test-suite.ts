import type { ResolverResult } from "./types.js";

/** Asynchronous resolver for the "test_suite" shape.
 *
 * Fetches real substrate data and returns a computed report for test_suite.
 * - Aggregates test execution summaries from the substrate's test store.
 * - Computes a concise report including total tests, pass/fail counts, and
 *   a list of failing test IDs with their failure messages.
 */
export async function resolveTestSuite(pointer: Record<string, unknown>): Promise<ResolverResult> {
  // Import built-in modules only to avoid new dependencies.
  const { fetch } = globalThis as any;

  // Resolve the substrate endpoint from env or config.
  const substrateUrl = process.env.SUBSTRATE_BASE_URL ?? "http://localhost:8080";

  // Fetch test execution summaries from the substrate's test store.
  const testStoreUrl = new URL("/api/test-store/summaries", substrateUrl).toString();
  const summariesRes = await fetch(testStoreUrl, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!summariesRes.ok) {
    throw new Error(`failed to fetch test summaries: ${summariesRes.status} ${await summariesRes.text()}`);
  }

  const summaries: Array<{
    testId: string;
    title: string;
    status: "pass" | "fail" | "skip";
    failureMessage?: string;
  }> = (await summariesRes.json()) as any;

  // Aggregate into a concise report.
  const total = summaries.length;
  const passCount = summaries.filter((s) => s.status === "pass").length;
  const failCount = summaries.filter((s) => s.status === "fail").length;
  const skipCount = summaries.filter((s) => s.status === "skip").length;

  const failingTests = summaries
    .filter((s) => s.status === "fail")
    .map((s) => ({ id: s.testId, title: s.title, message: s.failureMessage ?? "Unknown failure" }));

  const body = {
    total,
    pass: passCount,
    fail: failCount,
    skip: skipCount,
    failingTests,
    timestamp: new Date().toISOString(),
  };

  return { shape: "test_suite", body };
}
