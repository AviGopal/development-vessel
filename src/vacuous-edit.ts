/**
 * Does an edit add code that CANNOT do anything?
 *
 * THE OBSERVED CASE. A correctly-routed repair goal about a missing tenant
 * column on persisted path rows (goal text PARAPHRASED on purpose — see the note
 * at the end of this block) was planned against the right file and produced this
 * entire diff:
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
 *
 * ── WHY THE GOAL TEXT ABOVE IS PARAPHRASED ───────────────────────────────────
 * The workspace phrase search greps this tree, so a verbatim goal span written
 * into source becomes a phantom UNIQUE match and restates that goal onto this
 * file. It has now happened THREE times — twice in goal-host-vessel, and once
 * here, in the file written to catch exactly this genre of mistake. Paraphrase
 * illustrative goal text, always.
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
/**
 * Strip TYPE-ONLY syntax that cannot affect runtime behaviour.
 *
 * Narrow on purpose: only `as <Type>` and `satisfies <Type>` are removed, both of
 * which are erased by the compiler. This is not a TypeScript parser and must not
 * pretend to be — anything it does not recognise stays, so an unrecognised change
 * is treated as REAL.
 */
function stripTypeOnly(s: string): string {
  return s
    .replace(/\s+as\s+const\b/g, "")
    .replace(/\s+as\s+[A-Za-z_$][\w$.<>[\]|\s]*/g, "")
    .replace(/\s+satisfies\s+[A-Za-z_$][\w$.<>[\]|\s]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Does the edit make a function call itself forever?
 *
 * THE OBSERVED CASE (2026-08-11, commit d96e2ae — authored autonomously and cut
 * over to the live vessel):
 *
 *   - return best ?? pool[0];
 *   + return pickSatisfierProducer(pool);
 *
 * where `pool` is the function's own parameter. Every invocation loops forever.
 *
 * NOTHING OBJECTED. It is perfectly type-correct, so `tsc` passed; the semantic
 * judge approved it; the mitosis verdict was FAVORABLE; the dispatch was graded
 * `reached:true`; it landed on origin/dev and deployed. The module had no test, so
 * no gate ever EXECUTED the function — and a typecheck cannot tell "returns the
 * best producer" from "calls itself forever".
 *
 * It does not even crash: the call is in tail position, so the engine turns it
 * into a loop and the vessel HANGS while still reporting healthy.
 *
 * ── DELIBERATELY NARROW ──────────────────────────────────────────────────────
 * Fires only when an ADDED line is `return <enclosing fn>(<args>)` with arguments
 * that are exactly the function's own parameter names, in order. That is provably
 * non-terminating: same function, same values, unconditionally.
 *
 * Genuine recursion is NOT touched — a recursive call that changes an argument
 * (`walk(node.next)`, `f(n - 1)`) or is guarded by a base case reads differently
 * and passes. A gate that refused all self-calls would be far worse than the
 * defect it prevents, since recursion is ordinary and correct.
 */
/**
 * Is this line purely a diagnostic emission?
 *
 * console.*, and this fleet's `tap(...)` walk-log helper. Deliberately a small
 * fixed list: anything unrecognised counts as REAL code, so an unfamiliar shape
 * is never mistaken for a no-op.
 */
function isLoggingCall(line: string): boolean {
  const s = line.trim().replace(/^[-+]\s*/, "");
  return /^(?:await\s+)?(?:console\.(?:log|warn|error|info|debug)|tap|logger\.(?:log|warn|error|info|debug))\s*\(/.test(s);
}

export function nonTerminatingEditReason(before: string, after: string): string | null {
  if (typeof before !== "string" || typeof after !== "string") return null;
  if (after === before) return null;

  const beforeLines = new Set(before.split("\n").map((l) => l.trim()));
  const added = after
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !beforeLines.has(l));
  // Only functions this edit actually touched are examined.
  //
  // BINDING THE CALL TO A LOCAL FIRST IS THE SAME DEFECT AND THE SAME PROOF.
  // The collection below used to match only `return f(...)`, so
  //
  //     const conditionStatus = verifyGapCondition(gap);
  //     if (conditionStatus !== 'present') { return conditionStatus; }
  //
  // produced an EMPTY addedSelfCalls and this function returned null at the very
  // next line — both rules below are keyed off this set, so widening it here is
  // the whole fix. That two-statement form is not hypothetical: it is what
  // 75427eea actually landed into gap-to-feature.ts (reverted as f836134), and a
  // detector that catches `return f(x)` while missing `const y = f(x); return y`
  // is checking a spelling, not a property.
  //
  // Rule 2's soundness argument carries over unchanged, because it is about the
  // ARGUMENTS, not the syntax: if every argument is a plain binding never
  // reassigned in the body, the recursive invocation meets every guard in exactly
  // the same state, so any guard that would return early returns early in both —
  // the call is unconditional with respect to its arguments either way.
  //
  // One real difference, reflected in the explanations below: a returned self-call
  // sits in tail position and loops, while an assigned one grows the stack and
  // eventually throws. Both are non-terminating; only the symptom differs.
  const SELF_CALL_RETURN = /^return\s+([A-Za-z_$][\w$]*)\s*\(/;
  const SELF_CALL_ASSIGN = /^(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/;
  const calleeOf = (l: string): string | null =>
    SELF_CALL_RETURN.exec(l)?.[1] ?? SELF_CALL_ASSIGN.exec(l)?.[1] ?? null;
  const addedSelfCalls = added.filter((l) => calleeOf(l) !== null);
  if (addedSelfCalls.length === 0) return null;

  for (const fn of functionBodies(after)) {
    // Did this edit add a self-call — returned or bound — inside THIS function?
    const touched = addedSelfCalls.some((l) => calleeOf(l) === fn.name && fn.body.includes(l));
    if (!touched) continue;

    const selfCall = new RegExp(`^return\\s+${escapeRe(fn.name)}\\s*\\(`);
    const returns = (fn.body.match(/\breturn\b[^;\n]*/g) ?? []).map((r) => r.trim());

    // RULE 1 — NO BASE CASE. Every return is a self-call, so nothing can exit.
    if (returns.length > 0 && returns.every((r) => selfCall.test(r))) {
      return (
        `non-terminating edit: after this change every return in \`${fn.name}\` is a call to ` +
        `\`${fn.name}\` itself (${returns.length} return statement(s), no base case), so no ` +
        `invocation can exit. This typechecks, and in tail position it loops rather than ` +
        `overflowing the stack — the process hangs while still reporting healthy`
      );
    }

    // RULE 2 — NO PROGRESS. A base case can exist and still never be reached.
    //
    // This is the observed case and Rule 1 does NOT catch it: the real function
    // opened with `if (producers.length === 0) return undefined;` — a genuine base
    // case — and the added line was `return pickSatisfierProducer(pool)`, handing
    // the next invocation a value it never narrows. The base case is unreachable
    // for every non-empty input, which is every real input.
    //
    // Recursion only terminates if something CHANGES on the way down. So: a self
    // call whose arguments are all PLAIN IDENTIFIERS that are never reassigned in
    // the body cannot be making progress — the same values recurse forever.
    //
    // Ordinary recursion is untouched because it does not look like this. It
    // passes a derived expression — `walk(node.next)`, `f(n - 1)`, `go(rest)` where
    // `rest` is reassigned in a loop — and any property access, arithmetic, call,
    // literal, or reassigned binding makes this rule abstain.
    for (const line of addedSelfCalls) {
      if (calleeOf(line) !== fn.name || !fn.body.includes(line)) continue;
      const returned = selfCall.test(line);
      const argsRaw = /\(([^)]*)\)\s*;?$/.exec(line)?.[1] ?? "";
      const args = argsRaw.split(",").map((a) => a.trim()).filter(Boolean);
      if (args.length === 0) continue; // zero-arg self call: Rule 1's territory
      const allPlain = args.every((a) => /^[A-Za-z_$][\w$]*$/.test(a));
      if (!allPlain) continue; // derived expression → real progress is plausible
      const anyReassigned = args.some((a) =>
        new RegExp(`\\b${escapeRe(a)}\\s*(?:=[^=]|\\+\\+|--|\\+=|-=)`).test(
          fn.body.replace(new RegExp(`(?:const|let|var)\\s+${escapeRe(a)}\\s*=`, "g"), ""),
        ),
      );
      if (anyReassigned) continue; // the value moves → cannot claim non-progress
      return (
        `non-terminating edit: the added line \`${line}\` ${returned ? "returns" : "binds"} a call to ` +
        `the enclosing function \`${fn.name}\` passing ${args.map((a) => `\`${a}\``).join(", ")} — plain ` +
        `binding(s) never reassigned in the body, so each invocation recurses on the same ` +
        `value and no base case can ever be reached. This typechecks, and ` +
        (returned
          ? `in tail position it loops rather than overflowing the stack — the process hangs ` +
            `while still reporting healthy`
          : `because the call is BOUND rather than returned it is not in tail position, so it ` +
            `grows the stack until the process throws — a crash loop rather than a silent hang`)
      );
    }
    continue;
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Function bodies in source order, by brace matching from each declaration.
 *
 * Not a parser and must not pretend to be: anything it cannot match is skipped,
 * so an unrecognised shape is simply not checked rather than wrongly refused.
 */
function functionBodies(src: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const decl = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  for (const m of src.matchAll(decl)) {
    const name = m[1]!;
    const open = src.indexOf("{", m.index! + m[0].length);
    if (open < 0) continue;
    let depth = 0;
    let i = open;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;
    out.push({ name, body: src.slice(open, i + 1) });
  }
  return out;
}

/**
 * Did this edit add an assignment that the very next statement erases?
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Observed live 2026-08-12. Commit 8eb660a landed autonomously via mitosis
 * cutover, closing its gap, having inserted into substrate-gap.ts:
 *
 *     if (existingIdx < 0) {
 *   +   existingIdx = gaps.findIndex((g) => gapClassKey(g.id) === classKey);
 *       // hasClassifiableId FIRST: ...
 *       existingIdx = gaps.findIndex((g) => hasClassifiableId(g) && ...);
 *     }
 *
 * The added assignment is overwritten by the next statement before anything can
 * read it, so the change has NO behavioural effect — and it still closed the gap
 * it was supposed to fix. A false close is the costly half: it removes the demand
 * that would otherwise drive the real repair.
 *
 * Neither existing gate could see it. `tsc` cannot — a dead store is valid
 * TypeScript. `vacuousEditReason`'s unused-binding rule cannot — that looks for a
 * DECLARATION whose binding is never used, and this is an assignment to an
 * ALREADY-DECLARED binding, so there is no new binding to be unused. The detector
 * sat one syntactic case away from the defect, which is the same shape as
 * `nonTerminatingEditReason` catching `return f(x)` while missing
 * `const y = f(x); return y`.
 *
 * ── DELIBERATELY NARROW ──────────────────────────────────────────────────────
 * Fires only when an ADDED line is `x = <expr>;` and the very NEXT statement —
 * blank lines and comments skipped, nothing else — assigns `x` again. Adjacency
 * is what makes the proof local: no intervening statement exists, so nothing can
 * read the first value and no branch can skip the second write.
 *
 * A later reassignment separated by any real statement is NOT touched, because
 * that statement may read the value or may be a guard that returns first.
 * Legitimate accumulate-then-overwrite (`x = a; x = f(x);`) is not touched
 * either: the second assignment READS x, which is checked for explicitly.
 */
export function deadStoreEditReason(before: string, after: string): string | null {
  if (typeof before !== "string" || typeof after !== "string") return null;
  if (after === before) return null;

  const beforeLines = new Set(before.split("\n").map((l) => l.trim()));
  const lines = after.split("\n").map((l) => l.trim());
  // `let x = 1` / `const x = 1` are DECLARATIONS — a redeclaration is a syntax
  // error, not a dead store, so only bare assignments qualify.
  const ASSIGN = /^([A-Za-z_$][\w$]*)\s*=\s*([^=].*?);?$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (beforeLines.has(line)) continue; // untouched by this edit
    const m = ASSIGN.exec(line);
    if (!m) continue;
    const name = m[1]!;
    if (/^(?:const|let|var)\b/.test(line)) continue;
    if (!name) continue;

    // The NEXT statement, skipping blanks and comments only.
    let j = i + 1;
    while (j < lines.length && isInert(lines[j]!)) j++;
    if (j >= lines.length) continue;
    const next = ASSIGN.exec(lines[j]!);
    if (!next || next[1] !== name) continue;
    if (/^(?:const|let|var)\b/.test(lines[j]!)) continue;
    // If the overwriting statement READS the binding, this is an accumulation,
    // not a dead store.
    if (new RegExp(`\\b${escapeRe(name)}\\b`).test(next[2] ?? "")) continue;

    return (
      `dead store: the added line \`${line}\` assigns \`${name}\`, and the very next statement ` +
      `\`${lines[j]}\` assigns \`${name}\` again without reading it, so the added line has no ` +
      `effect whatsoever. This typechecks and the file behaves identically, so it cannot be the ` +
      `requested change — and accepting it would close the gap while leaving the defect in place`
    );
  }
  return null;
}

export function vacuousEditReason(before: string, after: string): string | null {
  if (typeof before !== "string" || typeof after !== "string") return null;
  if (after === before) return null;

  // AN EDIT THAT CANNOT TERMINATE CANNOT BE THE REQUESTED CHANGE.
  // Checked first: non-termination is the most destructive of these classes, and
  // unlike the others it survived every existing gate and reached production.
  const loops = nonTerminatingEditReason(before, after);
  if (loops) return loops;

  // AN EDIT THE NEXT STATEMENT ERASES CANNOT BE THE REQUESTED CHANGE.
  const dead = deadStoreEditReason(before, after);
  if (dead) return `dead store simulation: ${dead}`;

  // A TYPE-ONLY EDIT CANNOT BE THE REQUESTED CHANGE.
  //
  // Observed in production: a repair goal about a missing tenant column produced,
  // and LANDED via mitosis cutover, exactly this diff in the correct file —
  //
  //   - message: `Child path produces shapes [...]`
  //   + message: `Child path produces shapes [...]` as const
  //
  // `as const` is erased by the compiler, so the emitted program is byte-identical.
  // It typechecks (of course), the verdict came back FAVORABLE, and it shipped.
  // The earlier arm of this function only inspects ADDED declarations, so a
  // MODIFIED line carrying a no-op assertion sailed past it.
  //
  // Deliberately narrow: only `as X` / `satisfies X` are stripped. A change that
  // alters anything else — including a type annotation that makes real code
  // compile — is not matched here and proceeds normally.
  if (stripTypeOnly(before) === stripTypeOnly(after)) {
    return (
      "type-only edit: the change is limited to type assertions (`as` / `satisfies`), " +
      "which the compiler erases — the emitted program is identical, so this cannot be " +
      "the requested change"
    );
  }

  const beforeLines = new Set(before.split("\n").map((l) => l.trim()));
  const added = after
    .split("\n")
    .filter((l) => !beforeLines.has(l.trim()))
    .filter((l) => !isInert(l));

  // A DIAGNOSTIC-ONLY EDIT CANNOT BE THE REQUESTED CHANGE.
  //
  // Observed 2026-08-11 (bc0ba3f3 — authored autonomously, graded reached:true,
  // verdict FAVORABLE, LANDED on origin/dev and deployed). The entire diff:
  //
  //   - tap(`[goal-host-vessel] ... capacity-refused for ${editFile} — compose
  //          still BUSY after retry; NOT escalating ...`);
  //
  // One deleted logging call. The `if (verdict === "BUSY")` block and its return
  // were untouched, so behaviour was identical — and the change REMOVED an honest
  // diagnostic, making the fleet slightly harder to debug.
  //
  // Every gate passed it. Deleting a log line typechecks, keeps shape-dispatch
  // agreement, and breaks no test. The semantic judge even recorded that the patch
  // "removes the suppression of byte-anchored escalation" — describing a change
  // that is not in the diff.
  //
  // The arm below cannot catch it: it inspects ADDED lines, and a pure deletion
  // returns null on the honest principle that a deletion can be the right repair.
  // That principle holds for deleting CODE. It does not hold when the only thing
  // removed is a diagnostic, because a program that logs less behaves the same.
  //
  // Narrow deliberately: fires only when EVERY changed line — added or removed —
  // is a logging call. A diff that also touches a condition, a return, an
  // assignment or a call is real work and passes untouched. A goal genuinely
  // asking to quieten a log will be refused here, which is the accepted cost: that
  // ask is rare, the refusal is recoverable via escalation, and it landed twice
  // tonight in the other direction.
  const removed = after
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isInert(l));
  const afterSet = new Set(removed);
  const deleted = before
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isInert(l) && !afterSet.has(l));
  const changed = [...added, ...deleted];
  // A DIAGNOSTIC THAT DISTINGUISHES MORE STATES IS REPAIR, NOT QUIETENING.
  // The rule below rests on "a program that logs differently behaves identically".
  // That is true of the emitted program and false of this system, whose reach-gate
  // lessons, judge, and every after-the-fact analysis read the log — as the comment
  // above already says. So an edit that ADDS a conditional branch to a log line is
  // adding information, and refusing it protects the wrong thing. Measured case: a
  // HOLLOW summary line reported "β-penalised last pick" for a beta the branch above
  // it had WITHHELD, and that line produced two published, wrong conclusions about
  // the system's learning dynamics before anyone consulted the sink. Its repair adds
  // one ternary and was refused here. Counting branches separates the three cases:
  // deleting a log line (0 added) and rewording one (no new branch) are still
  // refused; only a strict increase in conditionals is allowed through.
  const _logBranches = (ls: string[]) => ls.reduce((n, l) => n + (l.match(/\?/g) ?? []).length, 0);
  const _distinguishesMore = _logBranches(added) > _logBranches(deleted);
  if (changed.length > 0 && changed.every(isLoggingCall) && !_distinguishesMore) {
    return (
      `diagnostic-only edit: every changed line is a logging call ` +
      `(${changed.length} line(s), e.g. \`${(changed[0] ?? "").slice(0, 80)}\`). ` +
      `A program that logs differently behaves identically, so this cannot be the ` +
      `requested change — and removing a diagnostic makes the failure it reported ` +
      `harder to see`
    );
  }

  // Nothing meaningful added (pure deletion or comment/whitespace churn): not
  // this gate's business. A deletion of real CODE can be exactly the right repair.
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

/**
 * A whole-file rewrite that collapses the file is truncation, not repair.
 *
 * Exported and separate from the edit rules above because it guards a different
 * operation: `fs_write` of a COMPLETE file, where there is no anchor to check and
 * no diff to inspect — only the before and after sizes.
 *
 * The rule this replaces was an absolute floor (`body.length < 8`). An absolute
 * floor bounds the OUTPUT; the damage is RELATIVE, so the guard must be too.
 * Measured in production before this existed:
 *
 *   create-file-repair full-rewrite {"file":"…/feature-compose.ts","wrote":true,"bytes":160}
 *
 * 160 bytes over a ~190KB file — far above the floor, and a total loss.
 *
 * ONE-SIDED ON PURPOSE. Growth is never refused: adding a missing import, type or
 * export legitimately grows a file, and refusing that would block real repairs.
 * Only collapse is refused, and only past half — a re-author that genuinely halves
 * a file is rare enough to be worth a human look, while an order-of-magnitude drop
 * is always a truncated or hallucinated response.
 *
 * Returns a reason string when the write must be refused, or null to allow it.
 */
export function truncatingRewriteReason(
  before: string,
  after: string,
  file = "the file",
  minRatio = 0.5,
): string | null {
  if (typeof before !== "string" || typeof after !== "string") return null;
  // Nothing to protect: an empty or unreadable original cannot be truncated.
  if (before.length === 0) return null;
  if (after.length >= before.length * minRatio) return null;
  return (
    `truncating rewrite: the replacement for ${file} is ${after.length} bytes against ` +
    `${before.length} before (${((after.length / before.length) * 100).toFixed(1)}% of the original, ` +
    `below the ${(minRatio * 100).toFixed(0)}% floor) — a whole-file re-author that collapses the file ` +
    `is a truncated or hallucinated response, not a repair, and writing it would destroy the file`
  );
}
