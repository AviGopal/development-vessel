// CLASS CHECK: every field KEY a published resolver contract declares has a reader in src/.
//
// src/resolvers/resolver-schema.ts publishes payload contracts (the `resolver_schema` shape) that
// goal-host reads at invocation time. A contract field descriptor is an object such as
//   { name: "prompt", required: true, type: "string" }
// and each of its KEYS is a promise that something acts on it. A key nothing reads is a hollow
// declaration: callers are told a field matters (e.g. `synthesize_from` provenance) while no code
// anywhere consumes it, so the contract claims a behaviour the system does not have.
//
// THE PREDICATE. Keys are collected from resolver-schema.ts by the TypeScript AST, from BOTH
//   (a) the object literals inside every `fields: [...]` array (the published contract entries), and
//   (b) the property signatures of every `fields: Array<{...}>` type literal (the declared shape),
// so removing a key from the entries while the type still declares it stays red.
// A key is READ when some file under src/ (tests and *.d.ts excluded) has a property access `.key` /
// `?.key`, an element access `["key"]`, or a destructuring binding `{ key }` / `{ key: x }`.
// Comments, strings and the declarations themselves never count: the predicate is on the AST, and a
// declaration is a property assignment or signature, never an access. resolver-schema.ts is scanned
// too, for its LOGIC only: `required`'s one in-vessel reader is resolver-schema.ts deriving the
// published `required` list from `f.required` (its wire reader is goal-host). Excluding the whole file
// would call that real consumer hollow; excluding only declarations keeps the check honest.
//
// REPORTING. For every key the test prints the predicate, an equivalent grep, and the hits it found
// (file:line), so a pass is inspectable and a red names exactly what was measured.
//
// KNOWN WEAKNESS. Generic keys (name, type, required) are read all over src/ for unrelated reasons,
// so their pass is weak evidence; the check bites on keys specific to the contract vocabulary.
import { describe, it, expect } from "bun:test";
import ts from "typescript";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const SRC_ROOT = resolve(import.meta.dir, "../../src");
const SCHEMA_REL = "resolvers/resolver-schema.ts";

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTs(p));
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const parse = (path: string): ts.SourceFile =>
  ts.createSourceFile(path, readFileSync(path, "utf-8"), ts.ScriptTarget.Latest, true);

const propName = (n: ts.PropertyName | ts.BindingName | undefined): string | undefined =>
  n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : undefined;

/** Field-descriptor keys declared in a contract file: `fields: [{…}]` entries and `fields: Array<{…}>` types. */
export function contractFieldKeys(schemaPath: string): Map<string, number[]> {
  const sf = parse(schemaPath);
  const keys = new Map<string, number[]>();
  const add = (k: string | undefined, at: ts.Node): void => {
    if (!k) return;
    const line = sf.getLineAndCharacterOfPosition(at.getStart()).line + 1;
    keys.set(k, [...(keys.get(k) ?? []), line]);
  };
  const visit = (n: ts.Node): void => {
    // (a) published entries
    if (ts.isPropertyAssignment(n) && propName(n.name) === "fields" && ts.isArrayLiteralExpression(n.initializer)) {
      for (const el of n.initializer.elements) {
        if (!ts.isObjectLiteralExpression(el)) continue;
        for (const p of el.properties) {
          if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) add(propName(p.name), p);
        }
      }
    }
    // (b) declared field type
    if (ts.isPropertySignature(n) && propName(n.name) === "fields" && n.type) {
      const lits: ts.TypeLiteralNode[] = [];
      const findLit = (t: ts.Node): void => {
        if (ts.isTypeLiteralNode(t)) { lits.push(t); return; }
        ts.forEachChild(t, findLit);
      };
      findLit(n.type);
      for (const lit of lits) for (const m of lit.members) if (ts.isPropertySignature(m)) add(propName(m.name), m);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return keys;
}

export type ReaderHit = { file: string; line: number; form: "access" | "element" | "destructure" };

/** Every read of `key` under srcRoot (declarations are never reads). */
export function readersOf(key: string, srcRoot: string): ReaderHit[] {
  const hits: ReaderHit[] = [];
  for (const path of listTs(srcRoot)) {
    const rel = relative(srcRoot, path);
    const sf = parse(path);
    const at = (n: ts.Node, form: ReaderHit["form"]): void => {
      hits.push({ file: rel, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, form });
    };
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAccessExpression(n) && n.name.text === key) at(n, "access");
      else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === key) at(n, "element");
      else if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent) && (propName(n.propertyName) ?? propName(n.name)) === key) at(n, "destructure");
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return hits;
}

const grepFor = (key: string): string =>
  `grep -rnE '(\\??\\.${key}\\b|\\[["'\\'']${key}["'\\'']\\]|\\{[^}]*\\b${key}\\b[^}]*\\}\\s*=)' src --include=*.ts --exclude=*.test.ts`;

function report(srcRoot: string, schemaRel: string): Array<{ key: string; declaredAt: number[]; hits: ReaderHit[] }> {
  const keys = contractFieldKeys(join(srcRoot, schemaRel));
  return [...keys.entries()].map(([key, declaredAt]) => ({ key, declaredAt, hits: readersOf(key, srcRoot) }));
}

describe("contract field readers: every resolver-contract field key has a reader in src/", () => {
  const rows = report(SRC_ROOT, SCHEMA_REL);

  it("every declared field key has a reader in src/", () => {
    console.log(
      "contract-field-readers — predicate: AST property access .k / ?.k, element access [\"k\"], or destructuring { k } in src/**/*.ts, excluding *.test.ts and *.d.ts (declarations are not reads)",
    );
    for (const r of rows) {
      const shown = r.hits.slice(0, 5).map((h) => `${h.file}:${h.line}(${h.form})`).join(", ");
      console.log(
        `  key=${r.key} declared=${SCHEMA_REL}:${r.declaredAt.join(",")} readers=${r.hits.length}${r.hits.length ? ` [${shown}${r.hits.length > 5 ? ", …" : ""}]` : ""}\n    grep: ${grepFor(r.key)}`,
      );
    }
    const unread = rows.filter((r) => r.hits.length === 0).map((r) => `${r.key} (declared ${SCHEMA_REL}:${r.declaredAt.join(",")}; grep: ${grepFor(r.key)})`);
    expect(unread, "contract field keys with no reader in src/ — a field nothing consumes is a hollow promise").toEqual([]);
  });

  // POSITIVE CONTROL: a collector that sees nothing reports nothing unread.
  it("sees the contract's field keys (a collector that finds none cannot pass)", () => {
    const keys = rows.map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(["name", "required", "type"]));
  });

  it("flags an unread key and passes a read one, in entries and in the declared type (fixture)", () => {
    const dir = mkdtempSync(join(tmpdir(), "contract-readers-"));
    mkdirSync(join(dir, "resolvers"), { recursive: true });
    writeFileSync(
      join(dir, "resolvers/resolver-schema.ts"),
      [
        `interface Contract { fields: Array<{ name: string; read_by_access: string; read_by_element?: string; type_only_unread?: string; }> }`,
        `const C: Record<string, Contract> = {`,
        `  s: { fields: [{ name: "a", read_by_access: "x", read_by_element: "y", read_by_destructure: 1, entry_only_unread: "z" }] },`,
        `};`,
        `export const own = C.s.fields.filter((f) => f.name); // contract-file logic reads count; its declarations do not`,
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "consumer.ts"),
      [
        `// a comment naming .type_only_unread is not a read`,
        `export function use(f: Record<string, unknown>) {`,
        `  const s = "f.entry_only_unread"; // nor is a string`,
        `  const { read_by_destructure } = f as { read_by_destructure: number };`,
        `  return [f.name, (f as { read_by_access?: string })?.read_by_access, f["read_by_element"], read_by_destructure, s];`,
        `}`,
      ].join("\n"),
    );
    const got = report(dir, "resolvers/resolver-schema.ts").map((r) => [r.key, r.hits.length > 0]);
    expect(Object.fromEntries(got)).toEqual({
      name: true,
      read_by_access: true,
      read_by_element: true,
      type_only_unread: false,
      read_by_destructure: true,
      entry_only_unread: false,
    });
  });
});
