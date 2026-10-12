// THE ROUTING CORPUS CLI (closed). The admission glue and the operator call this; nothing here decides admission.
//   bun test/routing-corpus/cli.ts run --json                    every case replayed; the CorpusReport as JSON
//   bun test/routing-corpus/cli.ts append-check --from <n>       cases n.. must carry the status this tree observes
//   bun test/routing-corpus/cli.ts append <case.json> [--slug s] operator act: canonicalise, number, observe, append
//   bun test/routing-corpus/cli.ts heldout --sample <f> --json   replay JSONL records ({record_hash, entry, input, ports,
//                                                                llm}) and print each record's decision
// Exit codes: 0 ok, 1 a check failed, 2 usage.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendCheck, canonical, ENTRIES, manifestLine, observedStatus, replayCase, runCorpus, sha256, verifyChain, type RoutingCase } from "./runner";

const DIR = import.meta.dir;
const [cmd, ...rest] = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };

async function main(): Promise<number> {
  if (cmd === "run") {
    const r = await runCorpus(DIR);
    console.log(JSON.stringify(r, null, rest.includes("--json") ? 0 : 2));
    return r.problems.length === 0 && r.flips.length === 0 && r.nondeterministic.length === 0 ? 0 : 1;
  }
  if (cmd === "append-check") {
    const from = Number(opt("--from") ?? "1");
    if (!Number.isInteger(from) || from < 1) return 2;
    const r = await appendCheck(DIR, from);
    console.log(JSON.stringify({ ok: r.ok, from, checked: r.report.cases.length, mismatches: r.mismatches }));
    return r.ok ? 0 : 1;
  }
  if (cmd === "append") {
    const file = rest[0];
    if (!file || !existsSync(file)) return 2;
    const chain = verifyChain(DIR);
    const fresh = chain.n === 0 && chain.problems.length === 1 && /absent|empty/.test(chain.problems[0]!);
    if (chain.problems.length && !fresh) { console.error(chain.problems.join("\n")); return 1; }
    const c = JSON.parse(readFileSync(file, "utf8")) as RoutingCase & { slug?: string };
    const slug = opt("--slug") ?? c.slug ?? c.class;
    delete (c as { slug?: string }).slug;
    const n = chain.n + 1;
    c.id = `${String(n).padStart(4, "0")}-${slug}`;
    const r = await replayCase(c);
    const status = observedStatus(r.observed);
    if (!status) { console.error(`${c.id}: observed ${r.observed} (${r.reason}); not appended`); return 1; }
    if (c.status_at_append && c.status_at_append !== status) { console.error(`${c.id}: declared ${c.status_at_append}, observed ${status} (${r.reason ?? "match"}); not appended`); return 1; }
    c.status_at_append = status;
    const rel = `cases/${c.class}/${c.id}.json`;
    mkdirSync(join(DIR, "cases", c.class), { recursive: true });
    const bytes = canonical(c);
    writeFileSync(join(DIR, rel), bytes);
    appendFileSync(join(DIR, "MANIFEST.jsonl"), JSON.stringify(manifestLine(n, c.id, rel, sha256(bytes), chain.link)) + "\n");
    console.log(JSON.stringify({ appended: c.id, status, got: r.got, reason: r.reason }));
    return 0;
  }
  if (cmd === "heldout") {
    const f = opt("--sample");
    if (!f || !existsSync(f)) return 2;
    const out: Array<{ record_hash: string; decision: unknown; error: string | null }> = [];
    for (const line of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
      const rec = JSON.parse(line) as { record_hash: string; entry: string; input: unknown; ports: RoutingCase["ports"]; llm: RoutingCase["llm"] };
      if (!ENTRIES[rec.entry]) { out.push({ record_hash: rec.record_hash, decision: null, error: `no entry ${rec.entry}` }); continue; }
      const r = await replayCase({ schema: 1, id: "heldout", class: "heldout", entry: rec.entry, credit_class: null, edit_site: "", provenance: { source: "live-run", recorded: "", note: "" }, input: rec.input, ports: rec.ports, llm: rec.llm, expect: {}, status_at_append: "green", control: false, licenses: null });
      out.push({ record_hash: rec.record_hash, decision: r.observed === "green" ? r.got : null, error: r.observed === "green" ? null : r.reason });
    }
    console.log(JSON.stringify({ records: out }));
    return 0;
  }
  console.error("usage: cli.ts run --json | append-check --from <n> | append <case.json> [--slug s] | heldout --sample <f> --json");
  return 2;
}
process.exit(await main());
