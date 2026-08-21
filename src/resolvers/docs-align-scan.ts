// docs_align_scan v1: scans a provided in-memory corpus (no filesystem access) for
// four invariant violations — timelessness, naming_alignment, accuracy, setup_enablement.
import type { ResolverResult } from "./types.js";

export interface DocsAlignCorpusDocument {
  id: string;
  title?: string;
  body: string;
  source?: string;
  durability?: "durable" | "dated";
}

export interface DocsAlignVocabulary {
  deprecated: Array<{ pattern: string; canonical: string; path_only?: boolean }>;
  retained: string[];
}

export interface DocsAlignLiveTruth {
  advertised_shapes?: string[];
  vessel_endpoints?: Record<string, string>;
  unit_names?: string[];
  existing_paths?: string[];
}

export interface DocsAlignFinding {
  doc_id: string;
  invariant: string;
  evidence: string;
  suggested_repair: string;
  source?: string;
  note?: string;
}

function coerceObject<T>(input: unknown): T | undefined {
  if (typeof input === 'string') {
    if (input.includes('{{')) return undefined;
    try { return JSON.parse(input) as T; } catch { return undefined; }
  }
  if (input !== null && typeof input === 'object') return input as T;
  return undefined;
}

export interface DocsAlignScanPointer {
  type: "docs_align_scan";
  max_findings?: number;
  corpus?: { documents: DocsAlignCorpusDocument[] | string } | string;
  invariants?: string[];
  live_truth?: DocsAlignLiveTruth | string;
  vocabulary?: DocsAlignVocabulary | string;
}

async function fetchCanonicalVocabulary(): Promise<DocsAlignVocabulary | null> {
  try {
    const SELF_ENDPOINT = process.env["SELF_ENDPOINT"] ?? "http://127.0.0.1:8090";
    const response = await fetch(`${SELF_ENDPOINT}/v2/impulses/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ impulse: { type: "memoryNote", id: "canonical-naming-vocabulary" } }),
    });
    if (!response.ok) return null;
    const parsed: unknown = await response.json();
    const body = (parsed as { body?: unknown })?.body;
    const noteBody = typeof body === "string"
      ? body
      : typeof (body as { body?: unknown })?.body === "string"
        ? String((body as { body?: unknown }).body)
        : JSON.stringify(body ?? "");
    const deprecated: Array<{ pattern: string; canonical: string }> = [];
    if (/metabob-activity-api/.test(noteBody)) {
      deprecated.push({ pattern: "metabob-activity-api", canonical: "activity-api", path_only: true } as { pattern: string; canonical: string; path_only?: boolean });
    }
    if (/metabob-analysis-api/.test(noteBody)) {
      deprecated.push({ pattern: "metabob-analysis-api", canonical: "analysis-api", path_only: true } as { pattern: string; canonical: string; path_only?: boolean });
    }
    return { deprecated, retained: [] };
  } catch {
    return null;
  }
}

function coerceCorpus(input: unknown): { documents: DocsAlignCorpusDocument[]; corpus_parse_failed?: true } {
  if (input == null) return { documents: [] };
  if (typeof input === 'object' && !Array.isArray(input)) {
    const obj = input as { documents?: unknown };
    if (typeof obj.documents === 'string') {
      try {
        const parsed = JSON.parse(obj.documents);
        if (Array.isArray(parsed)) return { documents: parsed as DocsAlignCorpusDocument[] };
        return { documents: [] };
      } catch {
        return { documents: [], corpus_parse_failed: true };
      }
    }
    return { documents: Array.isArray(obj.documents) ? (obj.documents as DocsAlignCorpusDocument[]) : [] };
  }
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed)) return { documents: parsed as DocsAlignCorpusDocument[] };
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { documents?: unknown }).documents)) {
        return { documents: (parsed as { documents: DocsAlignCorpusDocument[] }).documents };
      }
      return { documents: [] };
    } catch {
      return { documents: [], corpus_parse_failed: true };
    }
  }
  return { documents: [] };
}

export async function resolveDocsAlignScan(pointer: DocsAlignScanPointer): Promise<ResolverResult> {
  const maxFindings = typeof pointer.max_findings === "number" ? pointer.max_findings : 20;
  const { documents, corpus_parse_failed: _corpusParseFlag } = coerceCorpus(pointer.corpus);
  const findings: DocsAlignFinding[] = [];
  let truncated = false;

  const invariants = new Set(pointer.invariants ?? [
    "timelessness",
    "naming_alignment",
    "accuracy",
    "setup_enablement",
    "shape_existence",
  ]);

  function coerceObject<T>(val: unknown): T | undefined {
    if (val == null) return undefined;
    if (typeof val === 'object' && !Array.isArray(val)) return val as T;
    if (typeof val === 'string') {
      try { const p = JSON.parse(val); if (p && typeof p === 'object' && !Array.isArray(p)) return p as T; } catch { /* ignore */ }
    }
    return undefined;
  }
  const liveTruth = coerceObject<DocsAlignLiveTruth>(pointer.live_truth);
  const vocabPointer = coerceObject<DocsAlignVocabulary>(pointer.vocabulary);
  const live_truth = liveTruth;
  let vocabulary = vocabPointer;
  if (!vocabulary && (invariants.has("naming_alignment") || invariants.has("shape_existence"))) {
    const fetched = await fetchCanonicalVocabulary();
    if (fetched) vocabulary = fetched;
  }

  const pushFinding = (finding: DocsAlignFinding): boolean => {
    if (findings.length >= maxFindings) {
      truncated = true;
      return false;
    }
    findings.push(finding);
    return true;
  };

  const datedRegexes: RegExp[] = [
    /\bas of 20\d\d-\d\d(-\d\d)?\b/i,
    /\(20\d\d-\d\d-\d\d\)/,
  ];
  const datePattern = new RegExp(datedRegexes.map((r) => r.source).join("|"), "i");
  const substrateLive = "substrate-live";

  outer: for (const doc of documents) {
    if (doc.durability === "dated") continue;
    const lines = doc.body.split(/\r?\n/);

    if (invariants.has("timelessness")) {
      let inChangelogSection = false;
      for (const line of lines) {
        const isHeading = /^#{1,6}\s/.test(line);
          const isBoldLead = /^\s*\*\*/.test(line);
          const mentionsChangelog = /recent stabilisation|changelog|version history/i.test(line);
          if (isHeading) { inChangelogSection = mentionsChangelog; }
          else if (isBoldLead && mentionsChangelog) { inChangelogSection = true; }
        if (inChangelogSection) continue;
        const isDeprecationMarker = /DEPRECATED\s*\(20\d\d/.test(line) || /\*\*DEPRECATED\b/.test(line);
        // `substrate-live` is the DEFAULT CONTAINER NAME, not an instance name.
        // Law 9 bars dated status and instance names from operator docs — but a
        // reader has to type this one, and every documented command contains it
        // (`docker exec substrate-live ...`, `make up LIVE_NAME=...`). Matching
        // the bare string flagged 36 of 40 findings on this repo's own docs:
        // the checker was reporting the setup instructions for being usable.
        //
        // What law 9 actually forbids is naming a PARTICULAR deployment. Flag it
        // in prose, where it may be describing one specific box, and not inside
        // a command, where it is the documented default the reader must supply.
        // `#` covers a shell COMMENT inside a code block — the annotation on a
        // command is as much a part of the command as the command itself
        // ("# docker stop -t 300 substrate-live   # equivalent"), and a trailing
        // comment after a command counts too.
        const isCommandLine = /^\s*(?:\$\s+)?(?:docker|make|until|curl|bun|sudo|systemctl|for)\b/.test(line)
          || /^\s*#/.test(line)
          || /\s#\s/.test(line)
          || /^\s*(?:```|\||>)/.test(line)
          || /`[^`]*substrate-live[^`]*`/.test(line);
        const namesAnInstance = line.includes(substrateLive) && !isCommandLine;
        const hit = (!isDeprecationMarker && (datePattern.test(line) || namesAnInstance));
        if (hit) {
          if (!pushFinding({
            doc_id: doc.id,
            invariant: "timelessness",
            evidence: line,
            suggested_repair: "remove dated status marker or move content to a dated note",
          })) break outer;
        }
      }
    }

    if (invariants.has("naming_alignment") && vocabulary) {
      if (vocabulary) {
        for (const entry of vocabulary.deprecated ?? []) {
          const pat = entry.pattern ?? '';
          const canon = entry.canonical ?? '';
          const pathOnly = entry.path_only ?? false;
          if (!pat) continue;
          const rx = new RegExp(pat, "g");
          for (const line of lines) {
            rx.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = rx.exec(line)) !== null) {
              const idx = match.index;
              const inRetained = vocabulary.retained.some((tok) => {
                const tokIdx = line.indexOf(tok);
                return tokIdx >= 0 && idx >= tokIdx && idx < tokIdx + tok.length;
              });
              if (inRetained) continue;
              if (pathOnly && !(idx > 0 && /[\\/]/.test(line[idx - 1] ?? ''))) continue;
              if (!pushFinding({
                doc_id: doc.id,
                invariant: "naming_alignment",
                evidence: line,
                suggested_repair: `replace "${pat}" with "${canon}"`,
              })) break outer;
              break;
            }
          }
        }
      }
    }

    if (invariants.has("accuracy") && pointer.live_truth && typeof pointer.live_truth !== "string" && pointer.live_truth.advertised_shapes) {
      const advertised = new Set(pointer.live_truth.advertised_shapes);
      const shapeContext = /\b(shape|resolver)\b/i;
      for (const line of lines) {
        if (!shapeContext.test(line)) continue;
        const tickRx = /`([A-Za-z][A-Za-z0-9_]*)`/g;
        let m: RegExpExecArray | null;
        while ((m = tickRx.exec(line)) !== null) {
          const token = m[1];
          if (!token) continue;
          if (!/^[a-z][a-zA-Z0-9_]*$/.test(token)) continue;
          if (advertised.has(token)) continue;
          if (!/(?:shapes?\s+`[^`]+`|`[^`]+`\s+(?:\w+\s+)*shape)/.test(line)) continue;
          if (!pushFinding({
            doc_id: doc.id,
            invariant: "accuracy",
            evidence: line,
            suggested_repair: `shape "${token}" is not advertised by any vessel; verify or remove`,
          })) break outer;
        }
      }
    }

    if (invariants.has("shape_existence") && vocabulary) {
      const vocab = vocabulary;
      const vocabTokens = new Set<string>(vocab.retained);
      for (const entry of vocab.deprecated) {
        vocabTokens.add(entry.canonical);
      }
      const shapeMarkerRx = /shape|type:|output_shapes|input_shapes/;
      const shapeTokenRx = /^[a-z][a-z0-9_]*(:[a-z0-9_]+)?$/;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (typeof line !== "string") continue;
        if (!shapeMarkerRx.test(line)) continue;
        const tickRx = /`([^`]+)`/g;
        let sm: RegExpExecArray | null;
        while ((sm = tickRx.exec(line)) !== null) {
          const token = sm[1];
          if (!token) continue;
          if (!shapeTokenRx.test(token)) continue;
          if (vocabTokens.has(token)) continue;
          if (!pushFinding({
            doc_id: doc.id,
            invariant: "shape_existence",
            evidence: `${doc.id}:${i + 1}: unknown shape token "${token}"`,
            suggested_repair: `shape token "${token}" is not present in the canonical vocabulary; verify or remove`,
          })) break outer;
        }
      }
    }

    if (invariants.has("setup_enablement") && pointer.live_truth && typeof pointer.live_truth !== "string" && pointer.live_truth.existing_paths) {
      const existing = new Set(pointer.live_truth.existing_paths);
      const existingDirs = new Set<string>();
      for (const fp of existing) {
        const parts = fp.split("/");
        for (let i = 1; i < parts.length; i++) {
          existingDirs.add(parts.slice(0, i).join("/"));
        }
      }
      // Anchor at a path boundary, not at the bare word "scripts/".
      // Unanchored, "validation/scripts/failure-mode-harness.ts" captured only
      // "scripts/failure-mode-harness.ts" — a path that legitimately does not
      // exist — and reported the doc as wrong for citing a file that is right
      // there. Same for "docs/scripts/tests/config". A checker that fails on
      // correct docs trains its readers to ignore it, which is worse than no
      // checker: every one of the 4 setup_enablement findings on this repo's
      // own docs was this bug.
      const scriptRx = /(?:^|[\s`'"(])((?:[A-Za-z0-9_.-]+\/)*scripts\/[A-Za-z0-9_./-]+)/g;
      const makeRx = /make\s+-C\s+([A-Za-z0-9_./-]+)/g;
      for (const line of lines) {
        for (const rx of [scriptRx, makeRx]) {
          rx.lastIndex = 0;
          let mm: RegExpExecArray | null;
          while ((mm = rx.exec(line)) !== null) {
            // Trailing slash means "this directory", which is how prose cites a
            // directory ("edit `scripts/substrate/units/`"). Kept verbatim it
            // matches neither the file set nor the derived directory set, so a
            // correct citation was reported missing.
            // Also strip leading "../" and "./": a doc inside docs/ cites a
            // sibling tree as "../scripts/substrate/llm-arms.json", which is
            // correct markdown and never matches a repo-root-relative path set.
            const path = (mm[1] ?? "").replace(/\/+$/, "").replace(/^(?:\.\.?\/)+/, "");
            if (!path) continue;
            if (existing.has(path)) continue;
            if (existingDirs.has(path)) continue;
            if (Array.from(existing).some(f => f.startsWith(path + "/"))) continue;
            if (!pushFinding({
              doc_id: doc.id,
              invariant: "setup_enablement",
              evidence: line,
              suggested_repair: `path "${path}" not in live_truth.existing_paths; update doc or add path`,
            })) break outer;
          }
        }
      }
    }
  }

  const docSourceById = new Map(documents.map((d) => [d.id, d.source] as const));
  return {
    shape: "docsAlignReport",
    body: {
      ...(_corpusParseFlag ? { corpus_parse_failed: true } : {}),
      implemented: true,
      scanned_count: documents.filter((d) => d.durability !== "dated").length,
      findings: findings.map((f) => ({ ...f, source: f.source ?? docSourceById.get(f.doc_id) })),
      truncated,
    },
  };
}
