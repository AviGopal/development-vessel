import { describe, it, expect } from "bun:test";
import {
  enclosingTopLevelSymbol,
  draftReachability,
  type ReachabilityFact,
} from "../../src/resolvers/feature-compose.js";

// The resolver places each caller line the reachability grep returns inside its enclosing top-level symbol, so the
// semantic gate can tell a real caller from a reference inside the draft's own added code (draftReachability).

const FILE = [
  "import { x } from './x.js';",                                                        // 1
  "",                                                                                   // 2
  "export function parseOps(v: unknown): number | null {",                              // 3
  "  if (typeof v === 'string') {",                                                     // 4
  "    try { return parseOps(JSON.parse(v)); } catch { /* ignore */ }",                 // 5
  "  }",                                                                                // 6
  "  return null;",                                                                     // 7
  "}",                                                                                  // 8
  "",                                                                                   // 9
  "app.post('/ops', (req) => {",                                                        // 10
  "  return parseOps(req.body);",                                                       // 11
  "});",                                                                                // 12
  "export const one = () => parseOps('1');",                                            // 13
  "class Runner {",                                                                     // 14
  "  // a comment",                                                                     // 15
  "  run() { return parseOps(2); }",                                                    // 16
  "}",                                                                                  // 17
  "}",                                                                                  // 18
  "  parseOps(3);",                                                                     // 19
].join("\n");

describe("enclosingTopLevelSymbol", () => {
  it("a recursive call is enclosed by the function itself", () => {
    expect(enclosingTopLevelSymbol(FILE, 5)).toBe("parseOps");
  });
  it("a call inside a column-0 route registration is module scope (a real caller)", () => {
    expect(enclosingTopLevelSymbol(FILE, 11)).toBeNull();
  });
  it("a one-line declaration encloses its own body", () => {
    expect(enclosingTopLevelSymbol(FILE, 13)).toBe("one");
  });
  it("a class method's call is enclosed by the class", () => {
    expect(enclosingTopLevelSymbol(FILE, 16)).toBe("Runner");
  });
  it("an indented line after a column-0 closing brace is module scope", () => {
    expect(enclosingTopLevelSymbol(FILE, 19)).toBeNull();
  });
  it("an out-of-range or empty input places nothing", () => {
    expect(enclosingTopLevelSymbol(FILE, 0)).toBeNull();
    expect(enclosingTopLevelSymbol(FILE, 999)).toBeNull();
    expect(enclosingTopLevelSymbol("", 1)).toBeNull();
  });
});

describe("draftReachability", () => {
  const facts: ReachabilityFact[] = [
    { symbol: "a", isNewFunction: true, callerCount: 1, isEntrypoint: true, reachable: true, callerScopes: [null] },
    { symbol: "b", isNewFunction: true, callerCount: 2, isEntrypoint: false, reachable: true, callerScopes: ["b", "a"] },
    { symbol: "c", isNewFunction: true, callerCount: 1, isEntrypoint: false, reachable: true, callerScopes: ["c"] },
    { symbol: "d", isNewFunction: true, callerCount: 1, isEntrypoint: false, reachable: true, callerScopes: ["e"] },
    { symbol: "e", isNewFunction: true, callerCount: 1, isEntrypoint: false, reachable: true, callerScopes: ["d"] },
    { symbol: "f", isNewFunction: true, callerCount: 2, isEntrypoint: false, reachable: true, callerScopes: ["f"] },
    { symbol: "g", isNewFunction: true, callerCount: 1, isEntrypoint: false, reachable: true },
    { symbol: "h", isNewFunction: false, callerCount: 0, isEntrypoint: true, reachable: true, callerScopes: [] },
  ];
  const out = new Map(draftReachability(facts).map((f) => [f.symbol, f.reachable]));

  it("a module-scope caller makes a symbol live, and liveness flows through added callers", () => {
    expect(out.get("a")).toBe(true);
    expect(out.get("b")).toBe(true);
  });
  it("self-reference alone, or a cycle of added symbols, is not live", () => {
    expect(out.get("c")).toBe(false);
    expect(out.get("d")).toBe(false);
    expect(out.get("e")).toBe(false);
  });
  it("a caller line that could not be placed counts as a real caller", () => {
    expect(out.get("f")).toBe(true);
  });
  it("facts without scopes, and facts not added by the draft, are unchanged", () => {
    expect(out.get("g")).toBe(true);
    expect(out.get("h")).toBe(true);
  });
  it("is idempotent", () => {
    const twice = draftReachability(draftReachability(facts));
    expect(twice.map((f) => f.reachable)).toEqual(draftReachability(facts).map((f) => f.reachable));
  });
});
