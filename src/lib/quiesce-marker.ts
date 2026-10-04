/**
 * THE ADMISSION MARKER, READ. pull-sync closes this vessel's admission for long-running work with
 * a marker file and removes it after the restart it drained for, or from its EXIT trap. An EXIT
 * trap does not run on SIGKILL, so a tick systemd killed at TimeoutStartSec left the marker behind
 * and the vessel refused composes with no converger alive. pull-sync therefore writes
 *   {"written_by":"pull-sync","pid":…,"hold":"tick|carry","expires_at":"<ISO-8601 UTC>"}
 * (tick start + the unit's TimeoutStartSec; now + 20 min for a hold carried across ticks), and a
 * marker past its expires_at reads as ABSENT.
 *
 * The mtime staleness bound (maxMs) stays as a backstop in every case: a converger that died must
 * not close admission forever, whatever the marker claims. A marker with no expires_at, or one that
 * does not parse (an older pull-sync, vessel-mitosis-cutover's `: >`), follows that bound alone.
 */
import { readFileSync, statSync } from "node:fs";

/** The marker's expiry in epoch ms, or null when it states none that parses. */
export function markerExpiresAt(raw: string): number | null {
  const text = raw.trim();
  if (!text.startsWith("{")) return null;
  try {
    const v = (JSON.parse(text) as { expires_at?: unknown }).expires_at;
    if (typeof v !== "string") return null;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/** true iff the marker at `path` closes admission now. */
export function markerQuiesced(path: string, maxMs: number, nowMs: number = Date.now()): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return false;
  }
  if (nowMs - mtimeMs >= maxMs) return false;
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return true; // present and fresh, content unreadable: the legacy rule
  }
  const expiresAt = markerExpiresAt(raw);
  return expiresAt === null ? true : nowMs < expiresAt;
}
