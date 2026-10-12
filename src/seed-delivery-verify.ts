/**
 * AN EDIT TO A SEED TEMPLATE THAT CANNOT REACH THE RUNTIME (feature_compose verify rule; pure).
 *
 * How a seed reaches a running substrate (src/seed/deliver.ts): a cold start bulk-uploads every seed, but on a POPULATED
 * catalogue — every running node — upsertVersionBumpedSeeds re-uploads a seed only when its metadata.seed_version rises
 * above the registered row's, and skips a seed whose seed_version is absent or not positive. So a draft that changes an
 * exported ActivityTemplate's tasks (its resolvers, their config) under src/seed/ without raising metadata.seed_version
 * lands, typechecks, and can pass a check that reads the template's literals, while changing nothing any node runs.
 *
 * THE RULE, for each file under src/seed/ the draft edited or created, over its exported templates
 * (`export const NAME: ActivityTemplate = { … }`, or the same without the annotation when the object has a `tasks:`
 * member):
 *   - a template present before and after whose `tasks:` array text changed (comments and whitespace ignored) must carry
 *     a metadata.seed_version strictly greater than before (absent = 0);
 *   - a NEW template (absent before: added to an existing seed file, or in a new file) must carry a positive
 *     metadata.seed_version. A cold-start (empty) catalogue bulk-seeds every template, so the rule is about POPULATED
 *     catalogues, which every running node has: there delivery treats an absent seed as version 0 and uploads it only
 *     when its seed_version is >= 1.
 * Otherwise verify fails with seedDeliveryReason. Templates whose tasks did not change, and every file outside
 * src/seed/, are not judged.
 *
 * Static and textual on purpose (no draft code is executed). Known limits: a template built by a function call or
 * spread from another object is not recognised (not judged); a seed_version computed from an expression reads as 0.
 */

export type SeedEdit = { path: string; pre: string; post: string };
export type SeedDeliveryRefusal = { path: string; template: string; before: number; after: number; added?: true };

const SEED_DIR_RE = /(?:^|\/)src\/seed\//;

/** The vessel-relative path of a draft path, or the path itself (repos/<vessel>/… and absolute roots trimmed to src/…). */
function seedRel(path: string): string | null {
  const m = /(?:^|\/)(src\/seed\/.+)$/.exec(path.replace(/\\/g, "/"));
  return m ? m[1]! : null;
}

/** Strip comments, keeping string contents intact. */
function stripComments(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!, n = src[i + 1];
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i++; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const q = c; out += c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === "\\") { out += src[i]!; i++; } out += src[i] ?? ""; i++; }
      out += q; continue;
    }
    out += c;
  }
  return out;
}

/** The balanced text from the bracket at `open` (inclusive) to its match, skipping strings; null when unbalanced. */
function balanced(src: string, open: number): string | null {
  const pairs: Record<string, string> = { "{": "}", "[": "]", "(": ")" };
  const stack: string[] = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") { const q = c; i++; while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; } continue; }
    if (pairs[c]) stack.push(pairs[c]!);
    else if (c === "}" || c === "]" || c === ")") { if (stack.pop() !== c) return null; if (stack.length === 0) return src.slice(open, i + 1); }
  }
  return null;
}

/** Top-level member `key:` of an object literal's text (depth 1), as the balanced text of its value's bracket. */
function memberBracket(obj: string, key: string): string | null {
  let depth = 0;
  for (let i = 0; i < obj.length; i++) {
    const c = obj[i]!;
    if (c === '"' || c === "'" || c === "`") { const q = c; i++; while (i < obj.length && obj[i] !== q) { if (obj[i] === "\\") i++; i++; } continue; }
    if (c === "{" || c === "[" || c === "(") { depth++; continue; }
    if (c === "}" || c === "]" || c === ")") { depth--; continue; }
    if (depth !== 1) continue;
    const m = new RegExp(`^${key}\\s*:\\s*`).exec(obj.slice(i));
    if (m && !/[\w$]/.test(obj[i - 1] ?? "")) {
      const at = i + m[0].length;
      return obj[at] === "[" || obj[at] === "{" ? balanced(obj, at) : null;
    }
  }
  return null;
}

/** Exported templates of a seed file: name -> { tasks text (normalised), seed_version }. */
export function seedTemplates(src: string): Map<string, { tasks: string; seed_version: number }> {
  const code = stripComments(src);
  const out = new Map<string, { tasks: string; seed_version: number }>();
  for (const m of code.matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*(:\s*ActivityTemplate\s*)?=\s*\{/g)) {
    const obj = balanced(code, m.index! + m[0].length - 1);
    if (!obj) continue;
    const tasks = memberBracket(obj, "tasks");
    if (tasks === null) continue;
    const meta = memberBracket(obj, "metadata");
    const sv = meta ? /(?:^|[^\w$])seed_version\s*:\s*(\d+)\b/.exec(meta)?.[1] : undefined;
    out.set(m[1]!, { tasks: tasks.replace(/\s+/g, ""), seed_version: sv ? Number(sv) : 0 });
  }
  return out;
}

/** Every template whose tasks changed in an edited src/seed/ file without a seed_version bump. Empty = nothing to refuse. */
export function seedDeliveryRefusals(edits: ReadonlyArray<SeedEdit>): SeedDeliveryRefusal[] {
  const out: SeedDeliveryRefusal[] = [];
  for (const e of edits) {
    const rel = seedRel(e.path);
    if (!rel || !SEED_DIR_RE.test(rel)) continue;
    const before = seedTemplates(e.pre ?? ""), after = seedTemplates(e.post);
    for (const [name, a] of after) {
      const b = before.get(name);
      // A NEW template (added to an existing seed file, or in a new one) must carry a positive seed_version: a populated
      // catalogue's delivery skips a seed whose seed_version is absent or <= 0 (a cold start bulk-seeds it regardless).
      if (!b) { if (!(a.seed_version > 0)) out.push({ path: rel, template: name, before: 0, after: a.seed_version, added: true }); continue; }
      if (a.tasks === b.tasks) continue;
      if (!(a.seed_version > b.seed_version)) out.push({ path: rel, template: name, before: b.seed_version, after: a.seed_version });
    }
  }
  return out;
}

/** Whether any edited path is a seed file (the rule has nothing to say, and says nothing, otherwise). */
export function touchesSeed(paths: ReadonlyArray<string>): boolean {
  return paths.some((p) => seedRel(p) !== null);
}

export function seedDeliveryReason(r: ReadonlyArray<SeedDeliveryRefusal>): string {
  const list = r.slice(0, 3).map((x) => x.added ? `new template ${x.template} in ${x.path} (metadata.seed_version ${x.after || "absent"})` : `${x.template} in ${x.path} (metadata.seed_version ${x.before} -> ${x.after})`).join("; ");
  return `THE SEED TEMPLATE EDIT ${list}${r.length > 3 ? ` +${r.length - 3}` : ""}: cannot reach the runtime: seed delivery re-uploads only on a seed_version bump (on a populated catalogue, every running node's, a changed template is kept as registered and a new one is never uploaded without seed_version >= 1; only a cold-start catalogue bulk-seeds). Raise metadata.seed_version above its current value in the same edit (add metadata: { seed_version: 1 } to a template that has none).`;
}
