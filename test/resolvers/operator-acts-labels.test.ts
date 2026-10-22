// THE STRICT ORACLE-LABEL RULE, PORTED: the research watcher's test_labels cases (classify_label, qa 10-21), run against
// operator-acts.ts classifyOracleLabel. A label's (labeler, source) pair is caller-chosen and forgeable, so a label
// before the server-set principal converged reads review; after it, the stored principal decides.
//
// PUBLIC REPO: the frozen case names quote live key ids and node names, so each case is named by its frozen id's sha256
// prefix (fixtures-manifest.json) and a public title, and the keys are SYNTHETIC stand-ins with the frozen map's
// structure: masked 9-character ids matched by prefix to 12-character label principals; key_Pb (the forwarding node's
// write key), key_Pa (its read-only peer key) and key_Sa (the node default key) are FORWARDING keys; key_Rv a revoked
// peer key (forwarding, unlisted); key_Sc the node's own bootstrap admin key; key_Sb a vessel key; key_CoybO and
// key_Co2Dr two system keys whose 6-character prefixes collide (the second also forwarding).
import { describe, expect, it } from "bun:test";
import { classifyOracleLabel, type KeyMapEntry, type LabelClassContext, type OracleLabelLike } from "../../src/resolvers/operator-acts.js";

const OPERATOR = ["key_Oa1xp", "key_Ob05q", "key_Oc9Lz", "key_OdinC", "key_Oeb_T"];
const SYSTEM = ["key_Sa1Ur", "key_SbkWs", "key_PaxIb", "key_PbKaJ", "key_ScnTf", "key_Sd1eW", "key_Se0bw"];
const KM: KeyMapEntry[] = [...OPERATOR.map((id) => ({ id, owner_kind: "operator" })), ...SYSTEM.map((id) => ({ id, owner_kind: "system" })), { id: "key_CoybO", owner_kind: "system" }, { id: "key_Co2Dr", owner_kind: "system" }];
const FORWARDING = ["key_PbKaJ", "key_PaxIb", "key_Sa1Ur", "key_Rv1QY", "key_Co2Dr"];
const FIX = "2026-10-21T12:30:00Z";
const ctx = (fixLiveAt: string): LabelClassContext => ({ fixLiveAt, keymap: KM, forwardingKeys: FORWARDING, nodeSelfAdminKeys: ["key_ScnTf"] });
const B = { labeler: "deterministic", source: null } as const;

// [frozen sha256 prefix, public title, label, fix live at ("" = not yet), want (prefix)]
type Case = [string, string, OracleLabelLike, string, string];
const CASES: Case[] = [
  ["480b35d07ac1", "before fix: (deterministic, null) — forgeable => REVIEW", { ...B, created_at: "2026-10-21T04:00:00Z" }, "", "review"],
  ["6ec84ff42847", "before fix: (automated, judge-abstain-cut-view) => REVIEW", { labeler: "automated", source: "judge-abstain-cut-view", created_at: "2026-10-21T04:00:00Z" }, "", "review"],
  ["535618c7ed29", "POSITIVE CONTROL: cockpit provide_feedback (automated, null) => REVIEW", { labeler: "automated", source: null, created_at: "2026-10-21T04:00:00Z" }, "", "review"],
  ["8b20221d063e", "fix live, label BEFORE it => still REVIEW", { ...B, created_at: "2026-10-21T12:00:00Z", principal_kind: "node-self" }, FIX, "review"],
  ["9116eaa02d98", "fix live: kind outside the server enum (node-self) => REVIEW, never assumed system", { ...B, created_at: "2026-10-21T13:00:00Z", principal_kind: "node-self" }, FIX, "review"],
  ["0d51edb2085d", "fix live, label after, operator key => OPERATOR (assisted)", { labeler: "automated", source: null, created_at: "2026-10-21T13:00:00Z", principal_kind: "key", principal_key_id: "key_Oa1xpXyZ" }, FIX, "operator"],
  ["75b0125f06dd", "fix live, label after, a vessel key => SYSTEM", { ...B, created_at: "2026-10-21T13:00:00Z", principal_kind: "key", principal_key_id: "key_SbkWsXyZ" }, FIX, "system"],
  ["412d046ea00e", "fix live: the forwarding node's write key => REVIEW (forwarded)", { labeler: "automated", source: null, created_at: "2026-10-21T13:00:00Z", principal_kind: "key", principal_key_id: "key_PbKaJXyZ" }, FIX, "review"],
  ["f64b99e73e04", "fix live: node default key => REVIEW (forwarded)", { labeler: "automated", source: null, created_at: "2026-10-21T13:00:00Z", principal_kind: "key", principal_key_id: "key_Sa1UrXyZ" }, FIX, "review"],
  ["17b47f47d84b", "fix live: admin, operator admin key => OPERATOR", { labeler: "automated", source: null, created_at: "2026-10-21T13:00:00Z", principal_kind: "admin", principal_key_id: "key_Oa1xpXyZ" }, FIX, "operator"],
  ["4fbde51dd3a8", "fix live: admin, the node-self admin key => SYSTEM", { labeler: "automated", source: null, created_at: "2026-10-21T13:00:00Z", principal_kind: "admin", principal_key_id: "key_ScnTfXyZ" }, FIX, "system"],
  ["0dc24271ab60", "fix live: session (a person) => OPERATOR", { labeler: "human", source: null, created_at: "2026-10-21T13:00:00Z", principal_kind: "session", principal_key_id: null }, FIX, "operator"],
  ["fc4904d807ed", "fix live: a revoked peer key on an old row => REVIEW (forwarded)", { labeler: "automated", source: null, created_at: "2026-10-21T13:00:00Z", principal_kind: "key", principal_key_id: "key_Rv1QYxxx" }, FIX, "review"],
  ["2177e1d238f5", "fix live: obo => REVIEW", { labeler: "automated", source: null, created_at: "2026-10-21T13:00:00Z", principal_kind: "obo", principal_key_id: "key_SbkWsXyZ" }, FIX, "review"],
  ["e62451fac040", "fix live, label after, unlisted key => REVIEW", { labeler: "automated", source: null, created_at: "2026-10-21T13:00:00Z", principal_kind: "key", principal_key_id: "key_ZZZZZZZZ" }, FIX, "review"],
  ["99533888233f", "fix live: a 12-char id separates a 6-char collision between two listed keys", { labeler: "automated", source: null, created_at: "2026-10-21T13:00:00Z", principal_kind: "key", principal_key_id: "key_CoybOabc" }, FIX, "system"],
  ["a433d865f0a4", "SAME SECOND as cut-over with fractional secs (nanosecond precision) => after, decided by principal", { ...B, created_at: "2026-10-21T12:30:00.476802471Z", principal_kind: "key", principal_key_id: "key_SbkWs" }, FIX, "system"],
  ["f195d61fa03f", "principal_kind null (pre-migration row) => REVIEW", { ...B, created_at: "2026-10-21T13:00:00Z", principal_kind: null, principal_key_id: null }, FIX, "review"],
  ["9bf4abe68b7f", "fix live, label after, no principal field => REVIEW", { labeler: "automated", source: null, created_at: "2026-10-21T13:00:00Z" }, FIX, "review"],
];

describe("test_labels (19 frozen cases; synthetic keys, public titles)", () => {
  it("ports every frozen case exactly once", () => {
    expect(CASES.length).toBe(19);
    expect(new Set(CASES.map((c) => c[0])).size).toBe(19);
  });
  CASES.forEach(([sha, title, lab, fix, want], i) => {
    it(`labels#${String(i + 1).padStart(2, "0")} [${sha}] ${title}`, () => {
      expect(classifyOracleLabel(lab, ctx(fix)).startsWith(want)).toBe(true);
    });
  });
  it("the reasons the frozen run printed, at the same words", () => {
    expect(classifyOracleLabel(CASES[0]![2], ctx(""))).toBe("review(label deterministic/None before the server-set principal: caller-declared, unattributable — strict rule)");
    expect(classifyOracleLabel(CASES[4]![2], ctx(FIX))).toBe("review(label principal node-self)");
    expect(classifyOracleLabel(CASES[7]![2], ctx(FIX))).toBe("review(label via peer/node key key_PbKaJXyZ: forwarded, true writer unknown)");
    expect(classifyOracleLabel(CASES[11]![2], ctx(FIX))).toBe("operator(label by a person's session — human feedback)");
    expect(classifyOracleLabel(CASES[14]![2], ctx(FIX))).toBe("review(label principal key key_ZZZZZZZZ: unlisted)");
  });
});
