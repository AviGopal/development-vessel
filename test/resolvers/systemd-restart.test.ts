import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { resolveSystemdRestart } from "../../src/resolvers/systemd-restart.js";
import { Blob } from "buffer";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";

// No test here may run the HOST's systemctl (measured 2026-10-03: the in-process case below did, and
// passed or timed out depending on the host). The exec guard blocks and records any systemctl /
// docker / podman / vessel-ctl spawn; a case that needs an answer declares a route. The resolver
// has no injectable runner, so the route stubs Bun.spawn, which it reads at call time.
// The child-process cases below spawn `bun --eval`, which the guard does not cover (a child gets a
// fresh Bun.spawn); each child replaces its own Bun.spawn before calling the resolver.
let exec: ExecGuard;
beforeEach(() => { exec = installCutoverExecGuard(); });
afterEach(() => { expect(exec.restore()).toEqual([]); });
afterAll(() => { restoreCutoverExecModules(); });

describe("systemd-restart resolver", () => {
  it("returns systemd_unit_restart shape with required body fields via child process", async () => {
    const child = Bun.spawn([process.execPath, "--eval", `
      const { resolveSystemdRestart } = await import('${import.meta.url.replace('test/resolvers/systemd-restart.test.ts', 'src/resolvers/systemd-restart.js')}');
      Bun.spawn = () => ({
        exited: Promise.resolve(0),
        stdout: new Blob(['active\n']),
        stderr: new Blob(),
      });
      const result = await resolveSystemdRestart({
        type: "systemd_restart",
        unit: "activity-api",
        timeout_ms: 100,
      });
      process.stdout.write(JSON.stringify(result));
    `]);
    const output = await new Response(child.stdout).text();
    const result = JSON.parse(output);
    
    expect(result.shape).toBe("systemd_unit_restart");
    const body = result.body as { success: boolean; active: boolean; unit: string; startup_ms: number };
    expect(body.success).toBe(true);
    expect(body.active).toBe(true);
    expect(typeof body.startup_ms).toBe("number");
    expect(body.unit).toBe("activity-api.service");
  });

  it("appends .service suffix when not present via child process", async () => {
    const child = Bun.spawn([process.execPath, "--eval", `
      const { resolveSystemdRestart } = await import('${import.meta.url.replace('test/resolvers/systemd-restart.test.ts', 'src/resolvers/systemd-restart.js')}');
      Bun.spawn = () => ({
        exited: Promise.resolve(0),
        stdout: new Blob(['active\n']),
        stderr: new Blob(),
      });
      const result = await resolveSystemdRestart({
        type: "systemd_restart",
        unit: "my-vessel",
        timeout_ms: 100,
      });
      process.stdout.write(JSON.stringify(result));
    `]);
    const output = await new Response(child.stdout).text();
    const result = JSON.parse(output);
    
    expect(result.shape).toBe("systemd_unit_restart");
    const body = result.body as { unit: string };
    expect(body.unit).toBe("my-vessel.service");
  });

  it("does not double-append .service suffix via child process", async () => {
    const child = Bun.spawn([process.execPath, "--eval", `
      const { resolveSystemdRestart } = await import('${import.meta.url.replace('test/resolvers/systemd-restart.test.ts', 'src/resolvers/systemd-restart.js')}');
      Bun.spawn = () => ({
        exited: Promise.resolve(0),
        stdout: new Blob(['active\n']),
        stderr: new Blob(),
      });
      const result = await resolveSystemdRestart({
        type: "systemd_restart",
        unit: "activity-api.service",
        timeout_ms: 100,
      });
      process.stdout.write(JSON.stringify(result));
    `]);
    const output = await new Response(child.stdout).text();
    const result = JSON.parse(output);
    
    expect(body.unit).toBe("activity-api.service");
  });

  it("rejects unexpected systemctl commands via child process", async () => {
    const child = Bun.spawn([process.execPath, "--eval", `
      const { resolveSystemdRestart } = await import('${import.meta.url.replace('test/resolvers/systemd-restart.test.ts', 'src/resolvers/systemd-restart.js')}');
      Bun.spawn = (cmd) => {
        if (!cmd.some(a => a === 'is-active' || a === 'restart')) {
          return {
            exited: Promise.reject(new Error('Unexpected command')),
            stdout: new Blob(),
            stderr: new Blob(['Mock rejection']),
          };
        }
        return {
          exited: Promise.resolve(0),
          stdout: new Blob(['active\n']),
          stderr: new Blob(),
        };
      };
      const result = await resolveSystemdRestart({
        type: "systemd_restart",
        unit: "activity-api.service",
        timeout_ms: 100,
      });
      process.stdout.write(JSON.stringify(result));
    `]);
    const output = await new Response(child.stdout).text();
    const result = JSON.parse(output);
    
    expect(result.shape).toBe("systemd_unit_restart");
    expect((result.body as { success: boolean }).success).toBe(true);
  });

  it("handles failed restarts via child process", async () => {
    const child = Bun.spawn([process.execPath, "--eval", `
      const { resolveSystemdRestart } = await import('${import.meta.url.replace('test/resolvers/systemd-restart.test.ts', 'src/resolvers/systemd-restart.js')}');
      Bun.spawn = () => ({
        exited: Promise.reject(new Error('Mock failure')),
        stdout: new Blob(),
        stderr: new Blob(['Mock error']),
      });
      const result = await resolveSystemdRestart({
        type: "systemd_restart",
        unit: "activity-api.service",
        timeout_ms: 100,
      });
      process.stdout.write(JSON.stringify(result));
    `]);
    const output = await new Response(child.stdout).text();
    const result = JSON.parse(output);
    
    expect(result.shape).toBe("systemd_unit_restart");
    expect((result.body as { success: boolean }).success).toBe(false);
  });

  it("returns success:false when restart command fails", async () => {
    // systemctl restart exits non-zero → no polling. Stubbed: the host's systemctl is never run.
    exec.route({
      name: "systemctl restart (unit not found)",
      match: (c) => c === "systemctl restart nonexistent-unit-xyz.service",
      respond: () => ({ exitCode: 5, stderr: "Failed to restart nonexistent-unit-xyz.service: Unit nonexistent-unit-xyz.service not found.\n" }),
    });
    const result = await resolveSystemdRestart({
      type: "systemd_restart",
      unit: "nonexistent-unit-xyz",
      timeout_ms: 500,
    });
    expect(result.shape).toBe("systemd_unit_restart");
    const body = result.body as { success: boolean; active: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.active).toBe(false);
    expect(body.error).toContain("not found");
    expect(exec.hits).toEqual(["systemctl restart (unit not found)"]);
  });
});
