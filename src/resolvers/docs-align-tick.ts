import { METABOB_ENDPOINT, env } from "../config.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveDocsAlignScan } from "./docs-align-scan.js";
import { resolveDocsAlignBridge } from "./docs-align-bridge.js";
import type { ResolverResult } from "./types.js";
import type { DocsAlignFinding } from "./docs-align-scan.js";

const DOC_ROOT = process.env.DOC_FIX_ROOT ?? "/workspace/git/super-repo";

// Directories no walk descends into. node_modules is the load-bearing one: the
// script walk is capped, and a vendored dependency tree under scripts/ (thousands
// of files in one relay package) exhausted the cap before the walk reached the
// real scripts, so correct doc citations of those scripts were reported missing.
const SKIP_DIRS = new Set(["node_modules", ".git"]);

interface DocsAlignTickPointer {
  type: "docs_align_tick";
  dry_run?: boolean;
  max_fixes?: number;
}

function walkMd(dir: string, cap: number): Array<{ id: string; source: string; body: string }> {
  const results: Array<{ id: string; source: string; body: string }> = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= cap) break;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "archive" || SKIP_DIRS.has(entry.name)) continue;
        const sub = walkMd(full, cap - results.length);
        results.push(...sub);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          const st = statSync(full);
          if (st.size > 200000) continue;
          const rel = relative(DOC_ROOT, full);
          const body = readFileSync(full, "utf8");
          results.push({ id: rel, source: rel, body });
        } catch {
          // skip unreadable file
        }
      }
    }
  } catch {
    // skip unreadable dir
  }
  return results;
}

async function deriveNamingVocabulary(
  documents: Array<{ id: string; source: string; body: string }>,
): Promise<{ deprecated: Array<{ pattern: string; canonical: string; path_only?: boolean }>; retained: string[] }> {
  try {
    let projectName = "substrate";
    try {
      const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd: DOC_ROOT, stdout: "pipe" });
      const out = await new Response(proc.stdout).text();
      const trimmed = out.trim();
      if (trimmed.length > 0) {
        const parts = trimmed.split("/");
        const last = parts[parts.length - 1];
        if (last && last.length > 0) projectName = last;
      }
    } catch {
      // git absent
    }

    const tokenRe = /metabob-[a-z0-9]+(?:-[a-z0-9]+)*/gi;
    const tokens = new Set<string>();

    try {
      const proc = Bun.spawn(["git", "log", "--oneline", "-n", "500"], { cwd: DOC_ROOT, stdout: "pipe" });
      const out = await new Response(proc.stdout).text();
      const matches = out.match(tokenRe);
      if (matches) for (const m of matches) tokens.add(m.toLowerCase());
    } catch {
      // ignore
    }

    try {
      const combined = documents.map((d) => d.body).join("\n");
      const matches = combined.match(tokenRe);
      if (matches) for (const m of matches) tokens.add(m.toLowerCase());
    } catch {
      // ignore
    }

    try {
      const res = await fetch(`${METABOB_ENDPOINT}/v2/impulses/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ impulse: { type: "memoryNote", limit: 100 } }),
      });
      const j = (await res.json()) as unknown;
      const text = JSON.stringify(j);
      const matches = text.match(tokenRe);
      if (matches) for (const m of matches) tokens.add(m.toLowerCase());
    } catch {
      // ignore
    }

    const deprecated: Array<{ pattern: string; canonical: string; path_only?: boolean }> = [];
    for (const token of tokens) {
      const x = token.slice("metabob-".length);
      const canonical = x === "devbob" ? projectName : x;
      if (canonical === token) continue;
      deprecated.push({ pattern: token, canonical, path_only: x !== "devbob" });
    }
    return { deprecated, retained: [] };
  } catch {
    return { deprecated: [], retained: [] };
  }
}


export function walkScripts(dir: string, cap: number, root: string = DOC_ROOT): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= cap) break;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const sub = walkScripts(full, cap - results.length, root);
        results.push(...sub);
      } else if (entry.isFile()) {
        const rel = relative(root, full);
        if (rel.startsWith("scripts/")) results.push(rel);
      }
    }
  } catch {
    // skip unreadable dir
  }
  return results;
}

// ---- Install-surface checks (deterministic; no LLM, no network) ----
//
// README § Installation is the one page with setup commands; every other doc
// links to it. Three drift classes follow from that, each checked by reading
// the files the claim is about, at tick time:
//   install_single_source — a launch command restated outside README § Installation
//   env_var_unread        — a doc sets a variable (in a fenced command or env block) that
//                           gen-env.sh neither reads nor emits, so the setting silently does nothing
//   make_target_missing   — a doc runs a make target the Makefile does not define
//
// A doc that NAMES a command is not restating it. Prose mentions ("`make up`,
// which wraps it") and tables of retired lanes are correct docs, and a finding
// against them becomes a gap filed against a correct doc. So a command is read
// from a fenced line, or from an inline code span that opens the line (a list
// item, a `$ ` prompt, a table cell); rows of a table whose header names retired,
// replaced or deprecated things are never read as commands.

// `commandContext`: every line is command text (a comment header of a config file,
// where commands are written bare), not markdown prose.
type Doc = { id: string; source: string; body: string; commandContext?: boolean };

// Launch commands. Kept in step with the search the install-page cleanup is
// verified by, plus the spellings of the same commands (podman, compose v1,
// bare `make up`, the retired run-* lanes and deploy scripts).
// `commandOnly` patterns are matched only against command text (a fenced line or
// a code span that opens the line): "make up" is also English, and a bare target
// name mid-sentence is a mention. The other patterns are unambiguous spellings and
// match anywhere on a line that is not a retired-table row.
const LAUNCH_PATTERNS: Array<{ name: string; rx: RegExp; commandOnly?: boolean }> = [
  // compose, then only flags (with optional values) before `up`
  { name: "compose up", rx: /\b(?:docker|podman)[ -]compose(?:\s+-\S+(?:\s+(?!up\b)[^\s-]\S*)?)*\s+up\b/ },
  { name: "make up", rx: /\bmake\s+-C\s+\S*scripts\/substrate\s+(?:up|run|run-live|run-live-obsidian|run-detach)\b(?!-)/ },
  { name: "make up", rx: /\bmake\s+(?:up|run-live|run-live-obsidian|run-detach)\b(?!-)/, commandOnly: true },
  { name: "run --privileged", rx: /\b(?:docker|podman)\s+run\b[^\n]*--privileged\b/ },
  { name: "deploy script", rx: /\bdeploy-(?:hub|hub-pull|remote)(?:\.sh)?\b/ },
];

const ENV_NAME = "[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9]";

/** Variable names gen-env.sh reads or emits: every identifier on a non-comment line. */
export function genEnvNames(genEnvSource: string): Set<string> {
  const names = new Set<string>();
  const rx = new RegExp(`\\b${ENV_NAME}\\b`, "g");
  for (const line of genEnvSource.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    for (const m of line.match(rx) ?? []) names.add(m);
  }
  return names;
}

/** Targets a Makefile defines: rule heads (not `:=`/`::=` assignments) and .PHONY lists. */
export function makefileTargets(makefileSource: string): Set<string> {
  const targets = new Set<string>();
  for (const line of makefileSource.split(/\r?\n/)) {
    if (/^\t/.test(line) || /^\s*#/.test(line)) continue;
    const phony = line.match(/^\.PHONY\s*:\s*(.*)$/);
    if (phony) {
      for (const t of (phony[1] ?? "").split(/\s+/)) if (t) targets.add(t);
      continue;
    }
    const rule = line.match(/^([A-Za-z0-9_.%/$(){}-][^:=#]*?)\s*:(?![:=])/);
    if (!rule) continue;
    for (const t of (rule[1] ?? "").trim().split(/\s+/)) if (t) targets.add(t);
  }
  return targets;
}

function targetDefined(target: string, targets: Set<string>): boolean {
  if (targets.has(target)) return true;
  for (const t of targets) {
    if (!t.includes("%")) continue;
    const [pre, post] = t.split("%", 2) as [string, string];
    if (target.startsWith(pre) && target.endsWith(post ?? "") && target.length > pre.length + (post ?? "").length) return true;
  }
  return false;
}

/** Line ranges of README § Installation (heading to the next heading of the same or higher level). */
function installationLines(doc: Doc): Set<number> {
  const inside = new Set<number>();
  if (doc.id !== "README.md") return inside;
  const lines = doc.body.split(/\r?\n/);
  let fence = false;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence ? line.match(/^(#{1,6})\s+(.*)$/) : null;
    if (h) {
      const lv = (h[1] ?? "").length;
      if (level > 0 && lv <= level) level = 0;
      if (level === 0 && /^installation\b/i.test((h[2] ?? "").trim())) level = lv;
    }
    if (level > 0) inside.add(i);
  }
  return inside;
}

// What may precede a code span for the span to be a command: nothing but list,
// quote or prompt markup, or a table cell boundary.
const SPAN_OPENS_COMMAND = /(?:^\s*(?:>\s*)*(?:[-*+]\s+|\d+[.)]\s+)?(?:\$\s+)?|\|\s*)$/;

/**
 * Shell command segments in a line: the whole line inside a fence, else each
 * inline code span that opens the line or a table cell, or that starts with a
 * `$ ` prompt. A span inside a sentence names a command; it does not restate one.
 */
export function commandTexts(line: string, inFence: boolean): string[] {
  if (inFence) return [line.replace(/(^|\s)#.*$/, "")];
  const spans: string[] = [];
  const rx = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(line)) !== null) {
    const text = m[1] ?? "";
    if (SPAN_OPENS_COMMAND.test(line.slice(0, m.index)) || /^\s*\$\s+/.test(text)) spans.push(text.replace(/^\s*\$\s+/, ""));
  }
  return spans;
}

/** A markdown table header naming things that are no longer in use. */
const RETIRED_TABLE_HEADER = /\b(?:retired|replaced|deprecated|removed)\b/i;

/** make invocations in a command text: `[dir-or-null, target]` pairs. */
function makeInvocations(text: string): Array<{ dir: string | null; target: string }> {
  const out: Array<{ dir: string | null; target: string }> = [];
  for (const seg of text.split(/&&|\|\||;|\|/)) {
    const words = seg.trim().replace(/^\$\s+/, "").split(/\s+/).filter((w) => w.length > 0);
    let i = 0;
    while (i < words.length && (words[i] === "sudo" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? ""))) i++;
    if (words[i] !== "make") continue;
    i++;
    let dir: string | null = null;
    for (; i < words.length; i++) {
      const w = words[i] ?? "";
      if (w === "-C" || w === "--directory") { dir = words[++i] ?? null; continue; }
      if (w.startsWith("-C") && w.length > 2) { dir = w.slice(2); continue; }
      if (w === "-f" || w === "--file") { i++; continue; }
      if (w.startsWith("-")) continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || w === "\\") continue;
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.%-]*$/.test(w)) break;
      out.push({ dir, target: w });
    }
  }
  return out;
}

/**
 * True when the assignment starting at `start` (value ending at `valueFrom`'s
 * token) prefixes a single command that is not a launch command, e.g.
 * `DRY_RUN=1 apply-inventory` or `VESSEL_URL=… bun test`: that sets the variable
 * for one tool, not for the fleet. A prefix on `make`, compose or `docker run`
 * is kept, since those pass the environment on to the fleet.
 */
function isPrefixForOtherCommand(line: string, start: number, valueFrom: number): boolean {
  const before = line.slice(0, Math.max(0, start)).replace(/\s+$/, "");
  const atSegmentStart =
    before === "" || /(?:^|\s)(?:env|\$|sudo)$/.test(before) || /(?:&&|\|\||;|\||\(|`)$/.test(before) ||
    /(?:^|\s)[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(before);
  if (!atSegmentStart) return false;
  let rest = line.slice(valueFrom);
  const quoted = rest.match(/^(["'])[^"']*\1/);
  rest = quoted ? rest.slice(quoted[0].length) : rest.replace(/^[^\s`]*/, "");
  rest = rest.replace(/^(?:\s+[A-Za-z_][A-Za-z0-9_]*=[^\s`]*)+/, "");
  if (!/^\s+[A-Za-z0-9_./~-]/.test(rest)) return false;
  return !/^\s*(?:make\b|(?:docker|podman)(?:[ -]compose\b|\s+run\b))/.test(rest);
}

export interface InstallTruth {
  /** Names gen-env.sh reads or emits; null when gen-env.sh could not be read. */
  genEnv: Set<string> | null;
  /**
   * Names a vessel's own configuration entry (src/config.ts, src/index.ts,
   * src/config/*.ts) reads from its environment; null when no vessel source was
   * readable. A doc setting one of these (a vessel's deployment env block, its
   * dev-run command) describes that vessel, not the fleet's install inputs.
   */
  vesselEnv: Set<string> | null;
  /** Targets of the Makefile in a repo-relative dir (null = the default Makefile); null when unreadable. */
  makeTargets: (dir: string | null) => Set<string> | null;
}

/** Environment names read in a source file: process.env.X, process.env["X"], Bun.env.X, env("X", …). */
export function sourceEnvReads(source: string): Set<string> {
  const names = new Set<string>();
  const rx = /(?:process|Bun)\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*["'`]([A-Z][A-Z0-9_]*)["'`]\s*\])|\benv\(\s*["'`]([A-Z][A-Z0-9_]*)["'`]/g;
  for (const m of source.matchAll(rx)) {
    const n = m[1] ?? m[2] ?? m[3];
    if (n) names.add(n);
  }
  return names;
}

// Where vessel sources may be found: the super-repo's submodules when checked out,
// else the in-container push clones, else the live runtime tree.
function defaultVesselSourceRoots(root: string): string[] {
  return [
    join(root, "repos"),
    process.env["MITOSIS_PUSH_CLONE_DIR"] ?? "/workspace/git/vessels",
    process.env["MITOSIS_RUNTIME_DIR"] ?? "/vessels",
  ];
}

function vesselConfigReads(roots: string[]): Set<string> | null {
  for (const r of roots) {
    let vessels: string[];
    try {
      vessels = readdirSync(r, { withFileTypes: true }).filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name)).map((e) => e.name);
    } catch {
      continue;
    }
    const names = new Set<string>();
    let read = 0;
    for (const v of vessels) {
      const src = join(r, v, "src");
      const files = ["config.ts", "index.ts"].map((f) => join(src, f));
      try {
        for (const e of readdirSync(join(src, "config"), { withFileTypes: true })) {
          if (e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) files.push(join(src, "config", e.name));
        }
      } catch { /* no src/config directory */ }
      for (const f of files) {
        try {
          for (const n of sourceEnvReads(readFileSync(f, "utf8"))) names.add(n);
          read++;
        } catch { /* absent */ }
      }
    }
    if (read > 0) return names;
  }
  return null;
}

export function loadInstallTruth(root: string, opts?: { vesselSourceRoots?: string[] }): InstallTruth {
  let genEnv: Set<string> | null = null;
  try {
    genEnv = genEnvNames(readFileSync(join(root, "scripts/substrate/gen-env.sh"), "utf8"));
  } catch {
    genEnv = null;
  }
  const cache = new Map<string, Set<string> | null>();
  const makeTargets = (dir: string | null): Set<string> | null => {
    // A bare `make` in these docs means the substrate Makefile unless the repo
    // root has one of its own.
    const rel = (dir ?? "").replace(/^(?:\.\.?\/)+/, "").replace(/\/+$/, "");
    const candidates = dir === null ? ["Makefile", "scripts/substrate/Makefile"] : [join(rel, "Makefile")];
    const key = candidates.join("|");
    if (cache.has(key)) return cache.get(key) ?? null;
    let found: Set<string> | null = null;
    for (const c of candidates) {
      try { found = makefileTargets(readFileSync(join(root, c), "utf8")); break; } catch { /* next */ }
    }
    cache.set(key, found);
    return found;
  };
  const vesselEnv = vesselConfigReads(opts?.vesselSourceRoots ?? defaultVesselSourceRoots(root));
  return { genEnv, vesselEnv, makeTargets };
}

export function checkInstallSurface(
  documents: Doc[],
  truth: InstallTruth,
): { findings: DocsAlignFinding[]; skipped: string[] } {
  const findings: DocsAlignFinding[] = [];
  const skipped = new Set<string>();
  if (!truth.genEnv) skipped.add("env_var_unread: scripts/substrate/gen-env.sh unreadable");
  // Without the vessels' own names every vessel deployment env block reads as drift;
  // a check that would file gaps against correct docs is skipped, and said so.
  else if (!truth.vesselEnv) skipped.add("env_var_unread: no vessel source readable to tell a vessel's own settings from install inputs");
  const envCheck = !!truth.genEnv && !!truth.vesselEnv;
  const assignRx = new RegExp(`(?:^|[\\s\`(])(${ENV_NAME})=(?!\\$\\(|\`)`, "g");

  for (const doc of documents) {
    const lines = doc.body.split(/\r?\n/);
    const install = installationLines(doc);
    const seenEnv = new Set<string>();
    const seenMake = new Set<string>();
    // A name the doc later expands as `$NAME` / `${NAME}` (no default) is a shell
    // variable of the example script, not a fleet setting.
    const shellLocals = new Set<string>();
    for (const r of doc.body.matchAll(new RegExp(`\\$(?:(${ENV_NAME})\\b|\\{(${ENV_NAME})\\})`, "g"))) {
      const n = r[1] ?? r[2];
      if (n) shellLocals.add(n);
    }
    let fence = false;
    // Inside a table whose header names retired things: its rows are a record, not commands.
    let retiredTable = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
      if (!fence) {
        const isRow = /^\s*\|/.test(line);
        if (!isRow) retiredTable = false;
        else if (/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] ?? "") && /-/.test(lines[i + 1] ?? "")) {
          retiredTable = RETIRED_TABLE_HEADER.test(line);
        }
        if (retiredTable) continue;
      }

      const commands = commandTexts(line, fence || !!doc.commandContext);
      if (!install.has(i)) {
        const hit = LAUNCH_PATTERNS.find((p) =>
          p.commandOnly ? commands.some((t) => p.rx.test(t)) : p.rx.test(line));
        if (hit) {
          findings.push({
            doc_id: doc.id,
            source: doc.source,
            invariant: "install_single_source",
            evidence: line.trim().slice(0, 300),
            suggested_repair:
              `launch command (${hit.name}) restated outside README § Installation; ` +
              "replace it with a link to README § Installation",
          });
        }
      }

      // Only a line inside a fence SETS a variable; a backticked `X=1` in prose names one
      // (often a tool's or a hook's own switch), and flagging that would file gaps
      // against correct docs.
      if (envCheck && fence) {
        assignRx.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = assignRx.exec(line)) !== null) {
          const name = m[1] ?? "";
          if (!name || truth.genEnv!.has(name) || truth.vesselEnv!.has(name) || seenEnv.has(name)) continue;
          if (shellLocals.has(name)) continue;
          if (isPrefixForOtherCommand(line, m.index + m[0].length - name.length - 1, assignRx.lastIndex)) continue;
          seenEnv.add(name);
          findings.push({
            doc_id: doc.id,
            source: doc.source,
            invariant: "env_var_unread",
            evidence: line.trim().slice(0, 300),
            suggested_repair:
              `${name} is neither read nor emitted by scripts/substrate/gen-env.sh, so setting it has no effect; ` +
              "use the name gen-env.sh reads, or remove it",
          });
        }
      }

      for (const text of commands) {
        for (const inv of makeInvocations(text)) {
          const targets = truth.makeTargets(inv.dir);
          if (!targets) { skipped.add(`make_target_missing: no readable Makefile for ${inv.dir ?? "bare make"}`); continue; }
          if (targetDefined(inv.target, targets)) continue;
          const key = `${inv.dir ?? ""}:${inv.target}`;
          if (seenMake.has(key)) continue;
          seenMake.add(key);
          findings.push({
            doc_id: doc.id,
            source: doc.source,
            invariant: "make_target_missing",
            evidence: line.trim().slice(0, 300),
            suggested_repair:
              `make target "${inv.target}" is not defined in ${inv.dir ? `${inv.dir}/Makefile` : "the Makefile"}; update the doc`,
          });
        }
      }
    }
  }
  return { findings, skipped: [...skipped] };
}

/**
 * Documents only the install-surface checks read: every `.claude/skills/<skill>/SKILL.md`,
 * and the leading comment block of docker-compose.yml (its `# ` prefixes removed,
 * read as command text since a comment header writes commands bare).
 */
export function installSurfaceExtras(root: string): Doc[] {
  const extras: Doc[] = [];
  const skillsDir = join(root, ".claude", "skills");
  let skills: string[] = [];
  try {
    skills = readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    skills = [];
  }
  for (const name of skills) {
    const rel = `.claude/skills/${name}/SKILL.md`;
    try {
      const full = join(root, rel);
      if (statSync(full).size > 200000) continue;
      extras.push({ id: rel, source: rel, body: readFileSync(full, "utf8") });
    } catch {
      // a skill directory without a SKILL.md
    }
  }
  try {
    const compose = readFileSync(join(root, "docker-compose.yml"), "utf8").split(/\r?\n/);
    const header: string[] = [];
    for (const line of compose) {
      if (!/^\s*#/.test(line)) break;
      header.push(line.replace(/^\s*#\s?/, ""));
    }
    if (header.length > 0) {
      extras.push({ id: "docker-compose.yml#header", source: "docker-compose.yml", body: header.join("\n"), commandContext: true });
    }
  } catch {
    // no compose file at this root
  }
  return extras;
}

function isDocsAlignFinding(v: unknown): v is DocsAlignFinding {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["doc_id"] === "string" &&
    typeof r["invariant"] === "string" &&
    typeof r["evidence"] === "string" &&
    typeof r["suggested_repair"] === "string"
  );
}

export async function resolveDocsAlignTick(
  pointer: DocsAlignTickPointer,
): Promise<ResolverResult> {
  // 1. Enumerate human-facing docs
  const documents: Array<{ id: string; source: string; body: string }> = [];

  for (const name of ["CLAUDE.md", "README.md"]) {
    try {
      const full = join(DOC_ROOT, name);
      const st = statSync(full);
      if (st.size <= 200000) {
        const body = readFileSync(full, "utf8");
        documents.push({ id: name, source: name, body });
      }
    } catch {
      // file absent or unreadable — skip
    }
  }

  const docsDir = join(DOC_ROOT, "docs");
  const mdFiles = walkMd(docsDir, 80 - documents.length);
  documents.push(...mdFiles);

  // 2. Assemble live_truth from local filesystem only
  const scriptsDir = join(DOC_ROOT, "scripts");
  const existing_paths = walkScripts(scriptsDir, 2000);

  let unit_names: string[] = [];
  try {
    const unitsDir = join(DOC_ROOT, "scripts/substrate/units");
    unit_names = readdirSync(unitsDir).filter((e) => e.endsWith(".service"));
  } catch {
    unit_names = [];
  }

  // 3. Run docs_align_scan
  const vocabulary = await deriveNamingVocabulary(documents);
  let advertised_shapes: string[] = [];
  try {
    const base = (process.env["DISCOVERY_ENDPOINT"] ?? "http://127.0.0.1:8100").replace(/\/+$/, "");
    const res = await fetch(`${base}/registry/shapes`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const j = (await res.json()) as unknown;
      const arr = Array.isArray(j)
        ? j
        : Array.isArray((j as { shapes?: unknown })?.shapes)
          ? (j as { shapes: unknown[] }).shapes
          : [];
      advertised_shapes = arr.filter((s): s is string => typeof s === "string");
    }
  } catch {
    advertised_shapes = [];
  }
  const scan = await resolveDocsAlignScan({
    type: "docs_align_scan",
    corpus: { documents },
    live_truth: { existing_paths, unit_names, advertised_shapes },
    invariants: ["timelessness", "naming_alignment", "setup_enablement", "accuracy"],
    vocabulary,
    max_findings: 100,
  });

  // 4. Narrow scan body findings to a typed array
  const rawScanBody = scan.body as Record<string, unknown>;
  const rawFindings = rawScanBody["findings"];
  const findingsArray: DocsAlignFinding[] = Array.isArray(rawFindings)
    ? rawFindings.filter(isDocsAlignFinding)
    : [];

  // 4b. Install-surface checks against the files the claims are about. Their corpus
  // is wider than the other invariants': the skills an agent follows and the compose
  // file's own header are where a launch sequence is most often restated.
  const install = checkInstallSurface([...documents, ...installSurfaceExtras(DOC_ROOT)], loadInstallTruth(DOC_ROOT));
  findingsArray.push(...install.findings);
  for (const why of install.skipped) console.error(`[docs-align-tick] check skipped: ${why}`);
  const byInvariant: Record<string, number> = {};
  for (const f of findingsArray) byInvariant[f.invariant] = (byInvariant[f.invariant] ?? 0) + 1;

  // 5. Run docs_align_bridge
  const fixLimit = typeof pointer.max_fixes === "number" ? pointer.max_fixes : findingsArray.length;
  const bridge = await resolveDocsAlignBridge({
    type: "docs_align_bridge",
    report: { findings: findingsArray.slice(0, fixLimit) },
    dry_run: pointer.dry_run,
  });

  // 6. Return summary
  const rawBridgeBody = bridge.body as Record<string, unknown>;
  return {
    shape: "docsAlignTickReport",
    body: {
      docs_scanned: documents.length,
      findings: findingsArray.length,
      gaps_emitted:
        typeof rawBridgeBody["gaps_emitted"] === "number"
          ? rawBridgeBody["gaps_emitted"]
          : 0,
      sources: Array.isArray(rawBridgeBody["sources"])
        ? (rawBridgeBody["sources"] as string[])
        : [],
      dry_run: pointer.dry_run ?? false,
      by_invariant: byInvariant,
      // A check that could not run is reported, never read as a pass.
      checks_skipped: install.skipped,
    },
  };
}