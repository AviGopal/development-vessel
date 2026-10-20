import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { stampBaseline, readBaseline, stampEnvironmentBaseline } from "../../src/resolvers/causal-adjudication.js";

/**
 * A CALLER'S STRING MUST REACH THE DATABASE AS DATA, NEVER AS STATEMENT TEXT.
 *
 * The baseline stamps spliced `JSON.stringify(pointer)` and quote-stripped ids into SurrealQL.
 * JSON escaping is not SurrealQL quoting, and stripping quotes does not stop a trailing backslash
 * from escaping the closing quote: a gap id ending in `\` put the action id in statement
 * position, so `; CREATE …` in it ran as a statement. Both ids and the whole pointer come from
 * the picked gap, which any authenticated caller can file.
 *
 * Every request is recorded at the fetch boundary, so these tests read exactly what the code
 * sends: the statement text, and the parameters bound beside it. No test here reaches a database.
 */
type Sent = { body: string; vars: Record<string, unknown> };
let sent: Sent[] = [];
const realFetch = globalThis.fetch;
const realWarn = console.warn;
const realLog = console.log;

const SNAPSHOT_ID = "impulse:⟨opstate-1-abc⟩";

beforeEach(() => {
  sent = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = new URL(String(input));
    const vars: Record<string, unknown> = {};
    for (const [k, v] of url.searchParams) vars[k] = JSON.parse(v);
    const body = String(init?.body ?? "");
    sent.push({ body, vars });
    const result = body.includes("shape = 'operationalStateSnapshot'")
      ? [{ id: SNAPSHOT_ID, created_at: new Date().toISOString() }]
      : body.startsWith("INSERT")
        ? [{}]
        : [];
    return new Response(JSON.stringify([{ status: "OK", result }]), { status: 200 });
  }) as unknown as typeof fetch;
  console.warn = () => {};
  console.log = () => {};
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  console.log = realLog;
});

const chars = (s: string) => Array.from(s);
const inserts = () => sent.filter((s) => s.body.startsWith("INSERT"));
const selects = () => sent.filter((s) => s.body.startsWith("SELECT"));

/**
 * The pointer the database would store for a request: the inline JSON the old statement carried,
 * or the bound object with its parameters put back. Only used on benign values (the control).
 */
function storedPointer(s: Sent): Record<string, unknown> {
  const m = /pointer: (\{.*\}), created_at: time::now\(\)/.exec(s.body);
  if (!m) throw new Error(`no pointer in ${s.body}`);
  let text = m[1]!;
  if (!text.startsWith('{"')) {
    text = text
      .replace(/array::join\(\$([a-z_]+), ''\)/g, (_, n: string) => JSON.stringify((s.vars[n] as string[]).join("")))
      .replace(/\$([a-z_]+)/g, (_, n: string) => JSON.stringify(s.vars[n]))
      .replace(/([{,] )([a-z_]+): /g, '$1"$2": ')
      .replace(/: NULL/g, ": null");
  }
  return JSON.parse(text) as Record<string, unknown>;
}

describe("the baseline stamps bind caller values instead of splicing them", () => {
  it("[MUST-FAIL] a gap id ending in a backslash cannot put the action id in statement position", async () => {
    const gapId = "x\\";
    const actionId = "; CREATE pwned:where_clause -- ";
    expect(await stampBaseline(gapId, actionId, { present: false }, "class1")).toBe("stamped");
    for (const s of sent) {
      expect(s.body).not.toContain("pwned");
      expect(s.body).not.toContain("x\\");
    }
    const sel = selects()[0]!;
    expect(sel.body).toBe(
      "SELECT id FROM impulse WHERE shape = 'falsifierBaseline' " +
        "AND pointer.gap_id = array::join($gap_id, '') AND pointer.action_id = array::join($action_id, '') LIMIT 1;",
    );
    // Bound exactly as given: not quote-stripped, not escaped.
    expect(sel.vars).toEqual({ gap_id: chars(gapId), action_id: chars(actionId) });
  });

  it("[MUST-FAIL] the falsifierBaseline INSERT carries its pointer as parameters, not text", async () => {
    const gapId = "g\"}; CREATE pwned:fb; --";
    const actionId = "a'; DELETE impulse; --";
    expect(await stampBaseline(gapId, actionId, { present: true }, "class1")).toBe("stamped");
    const ins = inserts()[0]!;
    expect(ins.body).not.toContain("pwned");
    expect(ins.body).not.toContain("DELETE");
    expect(ins.body).toMatch(
      new RegExp(
        "^INSERT INTO impulse \\{ id: 'fbase-\\d+-[a-z0-9]*', shape: 'falsifierBaseline', org_id: 'organizations:substrate', " +
          "pointer: \\{ gap_id: array::join\\(\\$p_gap_id, ''\\), action_id: array::join\\(\\$p_action_id, ''\\), " +
          "predicate_kind: array::join\\(\\$p_predicate_kind, ''\\), baseline_present: \\$p_baseline_present, " +
          "measurable: \\$p_measurable, stamped_at: array::join\\(\\$p_stamped_at, ''\\) \\}, created_at: time::now\\(\\), budget: 0 \\};$",
      ),
    );
    expect(ins.vars["p_gap_id"]).toEqual(chars(gapId));
    expect(ins.vars["p_action_id"]).toEqual(chars(actionId));
    expect(ins.vars["p_baseline_present"]).toBe(true);
  });

  it("[MUST-FAIL] readBaseline binds both ids", async () => {
    await readBaseline("x\\", "; CREATE pwned:read -- ");
    const sel = selects()[0]!;
    expect(sel.body).not.toContain("pwned");
    expect(sel.body).toBe(
      "SELECT pointer FROM impulse WHERE shape = 'falsifierBaseline' " +
        "AND pointer.gap_id = array::join($gap_id, '') AND pointer.action_id = array::join($action_id, '') " +
        "ORDER BY created_at ASC LIMIT 1;",
    );
    expect(sel.vars).toEqual({ gap_id: chars("x\\"), action_id: chars("; CREATE pwned:read -- ") });
  });

  it("[MUST-FAIL] the environmentBaseline duplicate check and INSERT bind every value", async () => {
    const gapId = "\"}, created_at: d'2000-01-01', z: {\"";
    const actionId = "act'\\; CREATE pwned:env -- ";
    expect(await stampEnvironmentBaseline(gapId, actionId)).toBe("stamped");
    for (const s of sent) {
      expect(s.body).not.toContain("pwned");
      expect(s.body).not.toContain("2000-01-01");
    }
    const dup = selects()[0]!;
    expect(dup.body).toBe(
      "SELECT id FROM impulse WHERE shape = 'environmentBaseline' AND pointer.action_id = array::join($action_id, '') LIMIT 1;",
    );
    expect(dup.vars).toEqual({ action_id: chars(actionId) });
    const ins = inserts()[0]!;
    expect(ins.body).toMatch(
      new RegExp(
        "^INSERT INTO impulse \\{ id: 'ebase-\\d+-[a-z0-9]*', shape: 'environmentBaseline', org_id: 'organizations:substrate', " +
          "pointer: \\{ gap_id: array::join\\(\\$p_gap_id, ''\\), action_id: array::join\\(\\$p_action_id, ''\\), " +
          "baseline_snapshot_id: array::join\\(\\$p_baseline_snapshot_id, ''\\), baseline_snapshot_at: array::join\\(\\$p_baseline_snapshot_at, ''\\), " +
          "stamped_at: array::join\\(\\$p_stamped_at, ''\\) \\}, created_at: time::now\\(\\), budget: 0 \\};$",
      ),
    );
    expect(ins.vars["p_gap_id"]).toEqual(chars(gapId));
    expect(ins.vars["p_action_id"]).toEqual(chars(actionId));
    // Record-shaped, and stored as the string it is: sent as characters, so /sql cannot read it as a record.
    expect(ins.vars["p_baseline_snapshot_id"]).toEqual(chars(SNAPSHOT_ID));
  });
});

describe("CONTROL: a benign pointer stores exactly as before", () => {
  it("falsifierBaseline, measurable and unmeasurable", async () => {
    expect(await stampBaseline("gap-benign", "pick-gap-benign-2026-10-20T23", { present: true }, "class1")).toBe("stamped");
    expect(await stampBaseline("gap-benign-2", "pick-gap-benign-2-2026-10-20T23", null, "class2")).toBe("stamped");
    const [a, b] = inserts().map(storedPointer);
    expect(typeof a!["stamped_at"]).toBe("string");
    expect(typeof b!["stamped_at"]).toBe("string");
    delete a!["stamped_at"];
    delete b!["stamped_at"];
    expect(a).toEqual({ gap_id: "gap-benign", action_id: "pick-gap-benign-2026-10-20T23", predicate_kind: "class1", baseline_present: true, measurable: true });
    expect(b).toEqual({ gap_id: "gap-benign-2", action_id: "pick-gap-benign-2-2026-10-20T23", predicate_kind: "class2", baseline_present: null, measurable: false });
  });

  it("environmentBaseline with a snapshot reference", async () => {
    expect(await stampEnvironmentBaseline("gap-benign", "pick-gap-benign-2026-10-20T23:30")).toBe("stamped");
    const p = storedPointer(inserts()[0]!);
    expect(typeof p["baseline_snapshot_at"]).toBe("string");
    expect(typeof p["stamped_at"]).toBe("string");
    delete p["baseline_snapshot_at"];
    delete p["stamped_at"];
    expect(p).toEqual({ gap_id: "gap-benign", action_id: "pick-gap-benign-2026-10-20T23:30", baseline_snapshot_id: SNAPSHOT_ID });
  });
});
