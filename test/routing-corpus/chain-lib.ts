// THE CORPUS HASH CHAIN (closed): canonical case bytes and the MANIFEST.jsonl chain (DESIGN §3.2-§3.3).
//
// Entry-agnostic: it knows cases, files and links, not what a case asserts. The same implementation as goal-host's
// src/routing-core/corpus-chain.ts (one chain format across the fleet's corpora).
//
//   canonical bytes: UTF-8, LF, keys sorted recursively, 2-space indent, a trailing newline, no NaN/undefined/Infinity;
//   manifest line n: {"n","id","path","case_sha256","prev","link"}, link = sha256(prev "\n" n "\n" id "\n" case_sha256),
//   prev of line 1 = 64 zeros. A case file that is not byte-equal to its canonical form is a problem, so a
//   whitespace-only edit is still a hash change.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const GENESIS = "0".repeat(64);

export type ManifestLine = { n: number; id: string; path: string; case_sha256: string; prev: string; link: string };
export type Chain = { n: number; link: string; lines: ManifestLine[]; problems: string[] };

export const sha256 = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

function sortDeep(v: unknown, at: string): unknown {
  if (v === undefined) throw new Error(`canonical: undefined at ${at}`);
  if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`canonical: non-finite number at ${at}`);
  if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") throw new Error(`canonical: ${typeof v} at ${at}`);
  if (Array.isArray(v)) return v.map((x, i) => sortDeep(x, `${at}[${i}]`));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = sortDeep((v as Record<string, unknown>)[k], `${at}.${k}`);
    return out;
  }
  return v;
}

/** The canonical bytes of a case. Throws on anything JSON cannot carry faithfully. */
export function canonical(v: unknown): string {
  return JSON.stringify(sortDeep(v, "$"), null, 2) + "\n";
}

export function linkOf(prev: string, n: number, id: string, caseSha: string): string {
  return sha256(`${prev}\n${n}\n${id}\n${caseSha}`);
}

export function manifestLine(n: number, id: string, path: string, caseSha: string, prev: string): ManifestLine {
  return { n, id, path, case_sha256: caseSha, prev, link: linkOf(prev, n, id, caseSha) };
}

/** Every file under `<dir>/cases/`, as "cases/<...>" paths. */
function caseFiles(dir: string): string[] {
  const root = join(dir, "cases");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p); else out.push(relative(dir, p).split("\\").join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Verify `<dir>/MANIFEST.jsonl` and `<dir>/cases/` against each other. Problems are listed, never thrown: an absent or
 * empty manifest is a problem, so "no corpus" can never read as "a green corpus".
 */
export function verifyChain(dir: string): Chain {
  const problems: string[] = [];
  const lines: ManifestLine[] = [];
  const mf = join(dir, "MANIFEST.jsonl");
  if (!existsSync(mf)) return { n: 0, link: GENESIS, lines, problems: ["MANIFEST.jsonl absent"] };
  const raw = readFileSync(mf, "utf8");
  if (raw.length > 0 && !raw.endsWith("\n")) problems.push("MANIFEST.jsonl does not end with a newline");
  if (raw.includes("\r")) problems.push("MANIFEST.jsonl carries CR bytes");
  const text = raw.split("\n").filter((l, i, a) => !(i === a.length - 1 && l === ""));
  if (text.length === 0) problems.push("MANIFEST.jsonl is empty");
  let prev = GENESIS;
  const listed = new Set<string>();
  text.forEach((l, i) => {
    const n = i + 1;
    let m: ManifestLine;
    try { m = JSON.parse(l) as ManifestLine; } catch { problems.push(`line ${n}: not JSON`); return; }
    const keys = Object.keys(m).join(",");
    if (keys !== "n,id,path,case_sha256,prev,link") problems.push(`line ${n}: keys ${keys} (want n,id,path,case_sha256,prev,link in that order)`);
    if (m.n !== n) problems.push(`line ${n}: n=${m.n} (lines must be contiguous from 1)`);
    if (m.prev !== prev) problems.push(`line ${n}: prev does not equal line ${n - 1}'s link`);
    if (m.link !== linkOf(m.prev, m.n, m.id, m.case_sha256)) problems.push(`line ${n}: link does not recompute`);
    if (!/^\d{4}-[a-z0-9][a-z0-9-]*$/.test(String(m.id)) || Number(String(m.id).slice(0, 4)) !== n) problems.push(`line ${n}: id ${m.id} is not ${String(n).padStart(4, "0")}-<slug>`);
    if (!/^cases\/[a-z0-9][a-z0-9-]*\/[^/]+\.json$/.test(String(m.path)) || !String(m.path).endsWith(`/${m.id}.json`)) problems.push(`line ${n}: path ${m.path} is not cases/<class>/<id>.json`);
    if (listed.has(m.path)) problems.push(`line ${n}: ${m.path} listed twice`);
    listed.add(m.path);
    const f = join(dir, m.path);
    if (!existsSync(f)) problems.push(`line ${n}: ${m.path} missing`);
    else {
      const bytes = readFileSync(f, "utf8");
      if (sha256(bytes) !== m.case_sha256) problems.push(`line ${n}: ${m.path} sha256 does not match the manifest`);
      try {
        const c = JSON.parse(bytes) as { id?: unknown; class?: unknown };
        if (canonical(c) !== bytes) problems.push(`line ${n}: ${m.path} is not in canonical bytes`);
        if (c.id !== m.id) problems.push(`line ${n}: case id ${String(c.id)} differs from the manifest id`);
        if (!String(m.path).startsWith(`cases/${String(c.class)}/`)) problems.push(`line ${n}: case class ${String(c.class)} differs from its directory`);
      } catch (e) { problems.push(`line ${n}: ${m.path} unparseable (${(e as Error).message})`); }
    }
    lines.push(m);
    prev = m.link;
  });
  for (const f of caseFiles(dir)) if (!listed.has(f)) problems.push(`${f} is not listed in MANIFEST.jsonl`);
  return { n: lines.length, link: lines.length ? lines[lines.length - 1]!.link : GENESIS, lines, problems };
}
