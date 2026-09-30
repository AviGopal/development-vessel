// Pins the push-clone refresh to development-vessel's OWN process.
//
// THE DEFECT: feature_compose refreshed a vessel's push clone with
// `git -C <clone> fetch origin dev; git -C <clone> reset --hard origin/dev`
// sent THROUGH local-tools' shell resolver. A private remote (human-surface-vessel)
// authenticates through the container's git credential helper, which sources the
// substrate env file. Secrets live with the resolver that uses them and are never
// readable by the agent's shell, so local-tools loses that file — and every
// credentialed fetch sent through it would fail. The shell result was also
// discarded outright (`2>&1` into a body nobody read), so a failed fetch or reset
// was invisible and the success log line printed regardless.
//
// So: the fetch+reset runs in-process via the existing git spawn helper
// (vessel-mitosis-cutover's runGit), with the same `;` semantics (a failed fetch
// still resets to the last-known origin/dev), and a non-zero exit is surfaced.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { refreshPushCloneToOriginDev } from "../../src/resolvers/feature-compose";

const SRC = readFileSync(join(import.meta.dir, "../../src/resolvers/feature-compose.ts"), "utf8");

/** Each shell callTool in feature-compose, with the text up to its closing `});`. */
function shellCalls(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const at = src.indexOf(`callTool(toolsEndpoint, "shell"`, i);
    if (at < 0) return out;
    const end = src.indexOf("});", at);
    out.push(src.slice(at, end < 0 ? at + 800 : end));
    i = at + 1;
  }
}

describe("feature-compose: push-clone refresh does not go through the shell tool", () => {
  test("no shell call fetches or hard-resets a push clone", () => {
    const offenders = shellCalls(SRC).filter(
      (c) => /clonePath/.test(c) && (/fetch origin dev/.test(c) || /reset --hard origin\/dev/.test(c)),
    );
    expect(offenders).toEqual([]);
  });

  test("both refresh sites call the in-process helper", () => {
    const uses = SRC.match(/await refreshPushCloneToOriginDev\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
  });

  test("scoping control: the public super-repo fetch is still a shell call (it needs no credential)", () => {
    // Positive control for the filter above: if this goes red the test is
    // matching nothing, not proving an absence.
    const superFetch = shellCalls(SRC).filter((c) => /SUPER_REPO_ROOT/.test(c) && /fetch origin dev/.test(c));
    expect(superFetch.length).toBe(1);
  });
});

type FakeResult = { code: number; stdout?: string; stderr?: string };

function fakeSpawn(results: FakeResult[]) {
  const calls: Array<{ argv: string[]; opts: Record<string, unknown> }> = [];
  const spy = spyOn(Bun, "spawn").mockImplementation(((argv: string[], opts: Record<string, unknown>) => {
    calls.push({ argv, opts });
    const r = results[calls.length - 1] ?? { code: 0 };
    return {
      stdout: new Response(r.stdout ?? "").body,
      stderr: new Response(r.stderr ?? "").body,
      exited: Promise.resolve(r.code),
    };
  }) as unknown as typeof Bun.spawn);
  return { calls, spy };
}

describe("refreshPushCloneToOriginDev (spawn mocked)", () => {
  let restore: Array<() => void> = [];
  afterEach(() => {
    for (const r of restore) r();
    restore = [];
  });

  function setup(results: FakeResult[]) {
    const f = fakeSpawn(results);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    restore.push(() => f.spy.mockRestore(), () => warn.mockRestore());
    return { ...f, warn };
  }

  test("runs `git -C <dir> fetch origin dev` then `git -C <dir> reset --hard origin/dev`, in order", async () => {
    const { calls, warn } = setup([{ code: 0 }, { code: 0, stdout: "HEAD is now at abc123 x\n" }]);
    const r = await refreshPushCloneToOriginDev("/tmp/clones/human-surface-vessel", "/tmp/clones");
    expect(calls.map((c) => c.argv)).toEqual([
      ["git", "-C", "/tmp/clones/human-surface-vessel", "fetch", "origin", "dev"],
      ["git", "-C", "/tmp/clones/human-surface-vessel", "reset", "--hard", "origin/dev"],
    ]);
    expect(calls[0]!.opts["cwd"]).toBe("/tmp/clones");
    // Bounded like the shell call it replaces (timeout_sec 300).
    expect(calls[0]!.opts["timeout"]).toBe(300_000);
    expect(calls[1]!.opts["timeout"]).toBe(300_000);
    expect(r.ok).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a failed fetch is surfaced, and the reset still runs (the old `;` semantics)", async () => {
    const { calls, warn } = setup([
      { code: 128, stderr: "fatal: could not read Username for 'https://github.com': No such device or address" },
      { code: 0 },
    ]);
    const r = await refreshPushCloneToOriginDev("/c/v", "/c");
    expect(calls.length).toBe(2);
    expect(r.fetch.exit_code).toBe(128);
    expect(r.ok).toBe(true); // reset to last-known origin/dev succeeded
    const msg = warn.mock.calls.map((a) => String(a[0])).join("\n");
    expect(msg).toContain("fetch origin dev");
    expect(msg).toContain("128");
    expect(msg).toContain("could not read Username");
  });

  test("a failed reset surfaces a non-zero exit and ok:false", async () => {
    const { warn } = setup([{ code: 0 }, { code: 1, stderr: "fatal: ambiguous argument 'origin/dev'" }]);
    const r = await refreshPushCloneToOriginDev("/c/v", "/c");
    expect(r.ok).toBe(false);
    expect(r.reset.exit_code).toBe(1);
    const msg = warn.mock.calls.map((a) => String(a[0])).join("\n");
    expect(msg).toContain("reset --hard origin/dev");
    expect(msg).toContain("ambiguous argument");
  });
});
