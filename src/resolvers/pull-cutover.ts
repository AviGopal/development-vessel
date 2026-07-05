
interface PullCutoverPointer {
  type: "pull_cutover";
  vessel_name: string;
  dry_run?: boolean;
}

interface PullCutoverReport {
  vessel_name: string;
  pulled: boolean;
  deployed: boolean;
  restarted: boolean;
  dry_run: boolean;
}

async function runCommand(cmd: string[]): Promise<{ ok: boolean; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  const ok = proc.exitCode === 0;
  const stderrBuf = await new Response(proc.stderr).text();
  return { ok, stderr: stderrBuf };
}

export async function resolvePullCutover(pointer: PullCutoverPointer): Promise<{
  shape: string;
  body: PullCutoverReport;
}> {
  const { vessel_name, dry_run = false } = pointer;

  // Step 1: pull — restart git-push-setup so clone is reset to origin/dev
  const pullResult = await runCommand(["systemctl", "restart", "git-push-setup"]);
  const pulled = pullResult.ok;

  let deployed = false;
  let restarted = false;
  const shaProc = Bun.spawn(["git", "-C", `/workspace/git/vessels/${vessel_name}`, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  await shaProc.exited;
  const currentSha = (await new Response(shaProc.stdout).text()).trim();
  const markerPath = `/vessels/${vessel_name}/.pull-cutover-deployed-sha`;
  const priorSha = (await Bun.file(markerPath).text().catch(() => "")).trim();
  if (currentSha.length > 0 && currentSha === priorSha) {
    return { shape: "pullCutoverReport", body: { vessel_name, pulled, deployed: false, restarted: false, dry_run } };
  }

  if (!dry_run) {
    // Step 2: deploy — copy src from git clone into live vessel
    const src = `/workspace/git/vessels/${vessel_name}/src`;
    const dest = `/vessels/${vessel_name}/src`;
    const deployResult = await runCommand(["cp", "-a", src, dest]);
    deployed = deployResult.ok;

    if (deployed && currentSha.length > 0) { await Bun.write(markerPath, currentSha); }
    // Step 3: restart the vessel service
    const restartResult = await runCommand(["systemctl", "restart", vessel_name]);
    restarted = restartResult.ok;
  }

  if (!dry_run && deployed && restarted && currentSha.length > 0) {
    await Bun.write(markerPath, currentSha);
  }
  return {
    shape: "pullCutoverReport",
    body: {
      vessel_name,
      pulled,
      deployed,
      restarted,
      dry_run,
    },
  };
}
