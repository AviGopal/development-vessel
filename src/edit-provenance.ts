/**
 * Is a re-derived edit anchored where it claims, and does its replacement belong
 * to the module it is being written into?
 *
 * THE OBSERVED CASE (2026-08-11, on the compose host itself). A symptom-only goal
 * localised correctly and planned a correct, unique anchor in
 * `compose-slots.ts`. The planned `old_string` did not match the live bytes
 * exactly, so feature-compose fell into its LLM re-derivation path
 * (`feature-compose.ts`, "Re-derive on missing OR non-unique"). That path accepts
 * a candidate on ONE test — `occurs(liveContent, cand) === 1`. The model returned
 * the doc-comment line
 *
 *     * never "the fleet is wedged".
 *
 * which is genuinely unique in the file, paired with a `new_string` of
 *
 *     if (this.childProcess?.exitCode !== null) {
 *
 * referencing `this.childProcess` — a field that does not exist in that module,
 * which is not even a class. The edit applied. It PARSED, because the text landed
 * inside a block comment, so no unit crashed, no restart counter moved, `/health`
 * stayed 200, and none of the four drafter-corruption signatures fired
 * (`byte_zero_injection` looks at line 1; `catastrophic_truncation` needs a
 * shrink; `unparseable_typescript` cannot fire on valid TypeScript). An operator
 * hand-diffing the live tree against its clone was the only thing that saw it.
 *
 * UNIQUENESS IS NOT LOCATION AND NOT PLAUSIBILITY. A uniqueness test answers "can
 * this anchor bind unambiguously", which is necessary and nowhere near sufficient:
 * every comment line in a well-commented file is unique. Two cheap deterministic
 * questions close the gap, and both are answerable without an LLM:
 *
 *   1. PROVENANCE — did the anchor come from the window the model was shown? The
 *      re-derivation prompt already instructs "a verbatim substring copied EXACTLY
 *      from the window above". Enforcing that instruction is free; trusting it is
 *      what failed.
 *   2. IDENTIFIER GROUNDING — does the replacement introduce a member access or
 *      identifier that appears nowhere in the target module and is not imported by
 *      it? `this.childProcess` in a module with no `class` is decisive.
 *
 * BOTH FAIL OPEN. These gates can only REFUSE a re-derived anchor, never write
 * one, and a check that cannot run must not block a good compose — the cost of
 * admitting one bad edit is a revert, the cost of refusing every edit is a
 * substrate that cannot develop itself. Every helper here returns "allow" when it
 * cannot decide.
 */

/** A refusal, or null when the edit is acceptable. */
export interface EditRefusal {
  readonly kind: "anchor_not_from_window" | "replacement_introduces_unknown_symbol";
  readonly detail: string;
}

/**
 * Did the re-derived anchor actually come from the window the model was shown?
 *
 * Whitespace is normalised before comparison because models reflow indentation
 * freely and an indentation-only difference is not a provenance failure — the
 * anchor still has to match the LIVE file exactly for the edit to bind, and that
 * is checked separately by the caller.
 *
 * Returns true (allow) when the window is empty/unavailable: no window means no
 * evidence either way, and this gate must not invent a refusal from ignorance.
 */
export function anchorCameFromWindow(candidate: string, window: string): boolean {
  if (!candidate || !window) return true; // cannot decide -> allow
  if (window.includes(candidate)) return true;
  const squash = (s: string) => s.replace(/\s+/g, " ").trim();
  const c = squash(candidate);
  if (!c) return true;
  return squash(window).includes(c);
}

/** Identifiers that are always in scope and never evidence of a hallucination. */
const AMBIENT = new Set([
  "this", "console", "process", "Math", "JSON", "Object", "Array", "String",
  "Number", "Boolean", "Date", "Promise", "Error", "Set", "Map", "RegExp",
  "Symbol", "BigInt", "globalThis", "undefined", "null", "true", "false",
  "require", "module", "exports", "window", "document", "Buffer", "URL",
]);

/**
 * Member accesses (`a.b`) introduced by the replacement that do not occur anywhere
 * in the module and are not plausibly ambient.
 *
 * Deliberately narrow — member access, not bare identifiers. A bare identifier can
 * be a fresh local variable the edit legitimately introduces, so flagging those
 * would refuse ordinary correct work. A member access on a receiver that the
 * module never mentions is a much stronger signal: the drafter is reaching for a
 * shape this file does not have. That is exactly the observed failure
 * (`this.childProcess` in a module containing no class).
 */
export function unknownMemberAccesses(replacement: string, moduleText: string): string[] {
  if (!replacement || !moduleText) return []; // cannot decide -> allow
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of replacement.matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) {
    const whole = `${m[1]}.${m[2]}`;
    if (seen.has(whole)) continue;
    seen.add(whole);
    // Already present in the module in some form? Then it is grounded.
    if (moduleText.includes(whole)) continue;
    const receiver = m[1]!;
    const prop = m[2]!;
    // `this.x` is grounded only if the module ever mentions `x` — a class field,
    // a constructor assignment, an interface member. A module with no `class` at
    // all cannot legitimately grow a `this.<prop>` reference.
    if (receiver === "this") {
      if (!/\bclass\b/.test(moduleText)) { out.push(whole); continue; }
      if (!new RegExp(`\\b${prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(moduleText)) out.push(whole);
      continue;
    }
    if (AMBIENT.has(receiver)) continue;
    // An unknown receiver the module never names at all.
    if (!new RegExp(`\\b${receiver.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(moduleText)) out.push(whole);
  }
  return out;
}

/**
 * Should this re-derived edit be refused?
 *
 * `window` is the text the model was shown when asked to re-derive; `moduleText`
 * is the live content of the file being edited. Returns null to allow.
 */
export function refuseRederivedEdit(args: {
  readonly candidateAnchor: string;
  readonly replacement: string;
  readonly window: string;
  readonly moduleText: string;
}): EditRefusal | null {
  const { candidateAnchor, replacement, window, moduleText } = args;
  if (!anchorCameFromWindow(candidateAnchor, window)) {
    return {
      kind: "anchor_not_from_window",
      detail: `re-derived anchor is not a substring of the window the model was shown — ${JSON.stringify(candidateAnchor.slice(0, 120))}`,
    };
  }
  const unknown = unknownMemberAccesses(replacement, moduleText);
  if (unknown.length > 0) {
    return {
      kind: "replacement_introduces_unknown_symbol",
      detail: `replacement references ${unknown.map((u) => `\`${u}\``).join(", ")}, absent from the target module`,
    };
  }
  return null;
}
