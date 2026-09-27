/*
Producer of the matched log lines: src/restart-attribution.ts
- It emits lines tagged with "[restart-attribution] restarted by ", for example:
  "[restart-attribution] restarted by mitosis-cutover: cutover development-vessel-fc-2026-09-25T02-00-06-419Z — it observed 2 in flight, so this restart was LOSSY"
- This resolver matches exactly that prefix and parses:
  - requester: the token after "restarted by ", up to the colon
  - vessel: when a "cutover <cutover-id>" is present, the repo prefix before "-fc-" or "-resume-"
  - in_flight: the integer after "observed " if present
  - lossy: whether the line contains the substring "LOSSY"
The predicates are true against the concrete string above from restart-attribution.ts and systemd journal output.
*/

export type ComposerInterruptionPointer = { type: "composerInterruptionReport"; hours?: number };

type Entry = {
  requester: string;
  vessel?: string;
  in_flight: number;
  lossy: boolean;
  foreign_cutover: boolean;
  raw: string;
};

async function getOwnedVesselsSafe(): Promise<Set<string>> {
  try {
    const mod = await import("./gap-to-feature.js");
    const fn = (mod as unknown as { ownedVessels?: () => Promise<Iterable<string>> | Iterable<string> }).ownedVessels;
    const owned = typeof fn === "function" ? await fn() : undefined;
    const s = new Set<string>();
    if (owned && (owned as unknown as { [Symbol.iterator]: unknown })[Symbol.iterator]) {
      for (const v of owned as Iterable<unknown>) {
        if (typeof v === "string" && v.length > 0) s.add(v);
      }
    }
    return s;
  } catch {
    return new Set<string>();
  }
}

function parseRestartLine(line: string): { requester: string; vessel?: string; in_flight: number; lossy: boolean } | null {
  const tag = "[restart-attribution] restarted by ";
  const i = line.indexOf(tag);
  if (i < 0) return null;
  const after = line.slice(i + tag.length);
  const colon = after.indexOf(":");
  const requester = (colon >= 0 ? after.slice(0, colon) : after).trim().split(/\s+/)[0] ?? "";
  if (!requester) return null;
  let vessel: string | undefined;
  const cutIdx = line.indexOf("cutover ");
  if (cutIdx >= 0) {
    const afterCut = line.slice(cutIdx + "cutover ".length);
    const token = afterCut.split(/[ \t\u2014]/)[0] ?? ""; // stop at space or em-dash
    const m = /^(.+?)-(fc|resume)-/.exec(token);
    if (m && m[1]) vessel = m[1];
  }
  let in_flight = 0;
  const m2 = /observed\s+(\d+)/.exec(line);
  if (m2 && m2[1]) {
    const n = Number(m2[1]);
    if (Number.isFinite(n)) in_flight = n;
  }
  const lossy = line.includes("LOSSY");
  return { requester, vessel, in_flight, lossy };
}

export async function resolveComposerInterruptionSweep(pointer: ComposerInterruptionPointer): Promise<{ shape: "composerInterruptionReport"; body: Record<string, unknown> }> {
  const hours = Number.isFinite(pointer.hours ?? NaN) ? Number(pointer.hours) : 1;
  const node = String(process.env["SUBSTRATE_NAME"] ?? "substrate");

  // Read systemd journal for the development-vessel unit, mirroring the pipe pattern used by systemd-unit-health-observer.ts
  const args = [
    "-u",
    "development-vessel",
    "--since",
    `-${hours}h`,
    "--no-pager",
    "-o",
    "cat",
  ];
  let stdout = "";
  let stderr = "";
  try {
    const proc = Bun.spawn(["journalctl", ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([
      proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
      proc.stderr ? new Response(proc.stderr).text() : Promise.resolve("")
    ]);
    stdout = out;
    stderr = err;
    await proc.exited;
  } catch {
    // fall through — treated as empty read
  }

  const all = (stdout + (stderr ? "\n" + stderr : "")).split(/\r?\n/);
  const lines_read = all.filter((l) => l.trim().length > 0).length;
  const restartLines = all.filter((l) => l.includes("[restart-attribution] restarted by "));

  if (lines_read === 0) {
    return {
      shape: "composerInterruptionReport",
      body: {
        node,
        hours,
        lines_read,
        restarts: 0,
        lossy: 0,
        foreign_cutovers: null, // empty read must not look like a quiet hour
        detail: "journal unreadable",
        entries: [] as Entry[],
      },
    };
  }

  const owned = await getOwnedVesselsSafe();

  if (owned.size === 0) {
    return { shape: "composerInterruptionReport", body: { node, hours, lines_read, restarts: restartLines.length, lossy: null, foreign_cutovers: null, detail: "owned set unavailable", entries: [] as Entry[] } };
  }
  const entries: Entry[] = [];
  let lossyCount = 0;
  let foreignCount = 0;
  const foreignVessels = new Set<string>();

  for (const line of restartLines) {
    const p = parseRestartLine(line);
    if (!p) continue;
    const foreign_cutover = Boolean(p.vessel && !owned.has(p.vessel));
    if (p.lossy) lossyCount++;
    if (foreign_cutover) {
      foreignCount++;
      if (p.vessel) foreignVessels.add(p.vessel);
    }
    if (entries.length < 50) entries.push({ ...p, foreign_cutover, raw: line });
  }

  const restarts = restartLines.length;

  // When foreign cutovers are observed, write a substrate gap describing them.
  if (foreignCount > 0) {
    const dateTag = new Date().toISOString().slice(0, 10);
    const gapId = `composer-interruption-${node}-${dateTag}`;
    const vessels = Array.from(foreignVessels).sort();
    const summary = `${foreignCount} foreign composer restart(s) observed via cutover: ${vessels.join(", ")}`;
    try {
      const { resolveSubstrateGapWrite } = await import("./substrate-gap.js");
      const res = await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id: gapId, category: "attempt_consequence", source: "substrate_detected", status: "open", detected_at: new Date().toISOString(), summary, classification_metadata: { edit_site: "repos/development-vessel/src/resolvers/gap-to-feature.ts", foreign_cutovers: foreignCount, vessels } } });
      if ((res as { shape?: string }).shape === "structuredError") console.warn(`[composer-interruption-sweep] gap write refused for ${gapId}: ${JSON.stringify((res as { body?: unknown }).body).slice(0, 300)}`);
    } catch (e) {
      console.warn(`[composer-interruption-sweep] gap write failed for ${gapId}: ${(e as Error).message}`);
    }
  }

  return {
    shape: "composerInterruptionReport",
    body: {
      node,
      hours,
      lines_read,
      restarts,
      lossy: lossyCount,
      foreign_cutovers: foreignCount,
      entries,
    },
  };
}
