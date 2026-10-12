// THE SUCCESS CRITERION, AS SHOWN TO THE DRAFTER (open copy of the criterion lines feature-compose builds from the
// gap's falsifier fields). Pure. The criterion is RESTATED here; the gates that judge the landing by it are closed,
// and the core refuses a context that drops the literal the floor states (the mandatory-line clamp). In phase 1 the
// decompose prompt itself is built by the closed core from the context's parts.
import type { DrafterFacts } from "./types.js";
import { parentCheckBlock } from "./evidence.js";

/** SUCCESS CRITERION: the gap's machine-checkable falsifier, stated as the plan's goal. */
export function renderSuccessCriterion(f: DrafterFacts): string {
  const m = f.gapMeta;
  const site = String(m["edit_site"] ?? "the target file").replace(/:\d+.*$/, "");
  const lines: string[] = [];
  const literal = m["expected_literal"];
  const heuristic = String(m["predicate_source"] ?? "").startsWith("gap_falsify:");
  if (typeof literal === "string" && literal.trim()) lines.push(heuristic
    ? `- A finished fix will contain \`${literal}\` in ${site}, but that is a NECESSARY condition only, not the goal: the goal is the behaviour the gap describes. Introducing or merely reading it without changing that behaviour is a hollow change and will be refused.`
    : `- After your edit, \`${literal}\` MUST appear in ${site} AND be used on a live code path (declared and read or called). A comment, an unused declaration or a string that merely mentions it does not count.`);
  const removed = m["hardcoded_url"];
  if (typeof removed === "string" && removed.trim()) lines.push(`- After your edit, this text MUST NO LONGER appear in ${site}: ${JSON.stringify(removed).slice(0, 300)}`);
  const resolve = m["evidence_resolve"] as { shape?: unknown; input?: unknown } | undefined;
  if (resolve && typeof resolve === "object" && typeof resolve.shape === "string") lines.push(`- The gap is verified by resolving shape \`${resolve.shape}\` with input ${JSON.stringify(resolve.input ?? {}).slice(0, 300)}: after your change that resolve must no longer report this defect.`);
  const shape = m["verify_shape"];
  if (typeof shape === "string" && shape.trim()) lines.push(`- After your change the shape \`${shape}\` must resolve.`);
  const parent = parentCheckBlock(f.parentCheck);
  if (parent) lines.push(parent);
  return lines.length > 0 ? `\n\nSUCCESS CRITERION (the gap's machine-checkable falsifier; the landing is judged by exactly this):\n${lines.join("\n")}\n` : "";
}
