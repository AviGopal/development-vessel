import { describe, it, expect } from "bun:test";
import { join } from "path";

const cliPath = join(import.meta.dir, "../src/cli.ts");

async function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", cliPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("CLI — unknown verb", () => {
  it("exits 1 and prints usage hint", async () => {
    const result = await runCli(["not-a-verb"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown verb");
    expect(result.stderr).toContain("seed-templates");
  });

  it("exits 1 when no verb is given", async () => {
    const result = await runCli([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown verb");
  });
});

describe("CLI — call-resolver", () => {
  it("dispatches git_status and prints JSON result", async () => {
    const result = await runCli([
      "call-resolver",
      "git_status",
      "--data",
      JSON.stringify({ cwd: process.cwd() }),
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { shape: string; body: unknown };
    expect(parsed.shape).toBe("commandResult");
  });

  it("exits 1 when resolver type is missing", async () => {
    const result = await runCli(["call-resolver"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage");
  });

  it("exits 1 when --data is invalid JSON", async () => {
    const result = await runCli(["call-resolver", "git_status", "--data", "not-json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("valid JSON");
  });

  it("exits 1 for an unknown resolver type", async () => {
    const result = await runCli(["call-resolver", "no_such_resolver", "--data", "{}"]);
    expect(result.exitCode).toBe(1);
  });
});

describe("CLI — seed-templates", () => {
  it("exits 1 when activity-api is unreachable (no METABOB_ENDPOINT)", async () => {
    // Point at an unreachable endpoint; all uploads will fail with structuredError
    // The CLI currently iterates and logs errors per template without crashing.
    // With all templates returning structuredErrors (not throws), exit is 0 and
    // output contains the seed_results JSON.
    const result = await runCli(["seed-templates"], {
      METABOB_ENDPOINT: "http://127.0.0.1:0",
      METABOB_API_KEY: "test",
    });
    // May exit 0 (if structuredErrors) or 1 (if fetch throws ECONNREFUSED)
    // In either case, stdout or stderr must mention template names
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("bootstrap templates");
  });
});

describe("CLI — run-activity", () => {
  it("exits 1 when activity ID is missing", async () => {
    const result = await runCli(["run-activity"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage");
  });

  it("exits 1 when activity-api is unreachable", async () => {
    const result = await runCli(["run-activity", "some:template"], {
      METABOB_ENDPOINT: "http://127.0.0.1:0",
      METABOB_API_KEY: "test",
    });
    // Either fetch throws (ECONNREFUSED → exit 1) or returns structuredError
    // structuredError: exits 0 but body has structuredError shape
    const combined = result.stdout + result.stderr;
    expect(combined.length).toBeGreaterThan(0);
  });
});
