// interface_deploy_reach_check v0 skeleton: scores interface deploys against post-deploy interaction (scan wired next).
import type { ResolverResult } from "./types.js";

export interface InterfaceDeployReachCheckPointer {
  type: "interface_deploy_reach_check";
  max_deploys?: number;
}

export async function resolveInterfaceDeployReachCheck(pointer: InterfaceDeployReachCheckPointer): Promise<ResolverResult> {
  const cap = typeof pointer.max_deploys === "number" ? pointer.max_deploys : 10;
  let lines: string[] = [];
  try { lines = (await Bun.file("/workspace/proposals/interface-deploys.jsonl").text()).split("\n").filter((l) => l.trim().length > 0); } catch { }
  let lastEventAt = 0;
  let surfaceUp = false;
  try {
    const endpoint = process.env["OBSIDIAN_LEARN_ENDPOINT"] ?? "http://127.0.0.1:27182";
    const res = await fetch(endpoint + "/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ impulse: { pointer: { type: "obsidian:presence_rhythm" } } }), signal: AbortSignal.timeout(10000) });
    const json = (await res.json()) as { content?: string };
    const parsed = json.content ? (JSON.parse(json.content) as { last_event_at?: string }) : {};
    surfaceUp = true;
    if (typeof parsed.last_event_at === "string") lastEventAt = Date.parse(parsed.last_event_at);
  } catch { }
  const deploys = lines.slice(-cap).map((l) => {
    try {
      const rec = JSON.parse(l) as { at?: string; vessel?: string };
      const t = Date.parse(String(rec.at ?? ""));
      const verdict = !surfaceUp ? "regressed" : (lastEventAt > t ? "healthy" : "unscored_absent");
      return { at: String(rec.at ?? ""), vessel: String(rec.vessel ?? ""), verdict };
    } catch { return { at: "", vessel: "", verdict: "unparseable" }; }
  });
  return { shape: "interfaceDeployReachReport", body: { deploys, scanned: true, surface_up: surfaceUp, last_event_at_ms: lastEventAt, max_deploys: cap } };
}
