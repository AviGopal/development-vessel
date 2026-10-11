// Shared fixtures for the auto-pick pins (pin-hopeless-floor-pickskip, pin-pick-skeleton). Not a test file.
// An auto-pick tick (no gap_id) over a stored pool: every candidate is armed (class1), names an existing runtime
// site whose literal is still present (so the pick-time check reads 'present'), and was already investigated (so the
// low-confidence investigation route never fires). The tick is a dry run: the picked gap reaches the (stand-in)
// compose and the report names it, and nothing is graded.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seed, readOverlay, overlayHits, tick, RUN, SCRATCH, type Row } from "./harness.js";

const VESSEL = `pinpick-${RUN}`;
export const PICK_LITERAL = `http://pin-pick-literal-${RUN}`;
let n = 0;
/** A site under the runtime tree; `literal` false leaves the file without the literal. */
export function pickSite(literal = true): string {
  const rel = `src/pick-${++n}.ts`;
  mkdirSync(join(SCRATCH, "runtime", VESSEL, "src"), { recursive: true });
  writeFileSync(join(SCRATCH, "runtime", VESSEL, rel), literal ? `export const u = "${PICK_LITERAL}";\n` : "export const u = null;\n");
  return `repos/${VESSEL}/${rel}`;
}
/** A pick candidate. Its class (gapClassOf) is the id's first three hyphen tokens: `<stem>` below, so give each
 *  candidate a distinct stem. */
export function candidate(stem: string, meta: Row = {}, extra: Row = {}): string {
  const id = `${stem}-${RUN}`;
  seed({ id, category: "systematic_failure", ...extra, classification_metadata: { falsifier: "class1", edit_site: pickSite(), hardcoded_url: PICK_LITERAL, investigated_at: "2026-10-01T00:00:00.000Z", ...meta } });
  return id;
}
/** The class posteriors the rerank reads (at whatever load-time path the process uses; matched by basename). A class
 *  given `favour` samples theta ~ 1, `mid` ~ 0.91, `disfavour` ~ 0 (each within ~1e-3, so the three never swap). */
export function classPosteriors(p: Record<string, "favour" | "mid" | "disfavour">): void {
  const out: Record<string, { alpha: number; beta: number }> = {};
  for (const [cls, v] of Object.entries(p)) out[cls] = v === "favour" ? { alpha: 1e6, beta: 1 } : v === "mid" ? { alpha: 1e6, beta: 1e5 } : { alpha: 1, beta: 1e6 };
  readOverlay.set("*/gap-class-posteriors.json", JSON.stringify(out));
}
export const posteriorsWereRead = (): boolean => overlayHits.includes("*/gap-class-posteriors.json");
/** One auto-pick tick (dry run); returns the picked gap id (or null) and the console lines. */
export async function autoPick(): Promise<{ picked: string | null; body: Row; lines: string[] }> {
  const { resolveGapToFeature } = await import("../../src/resolvers/gap-to-feature.js");
  const { result, lines } = await tick(() => resolveGapToFeature({ type: "gap_to_feature", dry_run: true } as never));
  const body = result.body as Row;
  return { picked: typeof body.gap_id === "string" ? body.gap_id : null, body, lines };
}
export const PICK_LOG = /pick-decisions\.jsonl$/;
