import type { ResolverResult } from "./types.js";

export async function resolveLiftDemoNoop(): Promise<ResolverResult> {
  return {
    shape: "liftDemoResult",
    body: {
      message: "self-application cycle complete",
      timestamp: new Date().toISOString(),
      description: "This resolver was created by the vessel's self-application demo",
    },
  };
}
