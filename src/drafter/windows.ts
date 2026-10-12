// THE GROUNDING WINDOWS (open copy of the floor's windowing in feature-compose.ts: focusedSlice, groundingFileBlock,
// the GROUND TRUTH loop of groundVesselFiles, and retry-evidence's lineCenteredSlice). Pure: every byte comes from
// the facts the closed core read. The floor keeps its own copies; a change here changes only what the drafter is
// shown when the closed clamps accept it.
import { renderWindowForDrafter } from "../control-bytes.js";
import type { DrafterFacts } from "./types.js";

/** Total content budget across non-target files (the floor's GROUND_CONTENT_BUDGET). */
export const GROUND_CONTENT_BUDGET = 26_000;
/** One file's window cap (the floor's PER_FILE_SLICE). */
export const PER_FILE_SLICE = 6000;
/** How often a mined probe may appear before it stops being a locator (the floor's PROBE_MAX_OCCURRENCES). */
export const PROBE_MAX_OCCURRENCES = 8;

export type Slice = { slice: string; centered: boolean; head: boolean };

/** A window of at most `window` chars that covers lines start..end (from start when the range is larger). */
export function lineCenteredSlice(content: string, start: number, end: number, window: number): { slice: string; startLine: number } | null {
  const lines = content.split("\n");
  if (start < 1 || start > lines.length) return null;
  const last = Math.min(end, lines.length);
  const offsetOf = (line: number): number => { let o = 0; for (let i = 0; i < line - 1; i++) o += (lines[i] ?? "").length + 1; return o; };
  const a = offsetOf(start), b = offsetOf(last + 1);
  const pad = Math.max(0, Math.floor((window - (b - a)) / 2));
  let from = Math.max(0, a - pad);
  if (b - a >= window) from = a;
  const nl = content.lastIndexOf("\n", from - 1);
  from = from === 0 ? 0 : nl + 1;
  const slice = content.slice(from, from + window);
  return { slice, startLine: content.slice(0, from).split("\n").length };
}

/** The change-site-centred window of one file: an explicit line range, then the primary probes, then the focus hints'
 *  verbatim fragments (longest first), then the rarity-weighted densest cluster of hint tokens, then the head. */
export function focusedSlice(content: string, cap: number, focusHints: readonly string[], primaryProbe: string | readonly string[] = "", lineHint: { start: number; end: number } | null = null): Slice {
  const window = Math.min(content.length, cap, PER_FILE_SLICE);
  if (content.length <= window) return { slice: content, centered: false, head: false };
  if (lineHint) {
    const at = lineCenteredSlice(content, lineHint.start, lineHint.end, window);
    if (at) return { slice: at.slice, centered: true, head: at.startLine === 1 };
  }
  const centerOn = (at: number): Slice => {
    const start = Math.max(0, at - Math.floor(window / 3));
    return { slice: content.slice(start, start + window), centered: true, head: start === 0 };
  };
  for (const probe of (Array.isArray(primaryProbe) ? primaryProbe : [primaryProbe]) as readonly string[]) {
    if (!probe) continue;
    const at = content.indexOf(probe);
    if (at < 0) continue;
    let occurrences = 0;
    for (let k = content.indexOf(probe); k !== -1 && occurrences <= PROBE_MAX_OCCURRENCES; k = content.indexOf(probe, k + 1)) occurrences++;
    if (occurrences > PROBE_MAX_OCCURRENCES) continue;
    return centerOn(at);
  }
  const probes: string[] = [];
  for (const hint of focusHints) {
    for (const m of hint.matchAll(/`([^`\n]{6,200})`/g)) {
      const frag = m[1]!.trim();
      probes.push(frag);
      for (const sub of frag.split(/[,{}]/).map((s) => s.trim())) if (sub.length >= 12) probes.push(sub);
    }
  }
  for (const hint of focusHints) { const p = hint.trim().slice(0, 80); if (p.length >= 12) probes.push(p); }
  probes.sort((a, b) => b.length - a.length);
  for (const probe of probes) {
    const at = content.indexOf(probe);
    if (at >= 0) return centerOn(at);
  }
  const toks = new Set<string>();
  for (const hint of focusHints)
    for (const m of hint.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]{5,})\b/g)) { const t = m[1]!; if (t.length >= 6) toks.add(t); }
  const count = new Map<string, number>();
  const occ: Array<{ at: number; t: string }> = [];
  for (const t of toks) { let from = 0, c = 0; while (c < 80) { const at = content.indexOf(t, from); if (at < 0) break; occ.push({ at, t }); c++; from = at + t.length; } count.set(t, c); }
  if (occ.length > 0) {
    occ.sort((a, b) => a.at - b.at);
    let best = -1, bestW = 0;
    for (let i = 0; i < occ.length; i++) {
      const hi = occ[i]!.at + window; const seen = new Set<string>(); let w = 0;
      for (let j = i; j < occ.length && occ[j]!.at < hi; j++) { const t = occ[j]!.t; if (!seen.has(t)) { seen.add(t); w += 1 / Math.max(1, count.get(t) ?? 1); } }
      if (w > bestW) { bestW = w; best = occ[i]!.at; }
    }
    if (best >= 0) { const start = Math.max(0, best - Math.floor(window / 6)); return { slice: content.slice(start, start + window), centered: true, head: start === 0 }; }
  }
  return { slice: content.slice(0, window), centered: false, head: true };
}

/** One file's block in the grounding window: header, slice (target files line-numbered), truncation marks. */
export function groundingFileBlock(repoPath: string, content: string, sliced: Slice, target: boolean): string {
  const { slice, centered, head } = sliced;
  const truncated = slice.length < content.length
    ? (centered ? "\n… (windowed around the change site; head/tail omitted)" : (head ? "\n… (truncated)" : "\n… (truncated)"))
    : "";
  const lead = centered && !head ? "… (head omitted)\n" : "";
  let shown = slice;
  if (target) {
    const at = content.indexOf(slice);
    const startLine = at >= 0 ? content.slice(0, at).split("\n").length : 1;
    shown = slice.split("\n").map((l, i) => `${startLine + i}\t${l}`).join("\n");
  }
  return `----- ${repoPath} -----\n${lead}${renderWindowForDrafter(`${shown}${truncated}`)}`;
}

/** GROUND TRUTH: per verify vessel (at most six), its file tree and the contents within the budget, target files
 *  first with a full window each. Fills `windows` with the raw slice shown for each target file. */
export function renderGroundTruth(f: DrafterFacts, focusHints: readonly string[], probes: readonly string[], windows: Record<string, string>): string {
  const blocks: string[] = [];
  let contentBudget = GROUND_CONTENT_BUDGET;
  for (const v of f.verifyVessels.slice(0, 6)) {
    const vRel = v.replace(/^repos\//, "");
    const files = f.listing[`repos/${vRel}`];
    if (!files) continue;
    const tree = files.map((fp) => `  repos/${vRel}/${fp}`).join("\n");
    const isTarget = (fp: string): boolean => f.targets.files.includes(`repos/${vRel}/${fp}`);
    const ordered = [...files.filter(isTarget), ...files.filter((fp) => !isTarget(fp))];
    const parts: string[] = [];
    for (const fp of ordered) {
      const target = isTarget(fp);
      if (!target && contentBudget <= 0) break;
      const path = `repos/${vRel}/${fp}`;
      const content = f.contents[path];
      if (typeof content !== "string") continue;
      const effBudget = target ? Math.max(contentBudget, PER_FILE_SLICE) : contentBudget;
      const sliced = focusedSlice(content, effBudget, focusHints, probes, f.lineHint && f.lineHint.file === path ? f.lineHint : null);
      contentBudget -= sliced.slice.length;
      if (target) windows[path] = sliced.slice;
      parts.push(groundingFileBlock(path, content, sliced, target));
    }
    const contentSection = parts.length ? `\n\nCURRENT CONTENTS:\n${parts.join("\n\n")}` : "";
    blocks.push(`repos/${vRel}/ FILES:\n${tree}${contentSection}`);
  }
  return blocks.join("\n\n");
}
