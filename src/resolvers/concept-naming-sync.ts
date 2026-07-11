import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";

const DOC_ROOT = process.env.DOC_FIX_ROOT ?? "/workspace/git/super-repo";
const CONCEPT_DB = process.env.CONCEPT_DB_ENDPOINT ?? "http://127.0.0.1:8260";

export interface ConceptNamingSyncPointer {
  type: "concept_naming_sync";
  dry_run?: boolean;
}

interface NamingSupersession {
  deprecated: string;
  canonical: string;
  intent: string;
}

const ARROW_RE = /`?([\w@][\w@./-]*)`?\s*(?:\u2192|->)\s*`?([\w@][\w@./-]*)`?/g;

function extractMappings(text: string, sourceLabel: string): NamingSupersession[] {
  const results: NamingSupersession[] = [];
  let m: RegExpExecArray | null;
  ARROW_RE.lastIndex = 0;
  while ((m = ARROW_RE.exec(text)) !== null) {
    const a = (m[1] ?? "").replace(/^repos\//, "");
    const b = (m[2] ?? "").replace(/^repos\//, "");
    if (a.toLowerCase().includes("metabob")) {
      results.push({ deprecated: a, canonical: b, intent: sourceLabel });
    }
  }
  return results;
}

async function findOrCreateNameConcept(name: string, role: string): Promise<string | null> {
  try {
    const searchRes = await fetch(
      `${CONCEPT_DB}/concepts/search?q=${encodeURIComponent(name)}&limit=5`,
    );
    if (searchRes.ok) {
      const data = (await searchRes.json()) as {
        results?: Array<{ shape?: string; content?: string; id?: string }>;
        concepts?: Array<{ shape?: string; content?: string; id?: string }>;
      };
      const items = data.results ?? data.concepts ?? [];
      const existing = items.find((r) => r.shape === "canonical_name" && r.content === name);
      if (existing?.id) return existing.id;
    }
  } catch {
    // fall through to create
  }
  try {
    const createRes = await fetch(`${CONCEPT_DB}/v2/impulses/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        impulse: {
          pointer: {
            type: "concept_create_write",
            conceptData: {
              source_type: "memo",
              shape: "canonical_name",
              content: name,
              summary: `${name} (${role})`,
            },
          },
        },
      }),
    });
    if (!createRes.ok) return null;
    const raw = (await createRes.json()) as { content?: string };
    if (!raw.content) return null;
    let parsed: { id?: string };
    try {
      parsed = JSON.parse(raw.content) as { id?: string };
    } catch {
      return null;
    }
    return parsed.id ?? null;
  } catch {
    return null;
  }
}

async function linkSupersedes(
  fromId: string,
  toId: string,
  canonical: string,
  intent: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${CONCEPT_DB}/v2/impulses/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        impulse: {
          pointer: {
            type: "conceptLink_write",
            linkData: {
              from_concept_id: fromId,
              to_concept_id: toId,
              edge_type: "contradicts",
              description: `superseded_by ${canonical} — per ${intent}`,
            },
          },
        },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function resolveConceptNamingSync(
  pointer: ConceptNamingSyncPointer,
): Promise<ResolverResult> {
  const dry_run = pointer.dry_run ?? false;
  const seen = new Map<string, NamingSupersession>();

  // 1a. openspec proposals
  try {
    const changesDir = join(DOC_ROOT, "openspec", "changes");
    if (existsSync(changesDir)) {
      const entries = readdirSync(changesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === "archive") continue;
        const proposalPath = join(changesDir, entry.name, "proposal.md");
        if (!existsSync(proposalPath)) continue;
        try {
          const text = readFileSync(proposalPath, "utf8");
          for (const mapping of extractMappings(text, entry.name)) {
            const key = `${mapping.deprecated}|${mapping.canonical}`;
            if (!seen.has(key)) seen.set(key, mapping);
          }
        } catch {
          // skip unreadable proposals
        }
      }
    }
  } catch {
    // openspec dir unavailable — best effort
  }

  // 1b. git log
  try {
    const proc = Bun.spawn(["git", "log", "--format=%H%x1f%B%x1e", "-n", "400"], {
      cwd: DOC_ROOT,
      stdout: "pipe",
    });
    const raw = await new Response(proc.stdout).text();
    const records = raw.split("\x1e");
    for (const record of records) {
      const idx = record.indexOf("\x1f");
      if (idx < 0) continue;
      const hash = record.slice(0, idx).trim();
      const body = record.slice(idx + 1).trim();
      if (!hash || !body) continue;
      const shortHash = hash.slice(0, 8);
      for (const mapping of extractMappings(body, `commit ${shortHash}`)) {
        const key = `${mapping.deprecated}|${mapping.canonical}`;
        if (!seen.has(key)) seen.set(key, mapping);
      }
    }
  } catch {
    // git unavailable — best effort
  }

  const mappings = Array.from(seen.values());
  let concepts_ensconced = 0;
  let edges_ensconced = 0;

  if (!dry_run) {
    for (const { deprecated, canonical, intent } of mappings) {
      try {
        const id_dep = await findOrCreateNameConcept(deprecated, "deprecated name");
        const id_can = await findOrCreateNameConcept(canonical, "canonical name");
        if (id_dep && id_can) {
          concepts_ensconced += 2;
          const linked = await linkSupersedes(id_dep, id_can, canonical, intent);
          if (linked) edges_ensconced += 1;
        }
      } catch {
        // best effort per mapping
      }
    }
  }

  return {
    shape: "conceptNamingSyncReport",
    body: {
      mappings_found: mappings.length,
      concepts_ensconced,
      edges_ensconced,
      dry_run,
      mappings,
    },
  };
}
