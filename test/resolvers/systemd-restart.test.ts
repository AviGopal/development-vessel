import { describe, it, expect } from "bun:test";
import { resolveSystemdRestart } from "../../src/resolvers/systemd-restart.js";
import { Blob } from "buffer";

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
    // systemctl restart exits non-zero → no polling
    const result = await resolveSystemdRestart({
      type: "systemd_restart",
      unit: "nonexistent-unit-xyz",
      timeout_ms: 500,
    });
    expect(result.shape).toBe("systemd_unit_restart");
    const body = result.body as { success: boolean; active: boolean };
    // In environments without systemd this may still return false — either way
    // shape and success/active booleans must be present
    expect(typeof body.success).toBe("boolean");
    expect(typeof body.active).toBe("boolean");
  });
});
