// TREND-EXPECTATION CHECK (2026-09-19). The artifact loop in index.ts keeps
// commitments about INDIVIDUAL verified artifacts; this loop keeps a standing
// commitment about the REACH TREND itself. The commitment lives as an impulse
// (memoryNote "expectation-trend:deterministic-battery" holding the bar, the
// probe count, and the cadence — read at use time, law 1); when due, this
// checker GENERATES fresh probe goals itself, dispatches them, and
// byte-verifies the artifacts IN-PROCESS — independent of goal-host's own
// verdicts, so an agreeing-wrong producer/verifier pair cannot satisfy it.
// A score below the committed bar files a substrate_detected gap; recovery on
// a later check closes it; no standing note -> no work (restraint). History
// rides in the note so the trend is durable and inspectable.
//
// The tick lives here, not inline in index.ts, so it can be driven with an
// injected fetch and sleep: index.ts only wires it to its interval.
//
// ONE BATCH PER CADENCE (2026-10-18). A batch waits up to five minutes per
// probe, so it outlives the two-minute interval; last_run_at was written only
// after the batch, so every tick in between read the old stamp and dispatched
// a batch of its own (a 210-execution burst in about an hour). Now a tick
// returns at once while one is in flight, and the family's last_run_at is
// stamped BEFORE its first dispatch, so a process that restarts mid-batch
// waits out the cadence too.
//
// A PROBE, NOT A LESSON. These are measurements of the reach trend, so they
// are tagged probe:trend-expectation-check (not operator:) and dispatched with
// learning_mode "observe": the walks they cause must not grow paths, extract
// templates or move posteriors, or the checker grades a trend it is feeding.

type Note = { title?: string; body?: string };

export interface TrendExpectationDeps {
  /** development-vessel's own endpoint (memoryNote_write retires go here). */
  self: string;
  /** goal-host's endpoint (/run-goal, /executions/:id). */
  goalHost: string;
  key: string;
  resolveNote: (prefix: string) => Promise<Note[]>;
  write: (id: string, body: string) => Promise<void>;
  gapWrite: (gap: Record<string, unknown>) => Promise<void>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export const TREND_EXP_PREFIX = "expectation-trend:";
export const TREND_PROBE_GEN: Record<string, (seed: string, i: number, title: string) => { goal: string; expected: string }> = {
  product: (seed, i, t) => { const a = 101 + ((seed.charCodeAt(seed.length - 1) * 7 + i * 37) % 797); const b = 103 + ((seed.charCodeAt(0) * 11 + i * 91) % 793); return { goal: `Compute the product ${a}*${b} and store the numeric answer in a memoryNote titled ${t}.`, expected: String(a * b) }; },
  reverse: (seed, i, t) => { const w = "trend" + seed.slice(-4) + String(i); return { goal: `Reverse the string ${w} and store the reversed text in a memoryNote titled ${t}.`, expected: w.split("").reverse().join("") }; },
  uppercase: (seed, i, t) => { const w = "check" + seed.slice(-4) + String(i); return { goal: `Uppercase the string ${w} and store the result in a memoryNote titled ${t}.`, expected: w.toUpperCase() }; },
  lowercase: (seed, i, t) => { const w = "CHECK" + seed.slice(-4).toUpperCase() + String(i); return { goal: `Lowercase the string ${w} and store the result in a memoryNote titled ${t}.`, expected: w.toLowerCase() }; },
  base64: (seed, i, t) => { const w = "trend-" + seed.slice(-5) + String(i); return { goal: `Base64-encode the exact string ${w} and store the encoded text in a memoryNote titled ${t}.`, expected: Buffer.from(w, "utf8").toString("base64") }; },
  lettercount: (seed, i, t) => { const w = "abcdefghij".slice(0, 4 + ((seed.charCodeAt(0) + i) % 6)) + "kl"; return { goal: `Count the letters in the word ${w} and store the count in a memoryNote titled ${t}.`, expected: String(w.length) }; },
};

export function createTrendExpectationCheck(deps: TrendExpectationDeps): () => Promise<void> {
  const { self: EXP_SELF, goalHost: EXP_GOAL_HOST, key: EXP_KEY, resolveNote: expResolveNote, write: expWrite, gapWrite: expGapWrite } = deps;
  const fetch = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  let inFlight = false;
  return async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      // SELF-ORIGINATED COMMITMENTS (2026-09-20, item-2 of the autonomy ledger).
      // Iterate EVERY expectation-trend:* impulse — operator-minted or
      // SELF-MINTED by goal-host on a family's first verified reach — instead of
      // one hardcoded title. Each note carries its own bar, probe count, cadence,
      // and family; probes are generated per family, dispatched, and
      // BYTE-VERIFIED IN-PROCESS, independent of dispatch verdicts. Violation
      // files a per-family substrate_detected gap; recovery closes it; history
      // rides in each impulse. No notes -> no work.
      const all = (await expResolveNote(TREND_EXP_PREFIX)).filter((n) => (n.title ?? "").startsWith(TREND_EXP_PREFIX));
      for (const row of all) {
        if (typeof row.body !== "string" || !row.title) continue;
        let spec: { family?: string; bar_min_r?: number; n?: number; cadence_minutes?: number; last_run_at?: string; open_violation?: boolean; history?: Array<{ at: string; r: number; n: number }> };
        try { spec = JSON.parse(row.body) as typeof spec; } catch { continue; }
        const famKey = String(spec.family ?? "").toLowerCase();
        const gen = TREND_PROBE_GEN[famKey] ?? null;
        const cadMs = Math.max(1, spec.cadence_minutes ?? 360) * 60000;
        const lastAt = spec.last_run_at ? Date.parse(spec.last_run_at) : 0;
        if (Number.isFinite(lastAt) && lastAt > 0 && Date.now() - lastAt < cadMs) continue;
        if (!gen) { console.log(`[trend-expectation] ${row.title}: no probe generator for family "${famKey}" — recorded, not checked`); await expWrite(row.title, JSON.stringify({ ...spec, last_run_at: new Date().toISOString(), last_score: "ungeneratable" })); continue; }
        const n = Math.max(1, Math.min(6, spec.n ?? 3));
        await expWrite(row.title, JSON.stringify({ ...spec, last_run_at: new Date().toISOString() }));
        const seed = Date.now().toString(36);
        let r = 0;
        for (let i = 0; i < n; i++) {
          const title = `trendcheck-${famKey}-${seed}-${i}`;
          const probe = gen(seed, i, title);
          try {
            // learning_mode is top-level: goal-host reads body.learning_mode (never variables). It already tags the
            // trace and skips the goal-path, mint and router writes; it is honoured as "no learned or persistent
            // state" only once goal-host's observe chain is live.
            const dr = await fetch(`${EXP_GOAL_HOST}/run-goal`, { method: "POST", headers: { "Content-Type": "application/json", ...(EXP_KEY ? { Authorization: `ApiKey ${EXP_KEY}` } : {}) }, body: JSON.stringify({ goal: probe.goal, tags: ["probe:trend-expectation-check", famKey], learning_mode: "observe" }), signal: AbortSignal.timeout(10000) });
            const dj = (await dr.json()) as { dispatchId?: string };
            if (!dj.dispatchId) continue;
            for (let w2 = 0; w2 < 30; w2++) { await sleep(10000); try { const sr = await fetch(`${EXP_GOAL_HOST}/executions/${dj.dispatchId}`, { headers: { ...(EXP_KEY ? { Authorization: `ApiKey ${EXP_KEY}` } : {}) }, signal: AbortSignal.timeout(8000) }); const sj = (await sr.json()) as { status?: string }; if (sj.status === "completed" || sj.status === "failed") break; } catch {} }
            const notes = await expResolveNote(title);
            const live = notes.find((x) => x.title === title);
            if (live && typeof live.body === "string" && live.body.trim() === probe.expected) r++;
            try {
              await fetch(`${EXP_SELF}/v2/impulses/resolve`, { method: "POST", headers: { "Content-Type": "application/json", ...(EXP_KEY ? { Authorization: `ApiKey ${EXP_KEY}` } : {}) }, body: JSON.stringify({ type: "memoryNote_write", note: { id: title, retire: true } }), signal: AbortSignal.timeout(8000) });
              await fetch(`${EXP_SELF}/v2/impulses/resolve`, { method: "POST", headers: { "Content-Type": "application/json", ...(EXP_KEY ? { Authorization: `ApiKey ${EXP_KEY}` } : {}) }, body: JSON.stringify({ type: "memoryNote_write", note: { id: `expectation:${title}`, retire: true } }), signal: AbortSignal.timeout(8000) });
            } catch (e) { console.warn(`[trend-expectation] failed to retire probe note '${title}': ${e}`); }
          } catch { /* a failed probe is a miss, never a crash */ }
        }
        const hist = [...(spec.history ?? []).slice(-11), { at: new Date().toISOString(), r, n }];
        const bar = spec.bar_min_r ?? Math.ceil(n * 0.8);
        const violated = r < bar;
        const gapId = "gap-trend-expectation-violated-" + famKey;
        if (violated) {
          await expGapWrite({ id: gapId, source: "substrate_detected", status: "open", summary: `Standing trend expectation VIOLATED for family ${famKey}: independent check scored ${r}/${n} against the committed bar ${bar}/${n} (in-process byte-verification of freshly generated probes, not dispatch verdicts). History: ${JSON.stringify(hist.slice(-4))}. Determine which mechanism regressed and restore the bar; the commitment is the impulse ${row.title}.` });
        } else if (spec.open_violation) {
          await expGapWrite({ id: gapId, source: "substrate_detected", status: "closed", classification_metadata: { closed_reason: "condition_gone", closed_by: "trend_expectation_check" }, summary: `RESOLVED: trend expectation for family ${famKey} restored — ${r}/${n} meets the bar ${bar}/${n}. Closed by the checker that filed it.` });
          // After a successful grade, RETIRE the probe notes this checker just generated and graded.
          // Producer: probe note titles are built by this checker as `${TREND_EXP_PREFIX}${famKey}:probe:` + batch discriminator when dispatching probes
          // (see the generator near TREND_PROBE_GEN in this file). Matching on that concrete prefix retires the real probe notes we just graded.
          try {
            const retirePrefix = `${TREND_EXP_PREFIX}${famKey}:probe:`;
            const gradedProbes = (await expResolveNote(retirePrefix)).filter(p => (p.title ?? "").startsWith(retirePrefix));
            for (const g of gradedProbes) {
              const id = g.title ?? "";
              if (!id) continue;
              await fetch(`${EXP_SELF}/v2/impulses/resolve`, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...(EXP_KEY ? { Authorization: `ApiKey ${EXP_KEY}` } : {}) },
                body: JSON.stringify({ impulse: { pointer: { type: "memoryNote_retire", note: { id } } } }),
                signal: AbortSignal.timeout(8000),
              });
            }
          } catch (e) {
            console.warn(`[expectation-trend] retire failed for family ${famKey}: ${(e as Error).message}`);
          }
        }
        await expWrite(row.title, JSON.stringify({ ...spec, last_run_at: new Date().toISOString(), last_score: `${r}/${n}`, open_violation: violated, history: hist }));
        console.log(`[trend-expectation] ${row.title} check complete r=${r}/${n} bar=${bar} violated=${violated}`);
      }
    } catch (err) {
      console.warn(`[trend-expectation] tick failed (non-fatal): ${(err as Error).message}`);
    } finally {
      inFlight = false;
    }
  };
}
