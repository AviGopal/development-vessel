import type { ResolverResult } from "./types.js";

/**
 * markdown_split_sections — deterministic split of a markdown document
 * on H2 (`## `) and H3 (`### `) headings.
 *
 * Motivation: ingest-doc-as-concepts used to pass the entire doc body
 * to an LLM in a single call. For a doc like CLAUDE.md (~211K tokens)
 * this overflows Anthropic's 200K prompt cap. Splitting BEFORE the LLM
 * call lets the template iterate per-section with bounded payloads.
 *
 * Output shape:
 *   {
 *     sections: [
 *       { heading: "Foo", level: 2, heading_slug: "foo", body_excerpt: "..." },
 *       ...
 *     ],
 *     section_count: number,
 *     doc_path: string,
 *     bytes_in: number,
 *   }
 *
 * Each `body_excerpt` is capped at `maxSectionChars` (default 3000 chars)
 * and contains the verbatim section body (the heading line is excluded
 * — the heading is in `heading`). Bodies longer than the cap are
 * truncated and a `…[truncated]` marker is appended so the LLM sees the
 * boundary explicitly.
 *
 * H1 sections, empty bodies, and code-block-only sections are kept (the
 * LLM downstream is responsible for skipping them) — the splitter's only
 * job is to make payloads tractable.
 */

export interface MarkdownSplitSectionsPointer {
  type: "markdown_split_sections";
  /** Either the raw markdown content directly, or a path to read from disk. */
  content?: string;
  doc_path?: string;
  /** Per-section body excerpt cap (chars). Default 3000. */
  maxSectionChars?: number;
  /** Total section cap. Default 60 (covers any reasonable doc). */
  maxSections?: number;
}

const DEFAULT_MAX_SECTION_CHARS = 3000;
const DEFAULT_MAX_SECTIONS = 60;

function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function resolveMarkdownSplitSections(
  pointer: MarkdownSplitSectionsPointer,
): Promise<ResolverResult> {
  const maxSectionChars = pointer.maxSectionChars ?? DEFAULT_MAX_SECTION_CHARS;
  const maxSections = pointer.maxSections ?? DEFAULT_MAX_SECTIONS;

  let content: string;
  if (typeof pointer.content === "string" && pointer.content.length > 0) {
    content = pointer.content;
  } else if (typeof pointer.doc_path === "string" && pointer.doc_path.length > 0) {
    const file = Bun.file(pointer.doc_path);
    const exists = await file.exists();
    if (!exists) {
      return {
        shape: "structuredError",
        body: {
          resolver: "markdown_split_sections",
          detail: `file not found: ${pointer.doc_path}`,
        },
      };
    }
    content = await file.text();
  } else {
    return {
      shape: "structuredError",
      body: {
        resolver: "markdown_split_sections",
        detail: "either content or doc_path must be provided",
      },
    };
  }

  const lines = content.split("\n");
  type Section = {
    heading: string;
    level: number;
    heading_slug: string;
    body_excerpt: string;
  };
  const sections: Section[] = [];
  let currentHeading: string | null = null;
  let currentLevel = 0;
  let currentBody: string[] = [];
  const slugCounts = new Map<string, number>();

  const flush = () => {
    if (currentHeading === null) return;
    let body = currentBody.join("\n").trim();
    if (body.length > maxSectionChars) {
      body = body.slice(0, maxSectionChars) + "\n…[truncated]";
    }
    const baseSlug = slugify(currentHeading) || `section-${sections.length}`;
    const count = slugCounts.get(baseSlug) ?? 0;
    slugCounts.set(baseSlug, count + 1);
    const heading_slug = count === 0 ? baseSlug : `${baseSlug}-${count}`;
    sections.push({
      heading: currentHeading,
      level: currentLevel,
      heading_slug,
      body_excerpt: body,
    });
  };

  for (const line of lines) {
    const h2Match = /^##\s+(.+?)\s*$/.exec(line);
    const h3Match = /^###\s+(.+?)\s*$/.exec(line);
    const match = h2Match ?? h3Match;
    if (match) {
      flush();
      if (sections.length >= maxSections) {
        currentHeading = null;
        currentBody = [];
        break;
      }
      currentHeading = match[1] ?? "";
      currentLevel = h2Match ? 2 : 3;
      currentBody = [];
    } else if (currentHeading !== null) {
      currentBody.push(line);
    }
  }
  if (sections.length < maxSections) {
    flush();
  }

  return {
    shape: "markdownSections",
    body: {
      sections,
      section_count: sections.length,
      doc_path: pointer.doc_path ?? null,
      bytes_in: content.length,
    },
  };
}
