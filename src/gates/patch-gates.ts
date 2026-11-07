// Static patch gates over a drafted diff or file (architecture, stub, CJS-in-ESM, inert regex, unresolvable impulse endpoint, region containment). Lifted as-is from feature-compose.ts.


// FUNCTIONAL-COMPLETENESS / STUB DETECTION (2026-06-29, safety gate-strengthening).
// Reachability proves a new symbol CAN execute (it has a caller / is an entrypoint);
// it does NOT prove the new symbol DOES the work the gap intends. Now that the loop
// can author a complete multi-vessel architectural MOVE (new endpoint + wiring +
// call-site) that typechecks and is WIRED (on_live_path:true), a placeholder/stub
// body slips through: the endpoint exists, is called, the LLM judged addresses:true
// (it IS wired) — but the body is `// TODO` / `throw new Error("not implemented")` /
// `return null`. Landing that to origin/dev pollutes the tree with a non-functional
// new capability. This deterministic, cheap detector runs BEFORE the LLM judge and
// HARD-FAILS create-heavy diffs whose newly-introduced handler/function bodies are
// stubs. Scoped to create-heavy changes (a diff that adds a NEW FILE or a brand-new
// function/handler body) so surgical edits to existing files are untouched.

/** Is this diff "create-heavy" — does it introduce a new file or a new function body? */
export function diffIsCreateHeavy(diff: string): boolean {
  if (/^###\s+NEW FILE\s+/m.test(diff)) return true;
  // a brand-new function/handler/route definition added on a `+` line
  for (const raw of diff.split("\n")) {
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    const body = raw.slice(1);
    if (/^\s*(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.test(body)) return true;
    if (/\.(get|post|put|delete|patch|use|on)\s*\(/.test(body)) return true; // route/handler registration
  }
  return false;
}

export interface StubVerdict {
  isStub: boolean;
  reason: string;
  marker?: string;      // the stub signal that fired
  symbol?: string;      // the new function/handler the stub lives in (best-effort)
}

// Stub MARKERS in the added (`+`) content of a create-heavy diff. We only consider
// ADDED lines (the new code) so a pre-existing TODO elsewhere in an edited file never
// trips this. Explicit "not implemented" / placeholder signals + structurally-empty
// or return-only handler bodies.
// CODE markers — matched against code with comments/strings STRIPPED (so a doc-comment
// or log string mentioning a marker word never trips). A bare marker word is only a
// stub signal when it survives as actual code.
const STUB_TEXT_MARKERS: Array<{ re: RegExp; label: string }> = [
  { re: /\bTODO\b/i, label: "TODO" },
  { re: /\bFIXME\b/i, label: "FIXME" },
  { re: /\bXXX\b/, label: "XXX" },
  { re: /\bnot[\s_-]?implemented\b/i, label: "not implemented" },
  { re: /\bunimplemented\b/i, label: "unimplemented" },
  { re: /\bplaceholder\b/i, label: "placeholder" },
  { re: /\bstub(?:bed)?\b/i, label: "stub" },
  { re: /\bcoming soon\b/i, label: "coming soon" },
  { re: /\bnot\s+yet\b/i, label: "not yet" },
];

// STRUCTURAL throw marker — matched against the ORIGINAL (un-stripped) text. A
// `throw new Error("...not implemented...")` is a genuine code stub even though the
// marker word lives inside the string: the `throw new Error(` structure around it is
// the real signal, so this one intentionally inspects the string body.
const THROW_NOT_IMPLEMENTED_RE =
  /throw\s+new\s+(?:Error|TypeError)\s*\(\s*["'`][^"'`]*\b(?:not\s+implemented|unimplemented|todo|stub|placeholder|not\s+yet)\b/i;

/**
 * Strip line comments, block comments, and string/template literals from a blob of
 * code, replacing their contents with spaces (offsets/newlines preserved). A small
 * hand-rolled scanner — good enough to keep marker words that live in comments/strings
 * from tripping the text-marker gate, without pulling in a full TS parser. Conservative
 * by construction: it only ever REMOVES text, so it can never manufacture a stub signal.
 */
export function stripCommentsAndStrings(src: string): string {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  while (i < n) {
    const c = src[i] as string;
    const next = src[i + 1];
    // line comment
    if (c === "/" && next === "/") {
      let j = i + 2;
      while (j < n && src[j] !== "\n") j++;
      out.push(blank(src.slice(i, j)));
      i = j;
      continue;
    }
    // block comment
    if (c === "/" && next === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      out.push(blank(src.slice(i, j)));
      i = j;
      continue;
    }
    // string / template literal
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; } // escape
        if (src[j] === quote) { j++; break; }
        j++;
      }
      // keep the quote chars, blank the interior so structure (e.g. fn call args) survives
      const body = src.slice(i, j);
      out.push(body.length >= 2 ? quote + blank(body.slice(1, -1)) + (body.endsWith(quote) ? quote : "") : body);
      i = j;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("");
}

/**
 * Detect whether a CREATE-HEAVY diff's newly-introduced capability is a STUB rather
 * than a functional implementation. Returns isStub:false for non-create-heavy diffs
 * (so it never affects surgical edits) and for create-heavy diffs whose new code has
 * real substance. Deterministic and cheap — runs before the LLM judge.
 *
 * Signals (any → stub):
 *  - an explicit stub-text marker (TODO/FIXME/not implemented/placeholder/...) on an
 *    ADDED line, EXCEPT inside an obvious string/log that isn't the body's only act;
 *  - a newly-added function/handler whose body is a single `return null|undefined|{}|[]`
 *    or empty `{}` (a return-only / empty handler where real logic should live);
 *  - a `throw new Error("...not implemented...")`-only body.
 */
export function detectNewCapabilityStub(diff: string): StubVerdict {
  if (!diffIsCreateHeavy(diff)) {
    return { isStub: false, reason: "not a create-heavy diff (surgical edit) — stub check N/A" };
  }
  // Collect ADDED code lines (drop the diff `+` and the NEW-FILE markers).
  const added: string[] = [];
  for (const raw of diff.split("\n")) {
    if (/^###\s+(?:NEW FILE\s+)?/.test(raw)) continue;
    if (raw.startsWith("+++")) continue;
    if (raw.startsWith("+")) added.push(raw.slice(1));
  }
  const addedJoined = added.join("\n");

  // 1) Explicit textual stub markers — but ONLY in actual CODE. The gate's own
  //    contract (above) promises an exception for markers "inside an obvious
  //    string/log"; this is that exception, finally implemented. We strip line
  //    comments (`// …`), block comments (`/* … */`), and string/template literals
  //    from the added code before matching, so a `// not yet wrapped` doc-comment or
  //    a log/JSON string never trips, while a real `throw new Error("not implemented")`
  //    still does (the throw-keyword marker matches the live structure, not the
  //    string body alone). Conservative: stripping replaces literal/comment content
  //    with spaces (preserving offsets) and never invents stub signal.
  const codeOnly = stripCommentsAndStrings(addedJoined);
  for (const { re, label } of STUB_TEXT_MARKERS) {
    const m = codeOnly.match(re);
    if (m) {
      return {
        isStub: true,
        marker: label,
        reason: `new capability contains a stub marker ("${label}") in code — the new code is a placeholder, not a functional implementation`,
      };
    }
  }
  // 1b) `throw new Error("...not implemented...")` — a genuine stub even though the
  //     marker lives in the string; the throw structure is the real signal, so match
  //     against the ORIGINAL (un-stripped) text.
  if (THROW_NOT_IMPLEMENTED_RE.test(addedJoined)) {
    return {
      isStub: true,
      marker: "throw not-implemented",
      reason: `new capability throws a not-implemented error — a placeholder body, not a functional implementation`,
    };
  }

  // 2) Structural: a newly-added function/handler whose ENTIRE body is return-only /
  //    empty. We scan added text for a function/arrow/handler open and check its body
  //    is trivial. Cheap brace-walk over the added text only.
  const trivialBody = (body: string): string | null => {
    const t = body.trim();
    if (t === "" ) return "empty body";
    // strip a single trailing/leading set of nothing-statements
    const stripped = t
      .replace(/^[;\s]+/, "")
      .replace(/[;\s]+$/, "");
    if (stripped === "") return "empty body";
    if (/^return\s*(?:null|undefined|\{\s*\}|\[\s*\]|""|''|``)?\s*;?$/.test(stripped)) return `return-only body (${stripped})`;
    if (/^void\s+0\s*;?$/.test(stripped)) return "no-op body (void 0)";
    return null;
  };
  // A body that is a SINGLE `return <literal>;` where the literal references NONE of the
  // function's parameters, makes no call, awaits nothing, and reads no env — a compile-time
  // constant returned REGARDLESS of the input. This is the shellResultResolver miss:
  // `return { shape:'shellResult', body:'computed report' }` is non-empty (so trivialBody
  // misses it) yet computes nothing and ignores its `pointer`. FALSE-POSITIVE GUARDS: only
  // fires when the fn declares >=1 meaningful (non `_`-prefixed) param — a noop/sentinel
  // resolver signals "no input needed" by taking no params or `_`-prefixing them; and a
  // `;` in the header means openRe swallowed a ternary/statement (not a real signature) — bail.
  const constantReturnStub = (body: string, paramsStr: string, header: string): string | null => {
    if (/;/.test(header)) return null; // openRe over-match (ternary+if swallowed) — not a function head
    const paramNames = paramsStr
      .split(",")
      .map((p) => p.trim().match(/^\.{0,3}\s*([A-Za-z_$][\w$]*)/)?.[1])
      .filter((n): n is string => Boolean(n));
    const meaningful = paramNames.filter((n) => !n.startsWith("_"));
    if (meaningful.length === 0) return null; // no input to honour -> not a placeholder
    const t = body.trim().replace(/^[;\s]+/, "").replace(/[;\s]+$/, "");
    const m = t.match(/^return\b([\s\S]*?);?$/); // single `return ...` statement only
    if (!m) return null;
    const expr = m[1]!.trim();
    // Must BE a compile-time literal (object/array/string/number/bool/null), no runtime work.
    if (!/^(?:\{[\s\S]*\}|\[[\s\S]*\]|"[^"]*"|'[^']*'|`[^`]*`|-?\d[\d_.eE]*|true|false|null)$/.test(expr)) return null;
    if (expr.includes("(")) return null;                 // any call/constructor/arrow -> real work
    if (/\bawait\b/.test(expr)) return null;             // awaits -> real work
    if (/\bprocess\s*\.\s*env\b/.test(expr)) return null; // reads env -> not constant
    for (const p of paramNames) {                        // interpolates/reads a param -> uses input
      if (new RegExp(`\\b${p.replace(/\$/g, "\\$")}\\b`).test(expr)) return null;
    }
    const shown = expr.length > 60 ? expr.slice(0, 57) + "..." : expr;
    return `constant-return body (return ${shown})`;
  };
  // Find `function NAME(...) { BODY }`, `NAME(...) => { BODY }`, and route handlers
  // `.post("/x", (req) => { BODY })` in the added text. Brace-match to extract BODY.
  const openRe = /(?:function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^={]+)?|(?:async\s+)?\([^)]*\)\s*(?::[^=]+)?=>|\b([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^={]+)?)\s*\{/g;
  let mm: RegExpExecArray | null;
  while ((mm = openRe.exec(addedJoined)) !== null) {
    const sym = mm[1] || mm[2] || "(anonymous)";
    if (["if", "for", "while", "switch", "catch", "do", "else", "try", "return"].includes(sym)) continue; // control-flow, not a capability function
    // brace-match from the `{` we just consumed
    let depth = 1;
    let i = openRe.lastIndex;
    for (; i < addedJoined.length && depth > 0; i++) {
      const c = addedJoined[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    if (depth !== 0) continue; // unbalanced (partial diff) — skip, do not false-fail
    const body = addedJoined.slice(openRe.lastIndex, i - 1);
    // Header = match-start -> the consumed `{`; first paren group = the param list. Used to
    // distinguish a genuine constant resolver (no input to honour) from a placeholder that
    // IGNORES the pointer it was handed.
    const header = addedJoined.slice(mm.index, openRe.lastIndex - 1);
    const paramsStr = header.match(/\(([^)]*)\)/)?.[1] ?? "";
    const triv = trivialBody(body) ?? constantReturnStub(body, paramsStr, header);
    if (triv) {
      return {
        isStub: true,
        symbol: sym,
        marker: triv,
        reason: `new capability ${sym} has a ${triv} — a wired but non-functional placeholder, not a real implementation`,
      };
    }
  }

  return { isStub: false, reason: "create-heavy diff: new capability has substantive body (no stub signals)" };
}

// ARCHITECTURE-CONFORMANCE SCAN (2026-07-27). The substrate authors its own code, so a
// self-authored patch must conform to the substrate's OWN standing laws — otherwise the
// system erodes the very idiom it is meant to define BY ITS USE. This is the architecture
// analogue of the reach gate: a patch can fix a gap AND typecheck yet do it by VIOLATING a
// law — gating behaviour behind an env var read at a branch (L1: behaviour must be a shape
// read at use time; env is bootstrap-only, invisible to traces and the walk, unlearnable),
// or inlining an LLM provider call in vessel TS (dev-vessel layer-3: LLMs are invoked ONLY
// through an llm-prompt-tier resolver dispatched from an activity, never inline). We do NOT
// hard-block on a heuristic — that could wedge self-development — but surface deterministic,
// law-backed NOTES to the semantic judge, which weighs whether the fix is conformant. Two
// narrow, high-precision, code-only rules; bootstrap env reads (secrets/ports/identity/
// endpoints) are explicitly allowed so a legitimate config read is never flagged.
export function detectArchitectureViolation(
  diff: string,
): Array<{ law: string; detail: string; snippet: string }> {
  const added = diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));
  const violations: Array<{ law: string; detail: string; snippet: string }> = [];
  const seen = new Set<string>();
  const push = (law: string, detail: string, snippet: string): void => {
    const snip = snippet.trim().slice(0, 160);
    const key = law + "|" + snip.slice(0, 80);
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ law, detail, snippet: snip });
  };
  const INLINE_LLM =
    /\bnew\s+(?:Anthropic|OpenAI)\b|from\s+['"](?:@anthropic-ai\/sdk|openai)['"]|require\(\s*['"](?:@anthropic-ai\/sdk|openai)['"]\s*\)|anthropic\.messages\.create|openai\.chat\.completions|\/v1\/(?:messages|chat\/completions)\b/;
  // Bootstrap-legitimate env names (secrets, ports, identity, endpoints, storage coords).
  const BOOTSTRAP_ENV =
    /(?:PORT|ENDPOINT|URL|HOST|HOSTNAME|ADDR|SECRET|TOKEN|API_?KEY|_KEY$|_DIR$|_PATH$|MODEL|ORG|_ID$|NODE_ENV|DSN|DATABASE|NAMESPACE|_NS$|_DB$|REGION|BUCKET)/;
  // env read used at a BRANCH/decision point (not a top-level const assignment).
  const ENV_GATE =
    /(?:if\s*\(|while\s*\(|\?|&&|\|\||return\s+|===|!==|==|!=)[^;\n]*\bprocess\.env\.([A-Z0-9_]+)\b/;
  // Check C (2026-07-29): a LITERAL external URL hardcoded in self-authored vessel code. Internal
  // endpoints are uniformly `process.env.<X>_ENDPOINT ?? "http://127.0.0.1:<port>"`, so a bare
  // external host with NO process.env on the line is either a confabulated endpoint (patch_with_tools
  // invented https://concept-db.com — a data-egress risk that passed every STRUCTURAL gate) or an
  // unsanctioned external integration. ADVISORY (fed to the semantic judge) — matches the env-gate
  // rule's severity; per the L786 design we surface a law-backed NOTE, never hard-block a heuristic.
  const EXTERNAL_URL = /https?:\/\/([a-zA-Z0-9._-]+(?::\d+)?)/;
  const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal)$/;
  const ALLOWED_HOST = /^(?:(?:[a-z0-9-]+\.)*github\.com|(?:[a-z0-9-]+\.)*npmjs\.(?:com|org)|registry\.npmjs\.org|httpbin\.org)$/;
  const removedHosts = new Set(
    diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"))
      .flatMap((l) => [...l.matchAll(/https?:\/\/([a-zA-Z0-9._-]+(?::\d+)?)/g)].map((mm) => mm[1]!.toLowerCase())),
  );
  for (const rawLine of added) {
    const code = rawLine.trim();
    if (!code || code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue;
    if (INLINE_LLM.test(code)) {
      push(
        "dev-vessel layer-3 (LLMs only via the llm-prompt resolver, never inlined)",
        "an LLM provider is instantiated / imported / called directly in vessel TS instead of dispatched through the llm-prompt-tier resolver from an activity — inline LLM calls are untraced and break the layering",
        code,
      );
      continue;
    }
    const m = code.match(ENV_GATE);
    if (m && !BOOTSTRAP_ENV.test(m[1]!)) {
      push(
        "L1 (behaviour must be a shape read at use time; env is bootstrap-only)",
        `runtime behaviour is gated behind process.env.${m[1]!}, which is frozen at process start, invisible to traces and the walk, and unlearnable — steer this behaviour with a shaped impulse read at use time instead`,
        code,
      );
    }
    if (!code.includes("process.env")) {
      const um = code.match(EXTERNAL_URL);
      if (um) {
        const hostport = um[1]!.toLowerCase();
        const host = hostport.replace(/:\d+$/, "");
        if (!LOCAL_HOST.test(host) && !ALLOWED_HOST.test(host) && !removedHosts.has(hostport)) {
          push(
            "L11/L1 (endpoints are config, not literals; external egress must be sanctioned)",
            `a literal external URL (${um[1]!}) is hardcoded in self-authored vessel code with no process.env on the line — internal endpoints must be process.env.<X>_ENDPOINT ?? a loopback fallback, and a bare external host is an unsanctioned data-egress target invisible to config; route it through the configured endpoint, or add the host to the sanctioned allowlist if it is genuinely required`,
            code,
          );
        }
      }
    }
  }
  return violations;
}

/**
 * COVERAGE-ROUTED REFUSAL (2026-09-02): CJS accessors added to an ESM vessel.
 *
 * MEASURED, not theorised. The substrate autonomously authored, gated
 * (verdict=FAVORABLE), typecheck-verified, ran 829 passing tests, LANDED and PUSHED
 * commit 776391aa0fc2 to origin/dev with no operator hands — and the change was inert:
 *
 *     if (_reachVerdict) {
 *       try { exports.substrateGap.emit(...); } catch {}
 *     }
 *
 * `exports.substrateGap.emit` exists nowhere in the repo, and goal-host-vessel is
 * `"type": "module"`, so `exports` is UNDEFINED at runtime: every call throws
 * ReferenceError into a bare `catch {}` and emits nothing, forever. The drafter had
 * THREE correct `substrateGap_write` POST exemplars in the same file (index.ts:4144,
 * :5174, :5271) and invented an API instead.
 *
 * It passed because the target has NO TEST FILE — which this resolver ITSELF warned
 * about during that very compose ("every gate below this point READS the diff; only a
 * test RUNS it"). Correct warning, right moment, and nothing gated on it. This makes
 * that warning load-bearing, and it is the same rule the shape-vocabulary gate above
 * states: a name crossing a boundary is only checkable by RESOLVING it. In an ESM
 * module `exports` resolves to nothing — decidable statically, no network, no LLM.
 *
 * SCOPE — deliberately the narrowest high-value case, for the same reason the gate
 * above is: `exports.x` / `module.exports` ADDED to an ESM vessel CANNOT work, so
 * refusing it can never block a legitimate change. This is NOT a general
 * unresolved-identifier checker; that needs scope analysis and would false-positive.
 * ADDED lines only — removing CJS is the repair, not the defect.
 *
 * Returns the drafter-facing reason, or null when there is nothing to refuse
 * (fail open — never block on an unparseable or empty diff).
 */
/**
 * Added CODE lines of a diff — the substrate for the two literal-matching gates below.
 *
 * WHY THIS EXISTS, and it was measured, not anticipated. A false-positive sweep of both
 * gates over 180 real landed commits refused exactly one: `4495163` — the commit that
 * INTRODUCED the CJS gate. Its diff quotes `exports.substrateGap.emit` in doc-comments and
 * test fixtures to explain the defect, and a naive line match cannot tell an occurrence
 * from a description of one. Uncorrected, these gates would block every commit that
 * documents the class they police, including their own.
 *
 * Two exclusions, both narrow:
 *  - COMMENT LINES (`//`, `*`, `/*`). This is where the false positives actually were.
 *  - TEST FILES. A test's whole job is to contain the bad example; `feature-compose-
 *    coverage-gate.test.ts` embeds the inert diff verbatim as its primary fixture.
 *
 * NOTE — `stripCommentsAndStrings` is deliberately NOT used here. It blanks template
 * literal interiors, and the endpoint gate's entire subject lives inside one
 * (`` `${EP}/v2/impulses/resolve` ``); using it would make that gate silently never fire.
 * A gate that cannot fire is worse than no gate, because it reads as coverage.
 */
function addedCodeLines(diff: string): string[] {
  const out: string[] = [];
  let inTestFile = false;
  for (const raw of diff.split("\n")) {
    const hdr = /^###\s+(\S+)/.exec(raw) ?? /^\+\+\+\s+[ab]\/(\S+)/.exec(raw);
    if (hdr?.[1]) { inTestFile = /\.test\.tsx?$/.test(hdr[1]); continue; }
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    if (inTestFile) continue;
    const line = raw.slice(1);
    const t = line.trimStart();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue; // prose, not code
    out.push(line);
  }
  return out;
}

/**
 * IMPULSE-ENDPOINT RESOLVE GATE (2026-09-02). Third in the resolve-don't-read family,
 * after the shape-vocabulary gate and the CJS-in-ESM gate.
 *
 * MEASURED TWICE, on the same task, by the substrate repairing itself:
 *
 *   776391aa0fc2 — emitted a gap via `exports.substrateGap.emit(...)`: an invented API,
 *   undefined in an ESM vessel. The CJS-in-ESM gate now refuses that.
 *
 *   62e66a7 — dispatched to REPAIR the above, with the gap, that gate, and a teaching
 *   refusal all in place. It correctly removed the dead call and wrote a real fetch — to
 *   `/v2/impulses/substrateGap`, a 404. The CJS gate did not fire (correctly: not CJS),
 *   so refusal→redraft never engaged and a SECOND inert emitter landed and pushed.
 *
 * Both crossed the same boundary — a route/envelope — and nothing in the pipeline
 * resolved it. That is law 8, not a capability ceiling: the correct call appears
 * FOUR times in the very file being edited (index.ts:4157, 5187, 5284, 15167).
 *
 * AUTHORITY, unusually strong for a gate this cheap: across activity-api and
 * development-vessel exactly ONE impulse endpoint literal exists — `/v2/impulses/resolve`
 * — and all 38 impulse callers in goal-host-vessel use it. Verified live WITH A CONTROL,
 * because a bare 404 is ambiguous here:
 *     POST /v2/impulses/resolve + a served shape  -> 200
 *     POST /v2/impulses/substrateGap              -> 404 "Not found"
 * A 404 from `/resolve` means SHAPE-NOT-SERVED, never endpoint-missing.
 *
 * SCOPE — refuse only what cannot work. A LITERAL `/v2/impulses/<segment>` where segment
 * is not `resolve` addresses no route in the fleet. An interpolated segment (`${…}`)
 * cannot be resolved statically, so the gate ABSTAINS rather than guess — the same
 * fail-open discipline as its two siblings.
 *
 * Returns the drafter-facing reason, or null when there is nothing to refuse.
 */
export function unresolvableImpulseEndpointRefusal(diff: string): string | null {
  if (!diff) return null;
  const bad: string[] = [];
  for (const line of addedCodeLines(diff)) {
    for (const m of line.matchAll(/\/v2\/impulses\/([A-Za-z0-9_-]+)/g)) {
      const seg = m[1];
      if (seg && seg !== "resolve") bad.push(seg);
    }
  }
  if (bad.length === 0) return null;
  const uniq = [...new Set(bad)];
  return (
    `[fc-impulse-endpoint] the patch POSTs to ${uniq.length} impulse route(s) that do not exist: ` +
    uniq.map((s) => `\`/v2/impulses/${s}\``).join(", ") +
    `. The fleet exposes exactly ONE impulse endpoint — \`/v2/impulses/resolve\` — and all 38 ` +
    `impulse callers in goal-host-vessel/src/index.ts use it; \`/v2/impulses/${uniq[0]}\` returns ` +
    `404 and the call is INERT even though it typechecks. The shape goes in the BODY, not the path:\n` +
    `  await fetch(\`\${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve\`, { method: "POST",\n` +
    `    headers: { "Content-Type": "application/json", ...authHeader },\n` +
    `    body: JSON.stringify({ impulse: { type: "<shape>_write", pointer: { type: "<shape>_write", ... } } }) });\n` +
    `See goal-host-vessel/src/index.ts:4157. NOTE ALSO: fetch does NOT throw on 404 — a ` +
    `try/catch around it is not error handling; branch on \`!r.ok\` or the failure is silent.`
  );
}

/**
 * A PATCH THAT CHANGES BYTES BUT NOT BEHAVIOUR.
 *
 * The pipeline asks "is it valid?" (typecheck/shape-dispatch/tests) and "does it address the
 * goal?" (the semantic gate). Nothing asks the third question: DOES IT DO ANYTHING. A regex
 * edit that alters the source but not the decisions the regex drives passes every existing
 * gate, lands, is recorded as a success, and credits the arm that produced it.
 *
 * Observed live 2026-09-05: compose route-edit-5cdf696a returned UNFAVORABLE on a semantic
 * reject; the RECOMMIT then produced 5cd4e72, which landed autonomously and appended
 * `|\?\?=` to a GUARD_RE already containing `\?\?`, used unanchored - so the new
 * alternative can never match anything the old one missed. Proven inert by executing both
 * regexes over probe strings: zero behavioural differences. That reveals a gradient in the
 * recommit loop - the cheapest way to satisfy a gate that rejected you is to change nothing
 * meaningful. `empty_diff_identity_edit` does not catch it: that rule rejects a LITERALLY
 * empty diff, and this diff is not empty.
 *
 * The gate ABSTAINS whenever it cannot be certain. A false refusal blocks real work, which is
 * worse than letting one inert patch through, so any mixed, unpairable or unparseable diff
 * returns null.
 */
function splitTopLevelAlternatives(src: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "", inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") { cur += c + (src[i + 1] ?? ""); i++; continue; }
    if (inClass) { cur += c; if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; cur += c; continue; }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "|" && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.filter((x) => x.length > 0);
}

/** Best-effort: turn a regex alternative into a plain probe string, or null if not literal. */
function literaliseAlternative(alt: string): string | null {
  let out = "";
  for (let i = 0; i < alt.length; i++) {
    const c = alt[i]!;
    if (c === "\\") {
      const n = alt[i + 1];
      if (n === undefined) return null;
      if (/[dwsSWDbB]/.test(n)) return null;
      out += n; i++; continue;
    }
    if ("()[]{}*+?^$".includes(c)) {
      if (c === "(" || c === ")") continue;
      return null;
    }
    out += c;
  }
  return out.length ? out : null;
}

/** Extract a trailing `= /source/flags;` regex literal from a line. */
export function regexLiteralOfLine(line: string): { src: string; flags: string } | null {
  const m = line.match(/=\s*\/((?:\\.|\[(?:\\.|[^\]])*\]|[^/\\])+)\/([gimsuy]*)\s*;?\s*$/);
  if (!m || m[1] === undefined) return null;
  return { src: m[1], flags: m[2] ?? "" };
}

export function inertRegexEditRefusal(diff: string): string | null {
  if (!diff) return null;
  const removed: string[] = [], added: string[] = [];
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("---") || raw.startsWith("+++")) continue;
    if (raw.startsWith("-")) removed.push(raw.slice(1));
    else if (raw.startsWith("+")) added.push(raw.slice(1));
  }
  if (removed.length === 0 || removed.length !== added.length) return null;

  const pairs: Array<{ o: RegExp; n: RegExp; oSrc: string; nSrc: string }> = [];
  for (let i = 0; i < removed.length; i++) {
    const ro = regexLiteralOfLine(removed[i]!), rn = regexLiteralOfLine(added[i]!);
    if (!ro || !rn) return null;
    if (ro.src === rn.src && ro.flags === rn.flags) continue;
    try {
      pairs.push({
        o: new RegExp(ro.src, ro.flags.replace(/[gy]/g, "")),
        n: new RegExp(rn.src, rn.flags.replace(/[gy]/g, "")),
        oSrc: ro.src, nSrc: rn.src,
      });
    } catch { return null; }
  }
  if (pairs.length === 0) return null;

  for (const p of pairs) {
    const cands = new Set<string>();
    for (const alt of [...splitTopLevelAlternatives(p.oSrc), ...splitTopLevelAlternatives(p.nSrc)]) {
      const lit = literaliseAlternative(alt);
      if (lit) { cands.add(lit); cands.add(` ${lit} `); cands.add(`x${lit}y`); }
    }
    for (const s of ["", " ", "abc", "const x = 1;", "process.env.FOO"]) cands.add(s);
    let differs = false;
    for (const c of cands) if (p.o.test(c) !== p.n.test(c)) { differs = true; break; }
    if (!differs) {
      // The refusal's wording is its contract: feature-compose-inert-literal-gate.test.ts pins `[fc-inert-literal]` and
      // "behaves IDENTICALLY", feature-compose-semantic-gate-unconditional.test.ts pins `fc-inert-regex`. An autonomous
      // landing (550f2f75) once replaced this return with `return null`, switching the gate off with every test green but
      // its own; the next (f47db2b3) put back a reworded refusal that dropped both the tag and the 5cd4e72 citation.
      return (
        `[fc-inert-literal] [fc-inert-regex] the patch's ONLY change is a regex literal that behaves IDENTICALLY. ` +
        `old=/${p.oSrc}/ new=/${p.nSrc}/ agreed on all ${cands.size} probe strings, so the edit ` +
        `cannot change any decision the regex drives. It typechecks and passes tests because ` +
        `nothing EXECUTES it. This exact class landed inert on this substrate (5cd4e72). ` +
        `Either change the behaviour or make no edit.`
      );
    }
  }
  return null;
}

export function cjsInEsmRefusal(diff: string): string | null {
  if (!diff) return null;
  const offenders: string[] = [];
  for (const line of addedCodeLines(diff)) {
    if (/\bmodule\s*\.\s*exports\b/.test(line) || /\bexports\s*\./.test(line)) {
      offenders.push(line.trim().slice(0, 120));
    }
  }
  if (offenders.length === 0) return null;
  return (
    `[fc-cjs-in-esm] the patch ADDS ${offenders.length} CommonJS accessor(s) to a vessel whose ` +
    `package.json declares "type": "module": ` +
    offenders.map((o) => `\`${o}\``).join(", ") +
    `. In an ESM module the identifier \`exports\` is UNDEFINED at runtime, so this throws ` +
    `ReferenceError on every call — and wrapped in a bare \`catch {}\` it fails SILENTLY and ` +
    `does nothing, forever. This is not a style preference; the code cannot work. ` +
    `To emit an impulse from a vessel, POST it: ` +
    `fetch(endpoint, { method: "POST", body: JSON.stringify({ impulse: { type: "<shape>_write", ` +
    `pointer: { type: "<shape>_write", ... } } }) }) — see goal-host-vessel/src/index.ts:4144. ` +
    `Copy the pattern that already exists in the file you are editing; do not invent an API.`
  );
}

/**
 * Is a patch causally connected to the region a gap names?
 *
  * Is a patch causally connected to the region a gap names?
 * The problem is `diff.includes(named_symbol)` can be true, even when the `named_symbol`
 * is in an inert region (e.g. comment or string literal) so no runtime behavior change
 * will occur. This function is used to gate the generation of `semantic_diff` which is an
 * expensive operation, so this function is exported for two different landing routes
 * and only one of them used to ask about inert regions. It has been refactored to check
 * `addedCodeLines` instead of the raw `diff` and should behave identically for both call sites.
 * Exported because there are TWO landing routes and only one of them used to ask.
 * feature_compose gates here; `patch_with_tools` stages a mitosis and self-lands
 * with no semantic judge at all — which is how `046d754` put an unjudged patch on
 * the human's UI surface (it hid the elapsed span after an hour instead of holding
 * the final duration, and a finished run under an hour still counted up). One
 * implementation, both callers, so the two cannot drift.
 *
 * `touchedLines` are BARE source lines (no +/- prefix) — added or removed.
 * `fileText` is the post-apply text; safe, because the one-hop branch only runs
 * when no touched line contains the region, so region-bearing lines are unchanged.
 */
export function regionContainmentVerdict(
  touchedLines: string[],
  region: string,
  fileText: string,
): { contained: boolean; reason: string; via: "literal" | "data_flow" | "no_signal" | "none" } {
  // CODE lines only. A COMMENT that names the region is not a change to the region —
  // and the drafter writes the gap text into its own patch as a comment, so this is
  // not a hypothetical: 8a25744 landed a complete no-op past this check on the
  // strength of `// sub-fleet-elapsed: [narrowed] UI feedback ...`. Strip that line and
  // the patch declares nothing the region consumes, which is the honest verdict.
  // Same failure shape as an envelope tripwire matching its own documentation.
  const isComment = (l: string): boolean => {
    const t = l.trim();
    return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
  };
  const codeLines = touchedLines.filter((l) => !isComment(l));
  // ABSTAIN WHEN THE REGION IS NOT A LOCATOR (2026-08-07). This check assumes the
  // region names something that exists in the code. Not every gap's region does: a
  // ui-feedback row can carry a human-facing surface label ("the surface") rather
  // than the CSS class a renderer emits, and that string occurs in no source file.
  // The check then hard-fails EVERY possible patch and the gap becomes permanently
  // unsatisfiable — observed exactly that on
  // ui-feedback-the-surface-hard_to_understand once its region changed from
  // "sub-fleet-elapsed" to "the surface".
  //
  // A predicate with no signal must abstain, not reject. If the region appears
  // nowhere in the file, containment cannot discriminate between a right and a wrong
  // location, so it defers to the semantic judge and says why — a rejection carrying
  // no information is exactly what spends a gap's selection budget for nothing.
  if (!fileText.includes(region)) {
    return {
      contained: true,
      via: "no_signal",
      reason: `region "${region}" does not occur in the target file, so it is a label rather than a code locator and containment has no signal here — deferring to the semantic judge`,
    };
  }
  if (codeLines.some((l) => l.includes(region))) {
    return { contained: true, reason: `a changed line contains the region "${region}"`, via: "literal" };
  }
  // ONE HOP. The fix for a complaint about a VALUE lives at that value's definition,
  // not on the line that renders it. Deliberately NOT proximity or enclosing scope:
  // a single render function typically emits several regions, so any distance-based
  // rule readmits the right-file/wrong-region class this check exists to stop.
  const declared = new Set<string>();
  for (const body of codeLines) {
    for (const m of body.matchAll(/(?:\b(?:const|let|var)\s+|^\s*)([A-Za-z_$][\w$]*)\s*=(?!=)/g)) {
      const id = m[1];
      if (id) declared.add(id);
    }
  }
  const considered = [...declared];
  const regionLines = fileText.split("\n").filter((l) => l.includes(region));
  const hit = considered.find((id) =>
    regionLines.some((l) => new RegExp(`\\b${id.replace(/[$]/g, "\\$")}\\b`).test(l)),
  );
  if (hit) {
    return { contained: true, reason: `the patch defines "${hit}", which the region "${region}" renders`, via: "data_flow" };
  }
  return {
    contained: false,
    via: "none",
    reason: `patch does not touch the complained-about region "${region}" and nothing it defines is consumed there — no added or removed line contains the region, and none of the identifiers it assigns (${considered.length > 0 ? considered.join(", ") : "none"}) appear on a region-bearing line, so whatever this edits, it is not the region the gap names`,
  };
}
