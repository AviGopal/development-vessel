import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateLandingScope,
  gateLanding,
  parseRemoteTarget,
  promotionIsCited,
  resolvePushPolicy,
  resolvePushPolicyWrite,
  verifyPromotionEvidence,
  type EvidenceResolvers,
  type PushPolicyBody,
} from "../../src/resolvers/push-policy.js";

const NONE: PushPolicyBody = { exists: false, promotion: { granted: false } };
// A fresh install: the bootstrap wrote a policy with no promotion.
const SCOPED: PushPolicyBody = { exists: true, promotion: { granted: false } };
const VERIFIED = { attempt_ids: ["a1"], trace_ids: ["t1"], verified_at: "2000-01-01T00:00:00.000Z" };

/** Resolvers that know one settled-held attempt (a1) and one reached trace (t1). */
const KNOWN: EvidenceResolvers = {
  settlementVerdict: (id) => ({ a1: "held", a2: "regressed" } as Record<string, string>)[id] ?? null,
  traceReached: async (id) => ({ t1: true, t2: false } as Record<string, boolean>)[id] ?? "missing",
};

describe("parseRemoteTarget", () => {
  it("reads owner/repo from the remote forms the push clones use", () => {
    expect(parseRemoteTarget("https://github.com/AviGopal/development-vessel.git")).toEqual({ owner: "AviGopal", repo: "development-vessel" });
    expect(parseRemoteTarget("https://x-access-token:ghp_secret@github.com/Acme/goal-host-vessel.git")).toEqual({ owner: "Acme", repo: "goal-host-vessel" });
    expect(parseRemoteTarget("git@github.com:Acme/activity-api.git")).toEqual({ owner: "Acme", repo: "activity-api" });
    expect(parseRemoteTarget("ssh://git@github.com:22/Acme/activity-api")).toEqual({ owner: "Acme", repo: "activity-api" });
  });
  it("returns null for a local path or nothing", () => {
    expect(parseRemoteTarget("/tmp/host-origin.git")).toBeNull();
    expect(parseRemoteTarget("")).toBeNull();
    expect(parseRemoteTarget(null)).toBeNull();
  });
});

describe("evaluateLandingScope", () => {
  const upstream = "https://github.com/Upstream/development-vessel.git";
  const fork = "https://github.com/Fork/development-vessel.git";

  it("grandfathers a volume with no pushPolicy file, whatever the environment says", () => {
    const saved = process.env["SUBSTRATE_INSTALL_FRESH"];
    process.env["SUBSTRATE_INSTALL_FRESH"] = "1";
    try {
      const v = evaluateLandingScope({ remoteUrl: upstream, branch: "dev", scopeOwner: "Fork", policy: NONE });
      expect(v.allowed).toBe(true);
      expect(v.regime).toBe("grandfathered");
    } finally {
      if (saved === undefined) delete process.env["SUBSTRATE_INSTALL_FRESH"];
      else process.env["SUBSTRATE_INSTALL_FRESH"] = saved;
    }
  });

  it("matches today's fleets: owner equals the push clone's owner", () => {
    const v = evaluateLandingScope({ remoteUrl: upstream, branch: "dev", scopeOwner: "\"Upstream\"", policy: SCOPED });
    expect(v.allowed).toBe(true);
    expect(v.shared).toBe(false);
  });

  it("refuses another owner's branch under the scoped regime and names the owner's own copy", () => {
    const v = evaluateLandingScope({ remoteUrl: upstream, branch: "dev", scopeOwner: "Fork", policy: SCOPED });
    expect(v.allowed).toBe(false);
    expect(v.regime).toBe("policy");
    expect(v.shared).toBe(true);
    expect(v.reason).toContain("requires a pushPolicy promotion (no promotion recorded)");
    expect(v.reason).toContain("Fork/development-vessel@dev");
    expect(v.scoped_target).toEqual({ owner: "Fork", repo: "development-vessel", branch: "dev" });
  });

  it("refuses when no owner is set under the scoped regime", () => {
    const v = evaluateLandingScope({ remoteUrl: fork, branch: "dev", scopeOwner: undefined, policy: SCOPED });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("SUBSTRATE_REPO_OWNER");
  });

  it("refuses an unknown target under a policy (fails closed)", () => {
    const v = evaluateLandingScope({ remoteUrl: null, branch: "dev", scopeOwner: "Fork", policy: SCOPED });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("landing target unknown");
  });

  it("allows a promoted shared target only when its evidence was verified and covers it", () => {
    const verified: PushPolicyBody = { exists: true, promotion: { granted: true, evidence: { attempt_ids: ["a1"], trace_ids: ["t1"], verified: VERIFIED } } };
    expect(evaluateLandingScope({ remoteUrl: upstream, branch: "dev", scopeOwner: "Fork", policy: verified }).allowed).toBe(true);
    // Ids written into the file by hand, never resolved, earn nothing.
    const handWritten: PushPolicyBody = { exists: true, promotion: { granted: true, evidence: { attempt_ids: ["x"], trace_ids: ["y"] } } };
    const h = evaluateLandingScope({ remoteUrl: upstream, branch: "dev", scopeOwner: "Fork", policy: handWritten });
    expect(h.allowed).toBe(false);
    expect(h.reason).toContain("evidence was never verified");
    // A citation added after verification is not covered by it.
    const widened: PushPolicyBody = { exists: true, promotion: { granted: true, evidence: { attempt_ids: ["a1", "forged"], trace_ids: ["t1"], verified: VERIFIED } } };
    expect(evaluateLandingScope({ remoteUrl: upstream, branch: "dev", scopeOwner: "Fork", policy: widened }).allowed).toBe(false);
    const narrow: PushPolicyBody = { exists: true, promotion: { granted: true, targets: ["Upstream/other-repo"], evidence: { attempt_ids: ["a1"], trace_ids: ["t1"], verified: VERIFIED } } };
    const n = evaluateLandingScope({ remoteUrl: upstream, branch: "dev", scopeOwner: "Fork", policy: narrow });
    expect(n.allowed).toBe(false);
    expect(n.reason).toContain("does not cover this target");
  });

  it("treats a declared own-owner shared target as needing a promotion", () => {
    const p: PushPolicyBody = { exists: true, promotion: { granted: false }, shared_targets: ["fork/*@dev"] };
    const v = evaluateLandingScope({ remoteUrl: fork, branch: "dev", scopeOwner: "Fork", policy: p });
    expect(v.allowed).toBe(false);
    expect(v.shared).toBe(true);
    expect(v.scoped_target).toBeNull();
    expect(v.reason).toContain("declared shared");
  });
});

describe("verifyPromotionEvidence", () => {
  it("accepts only ids that resolve: settled held, and reached", async () => {
    const ok = await verifyPromotionEvidence({ attempt_ids: ["a1"], trace_ids: ["t1"] }, KNOWN);
    expect(ok.ok).toBe(true);
    const bad = await verifyPromotionEvidence({ attempt_ids: ["a2", "nope"], trace_ids: ["t2", "gone"] }, KNOWN);
    expect(bad.ok).toBe(false);
    const problems = (bad as { problems: string[] }).problems.join("\n");
    expect(problems).toContain("a2: settled as regressed");
    expect(problems).toContain("nope: no settlement");
    expect(problems).toContain("t2: graded not reached");
    expect(problems).toContain("gone: not found");
  });
  it("requires both a settled landing and a verifying trace", async () => {
    expect((await verifyPromotionEvidence({ attempt_ids: ["a1"] }, KNOWN)).ok).toBe(false);
    expect((await verifyPromotionEvidence({ trace_ids: ["t1"] }, KNOWN)).ok).toBe(false);
  });
  it("fails closed when the trace store cannot be asked", async () => {
    const down: EvidenceResolvers = { ...KNOWN, traceReached: async () => { throw new Error("connect ECONNREFUSED"); } };
    const r = await verifyPromotionEvidence({ attempt_ids: ["a1"], trace_ids: ["t1"] }, down);
    expect(r.ok).toBe(false);
    expect((r as { problems: string[] }).problems[0]).toContain("could not be asked");
  });
});

describe("pushPolicy / pushPolicy_write", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["PUSH_POLICY_PATH", "MITOSIS_DIRECT_PUSH", "SUBSTRATE_REPO_OWNER"] as const;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "push-policy-"));
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env["PUSH_POLICY_PATH"] = join(dir, "push-policy.json");
  });
  afterEach(async () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("reads as absent (grandfathered) when nothing was ever written", () => {
    expect(resolvePushPolicy({ type: "pushPolicy" }).body).toEqual({ exists: false, promotion: { granted: false } });
  });

  it("rejects a promotion whose ids do not resolve, and writes nothing", async () => {
    const bare = await resolvePushPolicyWrite({ type: "pushPolicy_write", promotion: { granted: true } }, KNOWN);
    expect(bare.shape).toBe("structuredError");
    const forged = await resolvePushPolicyWrite(
      { type: "pushPolicy_write", promotion: { granted: true, evidence: { attempt_ids: ["x"], trace_ids: ["y"] } } },
      KNOWN,
    );
    expect(forged.shape).toBe("structuredError");
    expect((forged.body as { error: string }).error).toBe("promotion_evidence_unverified");
    expect(resolvePushPolicy({ type: "pushPolicy" }).body.exists).toBe(false);
  });

  it("round-trips a verified promotion; a caller-supplied `verified` is ignored", async () => {
    const ok = await resolvePushPolicyWrite({
      type: "pushPolicy_write",
      promotion: {
        granted: true,
        targets: ["Upstream"],
        evidence: { attempt_ids: ["a1"], trace_ids: ["t1"], note: "held", verified: { attempt_ids: ["x"], trace_ids: ["y"], verified_at: "1970-01-01T00:00:00Z" } },
      },
      shared_targets: ["Fork/*@dev"],
      set_by: "operator:test",
      reason: "earned",
    }, KNOWN);
    expect(ok.shape).toBe("pushPolicyWriteResult");
    const body = resolvePushPolicy({ type: "pushPolicy" }).body;
    expect(body.exists).toBe(true);
    expect(body.promotion.granted).toBe(true);
    expect(body.promotion.targets).toEqual(["Upstream"]);
    expect(body.promotion.evidence?.verified?.attempt_ids).toEqual(["a1"]);
    expect(body.promotion.evidence?.verified?.trace_ids).toEqual(["t1"]);
    expect(body.promotion.evidence?.verified?.verified_at).not.toBe("1970-01-01T00:00:00Z");
    expect(promotionIsCited(body.promotion)).toBe(true);
    expect(body.shared_targets).toEqual(["Fork/*@dev"]);
    expect(body.set_by).toBe("operator:test");
  });

  it("a withdrawal needs no evidence and ends the promotion", async () => {
    await resolvePushPolicyWrite({ type: "pushPolicy_write", promotion: { granted: true, evidence: { attempt_ids: ["a1"], trace_ids: ["t1"] } } }, KNOWN);
    const w = await resolvePushPolicyWrite({ type: "pushPolicy_write", promotion: { granted: false }, reason: "withdrawn" }, KNOWN);
    expect(w.shape).toBe("pushPolicyWriteResult");
    expect(promotionIsCited(resolvePushPolicy({ type: "pushPolicy" }).body.promotion)).toBe(false);
  });

  it("fails closed on an unparseable policy file", async () => {
    await writeFile(process.env["PUSH_POLICY_PATH"]!, "{not json");
    const body = resolvePushPolicy({ type: "pushPolicy" }).body;
    expect(body.exists).toBe(true);
    expect(body.promotion.granted).toBe(false);
  });

  it("reads the bootstrap's initial policy as the scoped regime", async () => {
    // The shape a new volume is seeded with: a policy, no promotion.
    await writeFile(process.env["PUSH_POLICY_PATH"]!, JSON.stringify({ promotion: { granted: false }, shared_targets: ["Upstream/*@dev"], set_by: "bootstrap" }));
    process.env["SUBSTRATE_REPO_OWNER"] = "Upstream";
    const g = gateLanding({ remoteUrl: "https://github.com/Upstream/development-vessel.git", branch: "dev" });
    expect(g.allowed).toBe(false);
    expect(g.scope?.regime).toBe("policy");
    expect(g.allowed ? "" : g.reason).toContain("requires a pushPolicy promotion");
    // A branch that is not declared shared stays within scope.
    expect(gateLanding({ remoteUrl: "https://github.com/Upstream/development-vessel.git", branch: "substrate/x" }).allowed).toBe(true);
  });
});

describe("gateLanding", () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["PUSH_POLICY_PATH", "MITOSIS_DIRECT_PUSH", "SUBSTRATE_REPO_OWNER"] as const;
  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env["PUSH_POLICY_PATH"] = join(tmpdir(), `no-push-policy-${process.pid}.json`);
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("the emergency stop refuses before the policy is consulted", () => {
    process.env["MITOSIS_DIRECT_PUSH"] = "0";
    const g = gateLanding({ remoteUrl: "https://github.com/Fork/x.git", branch: "dev" });
    expect(g.allowed).toBe(false);
    expect(g.allowed ? "" : g.kind).toBe("push_kill_switch");
  });

  it("with no policy file and the switch unset or 1, every push proceeds as before", () => {
    for (const v of [undefined, "1"]) {
      if (v === undefined) delete process.env["MITOSIS_DIRECT_PUSH"];
      else process.env["MITOSIS_DIRECT_PUSH"] = v;
      const g = gateLanding({ remoteUrl: "https://github.com/Other/x.git", branch: "dev" });
      expect(g.allowed).toBe(true);
      expect(g.scope?.regime).toBe("grandfathered");
    }
  });
});
