// LINK 5 / ADDENDUM 4 EVENT CLASSES, PORTED: the research watcher's test_link5 cases (classify_event on gapWriteEvent
// rows, dv 971eb78f schema), run against operator-acts.ts classifyGapWriteEvent.
//
// PUBLIC REPO: the frozen case names quote live key ids and node names, so each case is named by its frozen id's sha256
// prefix (fixtures-manifest.json) and a public title, and the keys are SYNTHETIC stand-ins with the same structure as
// the frozen run's class map: a gapWriteEvent names a key by its first 6 characters, the map lists masked 9-character
// ids, each listed key has its own 6-character prefix, and two listed keys sharing one are ambiguous. Roles, not names:
// key_Oa the cockpit operator key, key_Oc a revoked operator key, key_Oe the scope-tighten key (operator-class), key_Sa
// the node's default key, key_Pa the forwarding node's read-only peer key, key_Pb the key the forwarding node's writes
// reach the holder under.
import { describe, expect, it } from "bun:test";
import { classifyGapWriteEvent, keyClass6, type GapWriteEventLike, type KeyMapEntry } from "../../src/resolvers/operator-acts.js";

const OPERATOR = ["key_Oa1xp", "key_Ob05q", "key_Oc9Lz", "key_OdinC", "key_Oeb_T"];
const SYSTEM = ["key_Sa1Ur", "key_SbkWs", "key_PaxIb", "key_PbKaJ", "key_ScnTf", "key_Sd1eW", "key_Se0bw"];
const STATIC: KeyMapEntry[] = [...OPERATOR.map((id) => ({ id, owner_kind: "operator" })), ...SYSTEM.map((id) => ({ id, owner_kind: "system" }))];
const PEERS6 = ["key_Pa", "key_Pb"];
const ev = (k: Partial<GapWriteEventLike>): GapWriteEventLike => ({ gap_id: "g", outcome: "written", store: "local", ...k });
const run = (e: GapWriteEventLike, source: "holder" | "origin", originPresent: boolean, km: KeyMapEntry[] | null) => classifyGapWriteEvent(e, source, originPresent, km ?? STATIC, PEERS6);

// [frozen sha256 prefix, public title, event, source, origin file present, want (prefix), keymap or null for STATIC, exact]
type Case = [string, string, GapWriteEventLike, "holder" | "origin", boolean, string, KeyMapEntry[] | null, string];
const CASES: Case[] = [
  ["1e4f75b0d02d", "operator key: operator", ev({ principal_kind: "key", key_id: "key_Oa", operator_marker: false }), "holder", false, "operator", null, "operator"],
  ["336903fe9843", "operator marker on a system key: operator", ev({ principal_kind: "key", key_id: "key_Sa", operator_marker: true }), "holder", false, "operator", null, "operator"],
  ["c88c014371f3", "revoked operator key: operator", ev({ principal_kind: "key", key_id: "key_Oc", operator_marker: false }), "holder", false, "operator", null, "operator"],
  ["6dd3d962e572", "scope-tighten key (operator-class): operator", ev({ principal_kind: "key", key_id: "key_Oe", operator_marker: false }), "holder", false, "operator", null, "operator"],
  ["71a2b0936741", "node-self: system", ev({ principal_kind: "node-self", key_id: null, operator_marker: false }), "holder", false, "system", null, "system"],
  ["235dc20bb171", "system key: system", ev({ principal_kind: "key", key_id: "key_Sa", operator_marker: false }), "holder", false, "system", null, "system"],
  ["70bba7a22f55", "holder: forwarded via the peer key, no origin file: unattributable", ev({ principal_kind: "key", key_id: "key_Pa", operator_marker: false, store: "local" }), "holder", false, "unattributable", null, "unattributable(forwarded via peer key key_Pa; origin file absent)"],
  ["36cc0e6a5a0e", "holder: forwarded via the peer key, origin file present -> origin decides", ev({ principal_kind: "key", key_id: "key_Pa", operator_marker: false }), "holder", true, "forwarded", null, "forwarded(origin event decides)"],
  ["ed8069055f58", "holder: forwarded via the forwarder's write key, origin present -> origin decides, NOT system", ev({ principal_kind: "key", key_id: "key_Pb", operator_marker: false }), "holder", true, "forwarded", null, "forwarded(origin event decides)"],
  ["650a1410eaec", "holder: forwarded via the forwarder's write key, origin file absent", ev({ principal_kind: "key", key_id: "key_Pb", operator_marker: false }), "holder", false, "unattributable", null, "unattributable(forwarded via peer key key_Pb; origin file absent)"],
  ["88da0238668f", "origin event: operator key -> operator", ev({ principal_kind: "key", key_id: "key_Oa", operator_marker: false, store: "forwarded" }), "origin", true, "operator", null, "operator"],
  ["a0325e222ea9", "in-process (no route stamp): SYSTEM, unobserved principal (addendum 4)", ev({ principal_kind: "in-process", key_id: null, operator_marker: false }), "holder", false, "system", null, "system(unobserved principal: in-process)"],
  ["36fef922d665", "in-process on the forwarding node (forwarded origin): SYSTEM, unobserved (addendum 4)", ev({ principal_kind: "in-process", key_id: null, operator_marker: false, store: "forwarded" }), "origin", true, "system", null, "system(unobserved principal: in-process)"],
  ["e35dfef52aa1", "unauthenticated: unattributable", ev({ principal_kind: "unauthenticated", key_id: null, operator_marker: false }), "origin", true, "unattributable", null, "unattributable(unauthenticated:-)"],
  ["9a2e64e4dd56", "unknown key: unattributable", ev({ principal_kind: "key", key_id: "key_ZZ", operator_marker: false }), "holder", false, "unattributable", null, "unattributable(key:key_ZZ)"],
  ["975d1b58c2aa", "a 6-char event id matches its 9-char map id by prefix (an old 9-char class never would): operator", ev({ principal_kind: "key", key_id: "key_Oa", operator_marker: false }), "holder", false, "operator", null, "operator"],
  ["17db69aa6581", "AMBIGUOUS: two listed keys share the prefix (operator + system) -> never first match", ev({ principal_kind: "key", key_id: "key_Oa", operator_marker: false }), "holder", false, "unattributable", [{ id: "key_Oa1xp", owner_kind: "operator" }, { id: "key_Oazzz", owner_kind: "system" }], "unattributable(ambiguous 6-char key prefix key_Oa)"],
  ["81c8b74a4532", "AMBIGUOUS same class: two operator keys share the prefix", ev({ principal_kind: "key", key_id: "key_Ob", operator_marker: false }), "holder", false, "unattributable", [{ id: "key_Ob05q", owner_kind: "operator" }, { id: "key_Obxyz", owner_kind: "operator" }], "unattributable(ambiguous 6-char key prefix key_Ob)"],
  ["f2d9efa2b5c8", "ROTATED: a new key not in the map reads unattributable", ev({ principal_kind: "key", key_id: "key_Rn", operator_marker: false }), "holder", false, "unattributable", null, "unattributable(key:key_Rn)"],
  ["331929140ea5", "ROTATED map: the same new key listed as operator in a refreshed map", ev({ principal_kind: "key", key_id: "key_Rn", operator_marker: false }), "holder", false, "operator", [{ id: "key_Rn123", owner_kind: "operator" }, { id: "key_Sa1Ur", owner_kind: "system" }], "operator"],
];

describe("test_link5 (20 frozen cases; synthetic keys, public titles)", () => {
  it("ports every frozen case exactly once", () => {
    expect(CASES.length).toBe(20);
    expect(new Set(CASES.map((c) => c[0])).size).toBe(20);
  });
  CASES.forEach(([sha, title, e, source, origin, want, km, exact], i) => {
    it(`link5#${String(i + 1).padStart(2, "0")} [${sha}] ${title}`, () => {
      const got = run(e, source, origin, km);
      expect(got.startsWith(want)).toBe(true);
      expect(got).toBe(exact);
    });
  });
});

describe("the synthetic map keeps the frozen run's structure", () => {
  it("each listed key has its own 6-character prefix, so only a planted twin makes one ambiguous", () => {
    expect(new Set(STATIC.map((k) => k.id.slice(0, 6))).size).toBe(STATIC.length);
    expect(keyClass6("key_Oa", STATIC)).toBe("operator");
    expect(keyClass6("key_Oa", [...STATIC, { id: "key_Oazzz", owner_kind: "system" }])).toBe("ambiguous");
    expect(keyClass6("key_ZZ", STATIC)).toBeNull();
  });
});
