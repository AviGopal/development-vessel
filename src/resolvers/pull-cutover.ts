// pull_cutover — the substrate's own DEPLOY step, as a producer.
//
// Converges ONE named vessel's live /vessels runtime to origin/dev and restarts
// it, health-gated, so the escalation seam (boredom baseline-doom-signal ->
// gap-goal:pull_cutover) can actually REPAIR a lagged/broken vessel instead of
// landing on a hollow satisfier. This is exactly the operator's by-hand deploy:
//   git fetch+reset --hard origin/dev ; mirror-to-live <v> ; systemctl restart <v>
//
// REORGANIZE-FIRST: reuses the existing deploy primitives rather than a new path
// - mirror-to-live (canonical src->/vessels mirror; reset --hard HEAD + file: rewrite)
// - the mitosis systemd-run deferral (PID1-owned transient unit) for self-restart
// - pull-sync health_port()/healthy() + .last-good revert semantics
//
// SAFETY ENVELOPE (blast radius: git-resets a clone, mirrors to LIVE runtime,
// restarts a unit):
// - BOUNDED: vessel_name must be in vessels.inventory.json .vessels[].repo.
// - SELF-RESTART-SAFE: if the target hosts THIS resolver (development-vessel) or is
//   the tools/goal-host, defer the restart via systemd-run so we don't self-kill.
// - HEALTH-GATED + REVERT: after an inline restart, poll /health; on failure revert
//   the clone+runtime to the prior sha and restart back. (Deferred restarts fire
//   after we return, so their health is checked by the next pull-sync/scan, not here.)
// - IDEMPOTENT: already-converged (runtime sha == origin/dev sha) returns
//   deployed:false WITHOUT restarting.
// - dry_run is TRULY read-only: it mutates nothing (no fetch/reset/mirror/restart).

interface PullCutoverPointer {
  type: "pull_cutover";
  vessel_name: string;
  dry_run?: boolean;
}

interface PullCutoverReport {
  vessel_name: string;
  valid: boolean;
  lagged: boolean;        // runtime behind origin/dev before this run
  head_sha: string;       // origin/dev sha the runtime was converged to (or current)
  deployed: boolean;      // mirror-to-live landed new src
  restarted: boolean | "scheduled"; // inline restart done, or deferred (self/host)
  healthy: boolean;       // post-restart /health == 200 (true when not applicable)
  reverted: boolean;      // health failed -> rolled back to prior sha
  dry_run: boolean;
  note?: string;
}

const CLONE_DIR = "/workspace/git/vessels";
const INVENTORY = process.env["VESSELS_INVENTORY"] ?? "/workspace/substrate/fleet/vessels.inventory.json";
const SELF_VESSEL = process.env["VESSEL_ID"] ?? process.env["FED_VESSEL_ID"] ?? "development-vessel";
// Vessels whose restart from THIS process would kill the caller or the dispatch
// host: development-vessel (our host), goal-host (dispatch owner), the tools vessel.
const DEFER_RESTART = new Set<string>([SELF_VESSEL, "development-vessel", "goal-host-vessel", "local-tools-vessel"]);

async function sh(cmd: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  const out = (await new Response(proc.stdout).text()).trim();
  const err = (await new Response(proc.stderr).text()).trim();
  return { ok: proc.exitCode === 0, out, err };
}

async function allowedVessels(): Promise<Set<string>> {
  try {
    const inv = JSON.parse(await Bun.file(INVENTORY).text()) as { vessels?: Array<{ repo?: string }> };
    return new Set((inv.vessels ?? []).map((v) => v.repo).filter((r): r is string => typeof r === "string" && r.length > 0));
  } catch {
    return new Set();
  }
}

async function healthPort(vessel: string): Promise<number | null> {
  try {
    const inv = JSON.parse(await Bun.file(INVENTORY).text()) as { vessels?: Array<{ repo?: string; health_port?: number }> };
    const row = (inv.vessels ?? []).find((v) => v.repo === vessel);
    return typeof row?.health_port === "number" ? row.health_port : null;
  } catch {
    return null;
  }
}

async function healthy(port: number): Promise<boolean> {
  // pull-sync healthy(): 200 on /health. Poll a few times to allow warmup.
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000) });
      if (res.status === 200) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

async function deferredRestart(unit: string): Promise<boolean> {
  // Mitosis pattern: PID1-owned transient unit fires after this process returns,
  // so restarting our own host / the dispatch host does not self-kill mid-resolve.
  const sysdRun = process.env["SYSTEMD_RUN_CMD"] ?? "systemd-run";
  const tsUnit = `pull-cutover-restart-${unit}`;
  const r = await sh([sysdRun, `--on-active=5s`, `--unit=${tsUnit}`, "--collect", "systemctl", "restart", unit]);
  return r.ok;
}

export async function resolvePullCutover(pointer: PullCutoverPointer): Promise<{
  shape: string;
  body: PullCutoverReport;
}> {
  const { vessel_name, dry_run = false } = pointer;
  const base = (v: Partial<PullCutoverReport>): { shape: string; body: PullCutoverReport } => ({
    shape: "pullCutoverReport",
    body: {
      vessel_name, valid: false, lagged: false, head_sha: "", deployed: false,
      restarted: false, healthy: true, reverted: false, dry_run, ...v,
    },
  });

  // 1. BOUND: only a known vessel.
  const allowed = await allowedVessels();
  if (!allowed.has(vessel_name)) {
    return base({ valid: false, note: `vessel_name '${vessel_name}' not in vessels.inventory; refusing cutover` });
  }
  const cloneDir = `${CLONE_DIR}/${vessel_name}`;

  // 2. Read current state (no mutation).
  const priorSha = (await sh(["git", "-C", cloneDir, "rev-parse", "HEAD"])).out;
  const originSha = (await sh(["git", "-C", cloneDir, "ls-remote", "origin", "dev"])).out.split(/\s+/)[0] ?? "";
  const lagged = originSha.length > 0 && originSha !== priorSha;

  if (dry_run) {
    return base({ valid: true, lagged, head_sha: originSha || priorSha, note: lagged ? "runtime behind origin/dev; cutover would converge" : "already converged" });
  }
  if (!lagged) {
    // IDEMPOTENT: nothing to do, do NOT restart a healthy converged vessel.
    return base({ valid: true, lagged: false, head_sha: priorSha, deployed: false, restarted: false, note: "already converged (no-op)" });
  }

  // 3. CONVERGE: fetch+reset the clone to origin/dev, then mirror src -> /vessels.
  const fetched = await sh(["git", "-C", cloneDir, "fetch", "-q", "origin", "dev"]);
  if (!fetched.ok) return base({ valid: true, lagged, head_sha: originSha, note: `git fetch failed: ${fetched.err.slice(0, 160)}` });
  await sh(["git", "-C", cloneDir, "reset", "--hard", "-q", "origin/dev"]);
  const headSha = (await sh(["git", "-C", cloneDir, "rev-parse", "HEAD"])).out;
  const mirrored = await sh(["mirror-to-live", vessel_name]);
  const deployed = mirrored.ok;
  if (!deployed) {
    return base({ valid: true, lagged, head_sha: headSha, deployed: false, note: `mirror-to-live failed: ${mirrored.err.slice(0, 160)}` });
  }

  // 4. RESTART (self-restart-safe).
  const unit = `${vessel_name}.service`;
  if (DEFER_RESTART.has(vessel_name)) {
    const ok = await deferredRestart(unit);
    // Health of a deferred restart is judged by the next scan/pull-sync, not here.
    return base({ valid: true, lagged, head_sha: headSha, deployed: true, restarted: ok ? "scheduled" : false, healthy: true, note: ok ? "restart deferred via systemd-run (self/host-safe)" : "systemd-run failed" });
  }
  const restart = await sh(["systemctl", "restart", unit]);
  const restarted = restart.ok;

  // 5. HEALTH-GATE + REVERT (inline restarts only).
  const port = await healthPort(vessel_name);
  let ok = true;
  if (restarted && port !== null) {
    ok = await healthy(port);
    if (!ok) {
      // Revert clone+runtime to prior sha, restart back.
      await sh(["git", "-C", cloneDir, "reset", "--hard", "-q", priorSha]);
      await sh(["mirror-to-live", vessel_name]);
      await sh(["systemctl", "restart", unit]);
      return base({ valid: true, lagged, head_sha: priorSha, deployed: true, restarted: true, healthy: false, reverted: true, note: `converged to ${headSha.slice(0, 10)} but unhealthy; reverted to ${priorSha.slice(0, 10)}` });
    }
  }
  return base({ valid: true, lagged, head_sha: headSha, deployed: true, restarted, healthy: ok, note: `converged ${priorSha.slice(0, 10)} -> ${headSha.slice(0, 10)}` });
}
