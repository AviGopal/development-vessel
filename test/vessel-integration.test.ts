import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { impulsesRouter } from "../src/routes/impulses.js";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";

const testDir = join(tmpdir(), `dev-vessel-integration-${Date.now()}`);

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(testDir, "probe.txt"), "integration test content");
  process.env["WORKSPACE_ROOT"] = testDir;
});

afterAll(() => {
  delete process.env["WORKSPACE_ROOT"];
});

function makeApp() {
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route("/", impulsesRouter);
  return app;
}

async function resolve(app: Hono, pointer: Record<string, unknown>) {
  const req = new Request("http://localhost/v2/impulses/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ impulse: pointer }),
  });
  const res = await app.fetch(req);
  return res.json() as Promise<{ success: boolean; shape?: string; body?: unknown; error?: string }>;
}

describe("vessel HTTP integration", () => {
  const app = makeApp();

  it("GET /health returns ok", async () => {
    const res = await app.fetch(new Request("http://localhost/health"));
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  it("resolves fs_read for a file in workspace", async () => {
    const result = await resolve(app, {
      type: "fs_read",
      path: join(testDir, "probe.txt"),
    });
    expect(result.success).toBe(true);
    expect(result.shape).toBe("fileContent");
    const b = result.body as { content: string; truncated: boolean };
    expect(b.content).toBe("integration test content");
    expect(b.truncated).toBe(false);
  });

  it("returns 400 for unknown shape", async () => {
    const req = new Request("http://localhost/v2/impulses/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ impulse: { type: "no_such_resolver" } }),
    });
    const res = await app.fetch(req);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("unknown shape");
  });

  it("returns 400 for missing pointer type", async () => {
    const req = new Request("http://localhost/v2/impulses/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ impulse: {} }),
    });
    const res = await app.fetch(req);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("pointer.type");
  });

  it("resolves git_status in the development-vessel repo itself", async () => {
    const devVesselDir = process.cwd();
    const result = await resolve(app, {
      type: "git_status",
      cwd: devVesselDir,
    });
    expect(result.success).toBe(true);
    expect(result.shape).toBe("commandResult");
    const b = result.body as { exitCode: number };
    expect(typeof b.exitCode).toBe("number");
  });
});
