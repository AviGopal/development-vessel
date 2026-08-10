/**
 * Does an edit add code that CANNOT do anything?
 *
 * THE OBSERVED CASE. A correctly-routed repair goal — "the handler that writes
 * execution-path records sets no tenant marking, fix it" — was planned against
 * the right file and produced this entire diff:
 *
 *   + const tenant = c.get('tenant');
 *
 * Never referenced. `'tenant'` is not a context key in that codebase. The write
 * statement the goal was about was untouched. And nothing objected: `tsc` sees a
 * valid binding (`noUnusedLocals` is not set), so the mitosis verdict is
 * FAVORABLE and the stage is accepted — which ENDS the attempt. The escalation
 * path that exists for a failed compose (patch_with_tools) never gets a turn,
 * because from the gate's point of view the compose succeeded.
 *
 * So this is not merely an honesty gate. Refusing a vacuous edit converts a
 * silent no-op into a failure the existing recovery machinery can act on.
 *
 * ── DELIBERATELY NARROW ──────────────────────────────────────────────────────
 * Only refuses when EVERY added line is a declaration whose identifier is never
 * used anywhere in the resulting file. That is a statement about the edit's own
 * text, not a judgement about whether it solves the goal — a check that tried to
 * judge responsiveness would refuse correct work it did not understand. An added
 * line that calls anything, assigns anything, or is referenced later all pass.
 */

/** A declaration whose binding is introduced by the added text. */
const DECL = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/;

/** Lines that carry no behaviour and should not count either way. */
function isInert(line: string): boolean {
  const s = line.trim();
  return (
    s === "" ||
    s.startsWith("//") ||
    s.startsWith("/*") ||
    s.startsWith("*") ||
    s === "}" ||
    s === "{"
  );
}

/**
 * @param before file text prior to the edit
 * @param after  file text after the edit
 * @returns a reason when the edit is vacuous, or `null` when it may proceed
 */
export function vacuousEditReason(before: string, after: string): string | null {
  if (typeof before !== "string" || typeof after !== "string") return null;
  if (after === before) return null;

  const beforeLines = new Set(before.split("\n").map((l) => l.trim()));
  const added = after
    .split("\n")
    .filter((l) => !beforeLines.has(l.trim()))
    .filter((l) => !isInert(l));

  // Nothing meaningful added (pure deletion or comment/whitespace churn): not
  // this gate's business. A deletion can be exactly the right repair.
  if (added.length === 0) return null;

  const declaredNames: string[] = [];
  for (const line of added) {
    const m = DECL.exec(line);
    if (!m) return null; // something added that is not a bare declaration → let it through
    declaredNames.push(m[1]!);
  }

  // Every added line is a declaration. Vacuous only if NONE of the bound names
  // is referenced anywhere in the resulting file beyond its own declaration.
  // Count references in CODE ONLY. The observed diff was
  // `const tenant = c.get('tenant')` — the name also appears inside a string
  // literal, so a naive count saw two references and called the binding "used",
  // which is exactly backwards: a key passed as data is not a use of the binding.
  const codeOnly = after
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  const unused = declaredNames.filter((name) => {
    const refs = codeOnly.match(new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`, "g"));
    return (refs?.length ?? 0) <= 1;
  });
  if (unused.length !== declaredNames.length) return null;

  return (
    `vacuous edit: every added line is a declaration whose binding is never used ` +
    `(${unused.join(", ")}). The file compiles and behaves identically, so this ` +
    `cannot be the requested change — refusing so recovery can escalate rather ` +
    `than accepting a no-op as FAVORABLE`
  );
}
