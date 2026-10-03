/**
 * IS A GAP'S REGION A LITERAL THAT GROUNDING CAN FIND? One rule, shared by the arm-time write gate
 * (substrate-gap.ts) and the read-only census (gap_lifecycle_scan region_lint), so the two cannot drift.
 *
 * Compose grounding (gap-to-feature, "region->line") reads the edit_site file from the runtime tree
 * (MITOSIS_RUNTIME_DIR, default /vessels, with the leading `repos/` stripped), trims
 * classification_metadata.region, and centres the draft on a line that CONTAINS it. A prose region
 * ("deliverable-shapes (~1269-1340)…") occurs nowhere, so grounding falls back to the top of the file and
 * the drafter edits unrelated code. A region occurring twice grounds on whichever occurrence grounding
 * picks (the last), which the author did not choose. So a region is usable only when it occurs EXACTLY ONCE.
 *
 * The file is read where grounding reads it, not where the class-1 literal check reads it
 * (WORKSPACE_ROOT + the path minus `repos/`, which is not a vessel tree in the container). A gate that
 * counts in a different tree than its consumer certifies nothing.
 *
 * FAIL CLOSED. An unreadable edit_site (missing, a `:line` suffix, prose, two paths) is its own verdict,
 * never "0 occurrences, absent": ENOENT read as "absent" is how the class-1 arming guard came to never fire.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type RegionLiteralError = "region_not_literal_once" | "region_spans_lines" | "edit_site_unreadable";

export type RegionLiteralVerdict =
  | { ok: true; occurrences: 1; edit_site: string; region: string }
  | { ok: false; error: RegionLiteralError; occurrences: number | null; edit_site: string; region: string; detail: string };

/** The runtime tree grounding reads. Read at call time; an empty value is unset (same rule as gap-to-feature envPath). */
function groundingRoot(): string {
  const raw = process.env["MITOSIS_RUNTIME_DIR"];
  return raw === undefined || raw.trim() === "" ? "/vessels" : raw;
}

/** The region as grounding uses it: trimmed; empty means no region. */
export function regionOf(meta: Record<string, unknown> | null | undefined): string {
  const r = (meta ?? {})["region"];
  return r === undefined || r === null ? "" : String(r).trim();
}

/** Non-overlapping literal occurrences (indexOf, never a regex). */
export function countLiteral(text: string, literal: string): number {
  if (literal.length === 0) return 0;
  let n = 0;
  for (let i = text.indexOf(literal); i !== -1; i = text.indexOf(literal, i + literal.length)) n++;
  return n;
}

export function regionLiteralVerdict(regionRaw: string, editSiteRaw: string): RegionLiteralVerdict {
  const region = String(regionRaw).trim();
  const edit_site = String(editSiteRaw).trim();
  if (region.includes("\n")) {
    return { ok: false, error: "region_spans_lines", occurrences: null, edit_site, region,
      detail: `region spans lines; grounding matches one line at a time, so it can never find it in ${edit_site}. Use a short literal from ONE line that occurs once in the file, and put any prose in region_prior_text` };
  }
  let text: string;
  try {
    if (!/^repos\/[^/\s]+\/\S+$/.test(edit_site) || edit_site.split("/").includes("..")) throw new Error("not a bare repos/<vessel>/<path>");
    text = readFileSync(join(groundingRoot(), edit_site.replace(/^repos\//, "")), "utf8");
  } catch (err) {
    return { ok: false, error: "edit_site_unreadable", occurrences: null, edit_site, region,
      detail: `edit_site ${JSON.stringify(edit_site)} cannot be read where grounding reads it (${(err as Error).message}); an armed gap's edit_site must be exactly one existing repos/<vessel>/<path> with no :line suffix` };
  }
  const occurrences = countLiteral(text, region);
  if (occurrences === 1) return { ok: true, occurrences: 1, edit_site, region };
  return { ok: false, error: "region_not_literal_once", occurrences, edit_site, region,
    detail: `region ${JSON.stringify(region.slice(0, 120))} occurs ${occurrences} time(s) in ${edit_site}; grounding needs a literal that occurs exactly once, or it centres the draft on ${occurrences === 0 ? "the top of the file" : "an occurrence nobody chose"}. Put any prose in region_prior_text` };
}

/** The falsifier class a row carries, normalised (a bare string or {class}). */
export function falsifierClassOf(meta: Record<string, unknown> | null | undefined): string {
  const f = (meta ?? {})["falsifier"] as unknown;
  return String((f && typeof f === "object" ? (f as { class?: unknown }).class : f) ?? "").toLowerCase();
}
