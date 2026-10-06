// The self-fact judge reads its rows (expected trust-root values) only through a gate-fed marker
// (/workspace/.gate-public/source.json, written by pull-sync as root). A test that exercises the
// ungated path (rows from origin/dev, today's behaviour) declares it with this helper.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function useUngatedRowsSource(): string {
  const dir = join(tmpdir(), `gate-public-ungated-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "source.json"), JSON.stringify({ schema: 1, gated: false, source: "clone", accepted_sha: null, self_facts_sha256: null, writer: "pull-sync", written_at: new Date().toISOString() }));
  process.env["SELF_FACTS_PUBLIC_DIR"] = dir;
  return dir;
}
