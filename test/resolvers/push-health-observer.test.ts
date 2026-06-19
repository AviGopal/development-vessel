import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePushHealthObserver } from "../../src/resolvers/push-health-observer.js";

// Per-resolver test for push_health_observer (2026-06-19). Pins the
// scan/classify/emit contract using temp jsonl files via the test-hook path
// overrides; probePat:false + emitGap:false keep the test offline.

let dir: string;
let resultsPath: string;
let intentPath: string;
let appliedLogPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "push-health-"));
  resultsPath = join(dir, "results.jsonl");
  intentPath = join(dir, "intents.jsonl");
  appliedLogPath = join(dir, "applied.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const base = {
  type: "push_health_observer" as const,
  probePat: false,
  emitGap: false,
  resultsPath: "",
  intentPath: "",
  appliedLogPath: "",
};

function wire() {
  return { ...base, resultsPath, intentPath, appliedLogPath };
}

describe("push_health_observer", () => {
  it("reports healthy when all recent host-sync results pushed", async () => {
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({ intent_id: `i${i}`, push_status: "pushed", detail: "origin dev" }),
    ).join("\n");
    await writeFile(resultsPath, lines + "\n");
    await writeFile(intentPath, "");
    await writeFile(appliedLogPath, "");

    const r = await resolvePushHealthObserver(wire());
    expect(r.shape).toBe("pushHealth");
    const b = r.body as { sustained_push_failure: boolean; cause: string | null };
    expect(b.sustained_push_failure).toBe(false);
    expect(b.cause).toBeNull();
  });

  it("detects sustained push failure from genuine push-failed host-sync results", async () => {
    const lines = [
      JSON.stringify({ intent_id: "a", push_status: "local_only", detail: "push failed: auth" }),
      JSON.stringify({ intent_id: "b", push_status: "local_only", detail: "push failed: auth" }),
      JSON.stringify({ intent_id: "c", push_status: "local_only", detail: "push failed: Invalid username or token" }),
    ].join("\n");
    await writeFile(resultsPath, lines + "\n");
    await writeFile(intentPath, "");
    await writeFile(appliedLogPath, "");

    const r = await resolvePushHealthObserver(wire());
    const b = r.body as {
      sustained_push_failure: boolean;
      cause: string;
      signals: { push_failures: number };
    };
    expect(b.sustained_push_failure).toBe(true);
    expect(b.cause).toBe("push_failing");
    expect(b.signals.push_failures).toBe(3);
  });

  it("does NOT classify upstream gate rejections (stale base / scope creep) as push-credential failure", async () => {
    const lines = [
      JSON.stringify({ intent_id: "a", push_status: "rejected_base_sha", detail: "mismatch" }),
      JSON.stringify({ intent_id: "b", push_status: "rejected_base_sha", detail: "mismatch" }),
      JSON.stringify({ intent_id: "c", push_status: "rejected_scope_creep", detail: "extras" }),
      JSON.stringify({ intent_id: "d", push_status: "pushed", detail: "origin dev" }),
    ].join("\n");
    await writeFile(resultsPath, lines + "\n");
    await writeFile(intentPath, "");
    await writeFile(appliedLogPath, "");

    const r = await resolvePushHealthObserver(wire());
    const b = r.body as {
      sustained_push_failure: boolean;
      cause: string | null;
      signals: { gate_rejections: number; push_failures: number };
    };
    // Gate rejections are a different failure mode — they must NOT trip the
    // push-credential classification.
    expect(b.cause).not.toBe("push_failing");
    expect(b.signals.gate_rejections).toBe(3);
    expect(b.signals.push_failures).toBe(0);
  });

  it("detects a wedged poller from stuck pending intents with no results", async () => {
    const intents = Array.from({ length: 4 }, (_, i) =>
      JSON.stringify({ intent_id: `p${i}`, status: "pending", vessel_name: "development-vessel" }),
    ).join("\n");
    await writeFile(intentPath, intents + "\n");
    await writeFile(resultsPath, ""); // no results -> poller not draining
    await writeFile(appliedLogPath, "");

    const r = await resolvePushHealthObserver(wire());
    const b = r.body as { sustained_push_failure: boolean; cause: string; operator_territory: boolean };
    expect(b.sustained_push_failure).toBe(true);
    expect(b.cause).toBe("poller_wedged");
    expect(b.operator_territory).toBe(true);
  });

  it("classifies operator-territory invalid-PAT when probePat reports invalid and cutovers are local_only", async () => {
    const applied = [
      JSON.stringify({ shape: "cutoverApplied", body: { vessel_name: "development-vessel", push_status: "local_only" } }),
    ].join("\n");
    await writeFile(appliedLogPath, applied + "\n");
    await writeFile(resultsPath, "");
    await writeFile(intentPath, "");

    // Force the PAT probe to "invalid" by pointing at a bogus repo + ensuring a
    // PAT env is set (the probe ls-remote will fail -> invalid). If no PAT is
    // present in the test env, patStatus becomes no_pat which ALSO triggers the
    // operator-territory branch — either way the cause must be operator_invalid_pat.
    const r = await resolvePushHealthObserver({
      ...wire(),
      probePat: true,
      patProbeRepo: "definitely-not-a-real-repo-xyz",
    });
    const b = r.body as { sustained_push_failure: boolean; cause: string; operator_territory: boolean };
    expect(b.sustained_push_failure).toBe(true);
    expect(b.cause).toBe("operator_invalid_pat");
    expect(b.operator_territory).toBe(true);
  });

  it("degrades to healthy when all files are missing/empty", async () => {
    // No files written at all.
    const r = await resolvePushHealthObserver(wire());
    const b = r.body as { sustained_push_failure: boolean; signals: { recent_results: number } };
    expect(b.sustained_push_failure).toBe(false);
    expect(b.signals.recent_results).toBe(0);
  });
});
