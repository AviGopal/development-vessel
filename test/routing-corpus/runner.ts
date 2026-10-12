// THE ROUTING CORPUS RUNNER (closed, development-vessel): replay every case through the core's entries and classify it
// (DESIGN §4.4, §5.3). The same replay and compare logic as goal-host's src/routing-core/corpus-runner.ts; the protected
// tests and cli.ts call it, and the admission glue reads cli.ts's JSON. The glue does its own ratchet comparison (jq)
// over that JSON; nothing here can vouch for a candidate.
//
// Determinism guards: in-process, no spawn, no index.ts import; globalThis.fetch throws for the duration of a case;
// each case runs twice, the second time with a different clock and random source, and a difference marks it
// nondeterministic (red); each run has a wall cap. A read the case's ports do not answer is red (UnrecordedPort).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyChain, type Chain } from "./chain-lib";
import { composeAdmission, type ComposeAdmissionInput } from "../../src/resolvers/compose-admission-core.js";

/** composeAdmission reads no port: its record carries the gathered evidence, the scope port's answers included. */
export type RoutingPorts = Record<string, never>;
export type RoutingLlm = null;
export class UnrecordedPort extends Error {}

export const CASE_SCHEMA = 1;
export type CaseStatus = "green" | "known_red" | "entry_missing";
export type Observed = "green" | "red" | "entry_missing" | "nondeterministic";

export type RoutingCase = {
  schema: 1;
  id: string;
  class: string;
  entry: string;
  credit_class: string | null;
  edit_site: string;
  provenance: { source: string; recorded: string; note: string };
  input: unknown;
  ports: RoutingPorts;
  llm: RoutingLlm | null;
  expect: Record<string, unknown>;
  status_at_append: CaseStatus;
  control: boolean;
  licenses: null | { credit_class: string; direction: string };
};

export type CaseResult = { n: number; id: string; entry: string; control: boolean; status_at_append: CaseStatus; observed: Observed; got: unknown; reason: string | null };
export type CorpusReport = {
  schema: 1;
  corpus: { n: number; link: string };
  problems: string[];
  cases: CaseResult[];
  green: string[];
  /** red now and green at append: a regression the candidate introduced (the glue also checks its stored ever-green set). */
  flips: string[];
  /** red now and red (or entry_missing) at append. */
  known_red: string[];
  entry_missing: string[];
  nondeterministic: string[];
};

/** The entries a case may name. A name not here is entry_missing, never an error. */
export const ENTRIES: Record<string, (c: RoutingCase) => Promise<unknown>> = {
  composeAdmission: async (c) => {
    const { admit, refusal } = composeAdmission(c.input as ComposeAdmissionInput);
    return { admit, refusal };
  },
};

const PER_RUN_MS = 2_000;

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
}

/** A case matches when every key `expect` names is deep-equal in the entry's answer. */
export function matches(expect: Record<string, unknown>, got: unknown): boolean {
  if (!got || typeof got !== "object") return false;
  return Object.keys(expect).every((k) => stable((got as Record<string, unknown>)[k]) === stable(expect[k]));
}

async function once(fn: () => Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`case exceeded ${PER_RUN_MS} ms`)), PER_RUN_MS); })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Run one case's entry twice under the guards. */
export async function replayCase(c: RoutingCase): Promise<{ observed: Observed; got: unknown; reason: string | null }> {
  const entry = ENTRIES[c.entry];
  if (!entry) return { observed: "entry_missing", got: null, reason: `no entry ${c.entry}` };
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  const realRandom = Math.random;
  (globalThis as { fetch: unknown }).fetch = () => { throw new Error("routing replay: fetch is not available to a case"); };
  try {
    let a: unknown;
    let b: unknown;
    try { a = await once(() => entry(c)); } catch (e) { return { observed: "red", got: null, reason: e instanceof UnrecordedPort ? e.message : `threw: ${(e as Error).message}` }; }
    Date.now = () => 4_102_444_800_000; // a different clock: 2100-01-01
    Math.random = () => 0.987654321;
    try { b = await once(() => entry(c)); } catch (e) { return { observed: "nondeterministic", got: a, reason: `second run threw: ${(e as Error).message}` }; }
    finally { Date.now = realNow; Math.random = realRandom; }
    if (stable(a) !== stable(b)) return { observed: "nondeterministic", got: a, reason: "two runs under different clocks/seeds differ" };
    return matches(c.expect, a) ? { observed: "green", got: a, reason: null } : { observed: "red", got: a, reason: "answer differs from expect" };
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
    Date.now = realNow;
    Math.random = realRandom;
  }
}

export function loadCases(dir: string, chain: Chain): RoutingCase[] {
  return chain.lines.map((l) => JSON.parse(readFileSync(join(dir, l.path), "utf8")) as RoutingCase);
}

/** Replay the whole corpus at `dir` (a candidate's test/routing-corpus/). A chain problem is reported, and cases still run. */
export async function runCorpus(dir: string, from = 1): Promise<CorpusReport> {
  const chain = verifyChain(dir);
  const cases: CaseResult[] = [];
  let all: RoutingCase[] = [];
  const problems = [...chain.problems];
  try { all = loadCases(dir, chain); } catch (e) { problems.push(`cases unreadable: ${(e as Error).message}`); }
  for (let i = 0; i < all.length; i++) {
    const n = i + 1;
    if (n < from) continue;
    const c = all[i]!;
    if (c.schema !== CASE_SCHEMA) { problems.push(`${c.id}: case schema ${String(c.schema)} unknown`); continue; }
    const r = await replayCase(c);
    cases.push({ n, id: c.id, entry: c.entry, control: c.control === true, status_at_append: c.status_at_append, ...r });
  }
  const ids = (p: (r: CaseResult) => boolean) => cases.filter(p).map((r) => r.id);
  return {
    schema: 1,
    corpus: { n: chain.n, link: chain.link },
    problems,
    cases,
    green: ids((r) => r.observed === "green"),
    flips: ids((r) => r.observed !== "green" && r.status_at_append === "green"),
    known_red: ids((r) => r.observed === "red" && r.status_at_append !== "green"),
    entry_missing: ids((r) => r.observed === "entry_missing"),
    nondeterministic: ids((r) => r.observed === "nondeterministic"),
  };
}

/** What a case's status_at_append must be, given what the tree observes. */
export function observedStatus(o: Observed): CaseStatus | null {
  return o === "green" ? "green" : o === "red" ? "known_red" : o === "entry_missing" ? "entry_missing" : null;
}

/** append-check: every case from `from` on must carry the status this tree observes (DESIGN §3.4). */
export async function appendCheck(dir: string, from: number): Promise<{ ok: boolean; mismatches: string[]; report: CorpusReport }> {
  const report = await runCorpus(dir, from);
  const mismatches = report.cases
    .filter((r) => observedStatus(r.observed) !== r.status_at_append)
    .map((r) => `${r.id}: status_at_append ${r.status_at_append}, observed ${r.observed}${r.reason ? ` (${r.reason})` : ""}`);
  return { ok: mismatches.length === 0 && report.problems.length === 0, mismatches: [...report.problems, ...mismatches], report };
}
export { canonical, sha256, linkOf, manifestLine, GENESIS } from "./chain-lib";
export { verifyChain };
