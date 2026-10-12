// PROTECTED: the routing corpus runner's compare, classify and guard logic (DESIGN §4.4, §9), each shown red on a
// mutant before it is trusted:
//   - compare: a key of `expect` that differs is a mismatch; keys `expect` does not name are free;
//   - guards: an entry that reads the clock or randomness is nondeterministic; one that fetches is red; an unknown entry
//     is entry_missing; a hung entry is red at the wall cap;
//   - append-check: a case whose status_at_append differs from what the tree observes is a mismatch, both ways;
//   - an empty or absent manifest, a tampered case, an unlisted file and a non-canonical file are chain problems;
//   - no protected routing test carries a skip, a todo or an environment condition (a silent skip reads as a pass).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCheck, canonical, ENTRIES, manifestLine, matches, replayCase, sha256, verifyChain, GENESIS, type RoutingCase } from "./runner";

const HERE = import.meta.dir;
const TMP = join(tmpdir(), `routing-runner-logic-${process.pid}-${Math.floor(performance.now())}`);
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const base = (over: Partial<RoutingCase> = {}): RoutingCase => ({
  schema: 1, id: "0001-x", class: "x", entry: "composeAdmission", credit_class: null, edit_site: "repos/development-vessel/src/judge-rules/routing-admission.ts",
  provenance: { source: "class-paraphrase", recorded: "2026-10-12", note: "runner-logic fixture" },
  input: { schema: 1, entry: "composeAdmission", gap_id: "gap-x", lane: "undirected", land: true, supply_marker: false, stored: "present", operator_hold: true, why: null, supply_verdict: null, edit_site: null, scope: null },
  ports: {}, llm: null,
  expect: { admit: false, refusal: { stage: "operator_hold", verdict: "BUSY", excluded_by: null } },
  status_at_append: "green", control: true, licenses: null, ...over,
});

/** A throwaway corpus at `dir` holding `cases`, chained. */
function corpus(dir: string, cases: RoutingCase[]): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "MANIFEST.jsonl"), "");
  let prev = GENESIS;
  cases.forEach((c, i) => {
    const id = `${String(i + 1).padStart(4, "0")}-${c.class}`;
    const cc = { ...c, id };
    const rel = `cases/${c.class}/${id}.json`;
    mkdirSync(join(dir, "cases", c.class), { recursive: true });
    const bytes = canonical(cc);
    writeFileSync(join(dir, rel), bytes);
    const line = manifestLine(i + 1, id, rel, sha256(bytes), prev);
    appendFileSync(join(dir, "MANIFEST.jsonl"), JSON.stringify(line) + "\n");
    prev = line.link;
  });
}

describe("compare", () => {
  test("equal on every expected key matches; other keys are free", () => {
    expect(matches({ route: "walk", target: null }, { route: "walk", target: null, needs_localization: true })).toBe(true);
  });
  test("MUTANT one differing key is a mismatch", () => {
    expect(matches({ route: "walk", target: null }, { route: "feature_compose", target: null })).toBe(false);
    expect(matches({ target: null }, { target: "repos/v/src/x.ts" })).toBe(false);
    expect(matches({ route: "walk" }, null)).toBe(false);
  });
});

describe("guards", () => {
  test("positive control: a real case replays green", async () => {
    expect((await replayCase(base())).observed).toBe("green");
  });
  const withEntry = async (name: string, fn: (c: RoutingCase) => Promise<unknown>) => {
    ENTRIES[name] = fn;
    try { return await replayCase(base({ entry: name, expect: { v: 1 } })); } finally { delete ENTRIES[name]; }
  };
  test("MUTANT an entry reading the clock is nondeterministic", async () => {
    expect((await withEntry("clock", async () => ({ v: Date.now() > 0 ? 1 : 0, t: Date.now() }))).observed).toBe("nondeterministic");
  });
  test("MUTANT an entry reading randomness behind an alias is nondeterministic", async () => {
    const m = Math as unknown as Record<string, () => number>;
    const key = ["ran", "dom"].join("");
    expect((await withEntry("rand", async () => ({ v: 1, r: m[key]!() }))).observed).toBe("nondeterministic");
  });
  test("MUTANT an entry that fetches is red", async () => {
    const r = await withEntry("net", async () => { await fetch("http://127.0.0.1:9/"); return { v: 1 }; });
    expect(r.observed).toBe("red");
  });
  test("MUTANT an entry that hangs is red at the wall cap", async () => {
    const r = await withEntry("hang", () => new Promise(() => {}));
    expect(r.observed).toBe("red");
    expect(r.reason).toMatch(/exceeded/);
  });
  test("an unknown entry is entry_missing, not an error", async () => {
    expect((await replayCase(base({ entry: "notAnEntry" }))).observed).toBe("entry_missing");
  });
});

describe("append-check", () => {
  test("positive control: correct statuses pass", async () => {
    const d = join(TMP, "ok");
    corpus(d, [base(), base({ class: "y", expect: { admit: true }, status_at_append: "known_red", control: false })]);
    const r = await appendCheck(d, 1);
    expect(r.mismatches).toEqual([]);
    expect(r.ok).toBe(true);
  });
  test("MUTANT a red case appended as green is refused", async () => {
    const d = join(TMP, "red-as-green");
    corpus(d, [base({ expect: { admit: true } })]);
    expect((await appendCheck(d, 1)).ok).toBe(false);
  });
  test("MUTANT a green case appended as known_red is refused", async () => {
    const d = join(TMP, "green-as-red");
    corpus(d, [base({ status_at_append: "known_red" })]);
    expect((await appendCheck(d, 1)).ok).toBe(false);
  });
  test("--from skips earlier cases", async () => {
    const d = join(TMP, "from");
    corpus(d, [base({ expect: { admit: true } }), base({ class: "y" })]);
    expect((await appendCheck(d, 2)).ok).toBe(true);
  });
});

describe("chain problems", () => {
  test("MUTANT an empty manifest is a problem", () => {
    const d = join(TMP, "empty");
    corpus(d, []);
    expect(verifyChain(d).problems.length).toBeGreaterThan(0);
  });
  test("MUTANT an absent manifest is a problem", () => {
    expect(verifyChain(join(TMP, "nowhere")).problems.length).toBeGreaterThan(0);
  });
  test("MUTANT an edited case (re-canonicalised, manifest unchanged) is a problem", () => {
    const d = join(TMP, "edit");
    corpus(d, [base()]);
    const f = join(d, "cases/x/0001-x.json");
    const c = JSON.parse(readFileSync(f, "utf8"));
    c.expect.admit = true;
    writeFileSync(f, canonical(c));
    expect(verifyChain(d).problems.join("\n")).toMatch(/sha256/);
  });
  test("MUTANT a whitespace-only edit is a problem", () => {
    const d = join(TMP, "ws");
    corpus(d, [base()]);
    const f = join(d, "cases/x/0001-x.json");
    writeFileSync(f, readFileSync(f, "utf8") + "\n");
    expect(verifyChain(d).problems.length).toBeGreaterThan(0);
  });
  test("MUTANT an unlisted case file is a problem", () => {
    const d = join(TMP, "unlisted");
    corpus(d, [base()]);
    writeFileSync(join(d, "cases/x/0002-x.json"), canonical(base({ id: "0002-x" })));
    expect(verifyChain(d).problems.join("\n")).toMatch(/not listed/);
  });
  test("MUTANT a deleted case is a problem", () => {
    const d = join(TMP, "deleted");
    corpus(d, [base(), base({ class: "y" })]);
    rmSync(join(d, "cases/y/0002-y.json"));
    expect(verifyChain(d).problems.join("\n")).toMatch(/missing/);
  });
  test("positive control: a fresh chain verifies", () => {
    const d = join(TMP, "fresh");
    corpus(d, [base(), base({ class: "y" })]);
    expect(verifyChain(d).problems).toEqual([]);
  });
});

describe("no silent skip in the protected routing tests", () => {
  const SKIP = /\b(?:test|it|describe)\s*\.\s*(?:skip|skipIf|todo|if|only)\b|\bskipIf\s*\(/;
  const files = readdirSync(HERE).filter((f) => f.endsWith(".test.ts"));
  test("there are protected test files", () => { expect(files.length).toBeGreaterThanOrEqual(5); });
  for (const f of files) {
    test(`${f} has no skip, todo, only or environment condition`, () => {
      const text = readFileSync(join(HERE, f), "utf8").replace(/const SKIP = .*\n/, "");
      expect(SKIP.test(text)).toBe(false);
    });
  }
  test("MUTANT a skipIf on the bun version is red", () => {
    const mutant = `test.${["skip", "If"].join("")}(Bun.version !== "1.3.14")("x", () => {});`;
    expect(SKIP.test(mutant)).toBe(true);
  });
});
