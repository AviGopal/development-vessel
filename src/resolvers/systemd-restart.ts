import type { ResolverResult } from "./types.js";

export interface SystemdRestartPointer {
  type: "systemd_restart";
  unit: string; // systemd unit name, e.g. "activity-api" (no .service suffix needed)
  timeout_ms?: number; // default 30000
}

export async function resolveSystemdRestart(
  pointer: SystemdRestartPointer,
): Promise<ResolverResult> {
  const unit = pointer.unit.endsWith(".service") ? pointer.unit : `${pointer.unit}.service`;
  const timeoutMs = pointer.timeout_ms ?? 30_000;
  const started = Date.now();

  // Restart the unit
  const restart = Bun.spawn(["systemctl", "restart", unit], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, restartStderr] = await Promise.all([
    new Response(restart.stdout).text(),
    new Response(restart.stderr).text(),
  ]);
  const restartExit = await restart.exited;

  if (restartExit !== 0) {
    return {
      shape: "systemd_unit_restart",
      body: {
        success: false,
        active: false,
        unit,
        startup_ms: Date.now() - started,
        error: restartStderr.trim() || `systemctl restart exited ${restartExit}`,
      },
    };
  }

  // Poll until active or timeout
  while (Date.now() - started < timeoutMs) {
    const check = Bun.spawn(["systemctl", "is-active", unit], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const checkOut = (await new Response(check.stdout).text()).trim();
    await check.exited;

    if (checkOut === "active") {
      return {
        shape: "systemd_unit_restart",
        body: {
          success: true,
          active: true,
          unit,
          startup_ms: Date.now() - started,
        },
      };
    }

    // Brief pause before next poll
    await Bun.sleep(500);
  }

  return {
    shape: "systemd_unit_restart",
    body: {
      success: false,
      active: false,
      unit,
      startup_ms: Date.now() - started,
      error: `unit did not reach active within ${timeoutMs}ms`,
    },
  };
}
