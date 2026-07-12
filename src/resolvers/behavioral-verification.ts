import { METABOB_API_KEY } from "../config.js";

export interface VerificationOutcome {
  ran: boolean;
  passed: boolean;
  observed?: unknown;
  error?: string;
}

function walkPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Execute a structured, shell-free verification spec from a gap record.
 * Only localhost HTTP resolves are permitted; anything else is a no-op pass
 * (ran: false) so absent/malformed specs never block a landing. */
export async function runBehavioralVerification(spec: unknown): Promise<VerificationOutcome> {
  const s = spec as { resolve?: { endpoint?: string; body?: unknown }; expect?: { json_path?: string; op?: string; value?: unknown } } | null;
  const endpoint = s?.resolve?.endpoint;
  const jsonPath = s?.expect?.json_path;
  if (typeof endpoint !== "string" || typeof jsonPath !== "string") return { ran: false, passed: true };
  if (!endpoint.startsWith("http://localhost") && !endpoint.startsWith("http://127.0.0.1")) return { ran: false, passed: true };
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
        body: JSON.stringify(s?.resolve?.body ?? {}),
        signal: AbortSignal.timeout(20_000),
      });
      const json = (await resp.json()) as unknown;
      const observed = walkPath(json, jsonPath);
      const op = s?.expect?.op ?? "eq";
      const expected = s?.expect?.value;
      let passed = false;
      if (op === "eq") passed = observed === expected;
      else if (op === "gt") passed = Number(observed) > Number(expected);
      else if (op === "gte") passed = Number(observed) >= Number(expected);
      else if (op === "contains") passed = String(observed).includes(String(expected));
      return { ran: true, passed, observed };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  return { ran: true, passed: false, error: String(lastErr) };
}
