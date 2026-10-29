// ROLLBACK VERIFIED BY EFFECT (patch-with-tools.ts): every restore re-reads the path and compares its full sha256 with
// the pre-edit snapshot; a truncating edit is rolled back in the same turn; a restore that does not take RETURNS a
// shaped refusal (stage rollback_unverified, REFUSED) and files a gap; a restore that takes logs one line with the sha.
// Measured 10-09: a run truncated a live vessel file and only pull-sync's drift heal restored it.
// Fixtures live in a temp dir only; the gap writer is captured, never the gap store.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pwt from "../../src/resolvers/patch-with-tools.js";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
type Seam = { __setRollbackGapWriterForTests?: (w: ((p: Record<string, unknown>) => Promise<unknown>) | null) => void };
const seam = pwt as unknown as Seam;

const originalFetch = globalThis.fetch;
const originalLog = console.log;

/**
 * The resolver's dispatch surface, no network: discovery, the model-policy probe and the semantic judge (answered
 * without consuming a scripted action), the scripted drafter turns, and local-tools fs_edit / typecheck.
 * `damage`: the scripted fs_edit also replaces the file with a non-empty directory, so no write can restore it.
 * `onTurn`: called with the drafter turn number before its action is returned (to observe the tree between turns).
 */
function makeFetch(opts: { actions: string[]; typecheckErrorsAfterEdit: boolean; damage?: boolean; onTurn?: (turn: number) => void }): typeof fetch {
  let turn = 0;
  let typechecks = 0;
  return (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input.url ?? input);
    const body = init?.body ? JSON.parse(init.body as string) : {};
    if (url.includes("/resolve") && body?.pointer?.type === "vesselCapability") {
      const shape = body.pointer.shape;
      const role = (shape === "llmCompletion" || shape === "llm_completion") ? "llm" : "tools";
      return new Response(JSON.stringify({ content: { vessels: [{ endpoint: "http://127.0.0.1:9", resolve_endpoint: `http://127.0.0.1:9/${role}`, health_score: 1 }] } }), { status: 200 });
    }
    if (url.endsWith("/llm") && body?.type === "llmModelPolicy") {
      return new Response(JSON.stringify({ body: { arms: [{ model: "qwen/qwen3-32b" }] } }), { status: 200 });
    }
    if (url.endsWith("/llm") && String(body?.prompt ?? "").includes("You verify whether a self-authored CODE PATCH GENUINELY addresses a substrate gap")) {
      return new Response(JSON.stringify({ content: JSON.stringify({ addresses: true, on_live_path: true, reason: "fixture judge" }) }), { status: 200 });
    }
    if (url.endsWith("/llm")) {
      turn++;
      opts.onTurn?.(turn);
      const content = opts.actions[Math.min(turn - 1, opts.actions.length - 1)] ?? '{"action":"fail","reason":"out of script"}';
      return new Response(JSON.stringify({ content }), { status: 200 });
    }
    if (url.endsWith("/tools")) {
      const ptr = body?.impulse?.pointer ?? {};
      if (ptr.type === "fs_edit") {
        const path = ptr.path as string;
        const cur = readFileSync(path, "utf-8");
        const oldStr = String(ptr.old_string ?? "");
        if (!cur.includes(oldStr)) return new Response(JSON.stringify({ success: false, error: "old_string not found" }), { status: 200 });
        writeFileSync(path, cur.replace(oldStr, String(ptr.new_string ?? "")));
        if (opts.damage) { unlinkSync(path); mkdirSync(path); writeFileSync(join(path, "debris"), "x"); }
        return new Response(JSON.stringify({ shape: "fileWriteResult", path, ok: true, success: true }), { status: 200 });
      }
      if (ptr.type === "code_verify_typecheck" || ptr.type === "code_typecheck") {
        typechecks++;
        const error_lines = opts.typecheckErrorsAfterEdit && typechecks > 1 ? ["src/index.ts(1,1): error TS1005: ';' expected."] : [];
        return new Response(JSON.stringify({ shape: "codeTypecheckResult", error_lines }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const BODY = Array.from({ length: 40 }, (_, i) => `export const VALUE_${i} = ${i}; // a line of the live source that must survive`).join("\n") +
  "\nexport function value3(): number {\n  return VALUE_3;\n}\n";

describe("patch_with_tools: rollback verified by effect", () => {
  let base: string;
  let vesselsRoot: string;
  let workspaceRoot: string;
  let targetPath: string;
  let gaps: Record<string, unknown>[];
  let logs: string[];
  const subPath = "src/index.ts";

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "pwt-rollback-"));
    vesselsRoot = join(base, "vessels");
    workspaceRoot = join(base, "workspace");
    mkdirSync(join(vesselsRoot, "demo-vessel", "src"), { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
    targetPath = join(vesselsRoot, "demo-vessel", subPath);
    writeFileSync(targetPath, BODY);
    process.env["METABOB_API_KEY"] = "test-key";
    gaps = [];
    seam.__setRollbackGapWriterForTests?.(async (p) => { gaps.push(p); return { shape: "substrateGapWriteResult" }; });
    logs = [];
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    seam.__setRollbackGapWriterForTests?.(null);
    rmSync(base, { recursive: true, force: true });
  });

  const run = () => pwt.resolvePatchWithTools({
    type: "patch_with_tools",
    proposal_text: "change VALUE_3 in the demo vessel",
    target_file: `repos/demo-vessel/${subPath}`,
    vessels_root: vesselsRoot,
    workspace_root: workspaceRoot,
    max_attempts: 1,
  });

  it("must-fail: an fs_edit that truncates the file is rolled back by the run itself in the same turn", async () => {
    const seenAtTurn2: string[] = [];
    globalThis.fetch = makeFetch({
      typecheckErrorsAfterEdit: true,
      onTurn: (t) => { if (t === 2) seenAtTurn2.push(readFileSync(targetPath, "utf-8")); },
      actions: [
        // Replaces everything after the first line: the file drops to a stub.
        JSON.stringify({ action: "call_tool", tool: "fs_edit", args: { path: targetPath, old_string: BODY.slice(BODY.indexOf("\n") + 1), new_string: "" } }),
        JSON.stringify({ action: "fail", reason: "giving up" }),
      ],
    });
    const r = await run();
    // Before the drafter's next turn, the file is already its pre-edit bytes again.
    expect(seenAtTurn2).toHaveLength(1);
    expect(sha(seenAtTurn2[0]!)).toBe(sha(BODY));
    expect(readFileSync(targetPath, "utf-8")).toBe(BODY);
    expect(r.shape).toBe("structuredError");
    expect(gaps).toEqual([]);
  });

  it("must-fail: a restore that does not take returns a shaped refusal and files a gap (fail loud)", async () => {
    globalThis.fetch = makeFetch({
      typecheckErrorsAfterEdit: true,
      damage: true,
      actions: [
        JSON.stringify({ action: "call_tool", tool: "fs_edit", args: { path: targetPath, old_string: "return VALUE_3;", new_string: "return VALUE_3 + 1;" } }),
        JSON.stringify({ action: "fail", reason: "giving up" }),
      ],
    });
    const r = await run();
    expect(r.shape).toBe("structuredError");
    const b = r.body as Record<string, unknown>;
    expect(b["stage"]).toBe("rollback_unverified");
    expect(b["verdict"]).toBe("REFUSED");
    expect(b["path"]).toBe(targetPath);
    expect(b["expected_sha"]).toBe(sha(BODY));
    expect(b["got_sha"]).toBeNull();
    expect(gaps).toHaveLength(1);
    const g = gaps[0]!["gap"] as Record<string, unknown>;
    expect(g["status"]).toBe("open");
    expect(String(g["id"])).toStartWith("pwt-rollback-unverified-");
    expect((g["classification_metadata"] as Record<string, unknown>)["detector"]).toBe("patch_with_tools_rollback_verify");
    expect(statSync(targetPath).isDirectory()).toBe(true); // the fixture's damage is real: nothing could restore it
  });

  it("control: a rollback that restores reports success quietly: one sha line, no refusal, no gap", async () => {
    globalThis.fetch = makeFetch({
      typecheckErrorsAfterEdit: true,
      actions: [
        JSON.stringify({ action: "call_tool", tool: "fs_edit", args: { path: targetPath, old_string: "return VALUE_3;", new_string: "return VALUE_3 + 1;" } }),
        JSON.stringify({ action: "fail", reason: "giving up" }),
      ],
    });
    const r = await run();
    expect(r.shape).toBe("structuredError");
    expect((r.body as Record<string, unknown>)["stage"]).not.toBe("rollback_unverified");
    expect(readFileSync(targetPath, "utf-8")).toBe(BODY);
    expect(gaps).toEqual([]);
    expect(logs.some((l) => l.includes(`restored ${targetPath} sha=${sha(BODY).slice(0, 12)} == pre-edit`))).toBe(true);
  });

  it("control: a successful edit still applies: it is staged for landing and the live file is back at its base", async () => {
    globalThis.fetch = makeFetch({
      typecheckErrorsAfterEdit: false,
      actions: [
        JSON.stringify({ action: "call_tool", tool: "fs_edit", args: { path: targetPath, old_string: "return VALUE_3;", new_string: "return VALUE_3 + 1;" } }),
        JSON.stringify({ action: "done", summary: "changed VALUE_3" }),
      ],
    });
    const r = await run();
    expect(r.shape).toBe("mitosisStaged");
    const b = r.body as { mitosis_root: string; staged_files: string[] };
    expect(b.staged_files).toContain(subPath);
    expect(readFileSync(join(b.mitosis_root, subPath), "utf-8")).toContain("return VALUE_3 + 1;");
    expect(readFileSync(targetPath, "utf-8")).toBe(BODY);
    expect(gaps).toEqual([]);
  });

  it("control: restorePathVerified judges by effect, a net-new path included", async () => {
    const restore = (pwt as unknown as { restorePathVerified?: (p: string, c: string | null) => Promise<{ ok: boolean; expected_sha: string | null; got_sha: string | null }> }).restorePathVerified;
    expect(typeof restore).toBe("function");
    writeFileSync(targetPath, "stub");
    expect(await restore!(targetPath, BODY)).toMatchObject({ ok: true, expected_sha: sha(BODY), got_sha: sha(BODY) });
    const fresh = join(vesselsRoot, "demo-vessel", "src", "new.ts");
    writeFileSync(fresh, "authored");
    expect(await restore!(fresh, null)).toMatchObject({ ok: true, expected_sha: null, got_sha: null });
  });
});
