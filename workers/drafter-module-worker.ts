type DrafterEntry = "planDrafterReads" | "assembleDrafterContext";
type WorkerInput = { variant: string; entry: DrafterEntry; facts: unknown };

declare const self: Worker;

function drafterVariantAllowlisted(id: string): string {
  if (!/^drafter-v[0-9]+[a-z0-9-]*$/.test(id)) throw new Error("variant id is outside the allowlist");
  return id;
}

async function loadDrafterModule(variant: string): Promise<{ ok: true; module: { planDrafterReads: unknown; assembleDrafterContext: unknown } } | { ok: false; error: string }> {
  if (variant !== "drafter-v1" && !/^drafter-v[0-9]+[a-z0-9-]*$/.test(variant)) return { ok: false, error: "variant id is outside the allowlist" };
  try {
    const { planDrafterReads, assembleDrafterContext } = await import(variant === "drafter-v1" ? "../src/drafter/index.js" : `../src/drafter/variants/${drafterVariantAllowlisted(variant)}/index.js`);
    return { ok: true, module: { planDrafterReads, assembleDrafterContext } };
  } catch (err) {
    return { ok: false, error: `import_failed: ${String((err as Error)?.message ?? err).slice(0, 220)}` };
  }
}

async function handleDrafterModule(input: WorkerInput): Promise<void> {
  if (!input || (input.entry !== "planDrafterReads" && input.entry !== "assembleDrafterContext")) {
    self.postMessage({ ok: false, error: "invalid worker request" });
    return;
  }
  const loaded = await loadDrafterModule(input.variant);
  if (!loaded.ok) {
    self.postMessage({ ok: false, error: loaded.error });
    return;
  }
  const { planDrafterReads, assembleDrafterContext } = loaded.module;
  const fn = input.entry === "planDrafterReads" ? planDrafterReads : assembleDrafterContext;
  if (typeof fn !== "function") { self.postMessage({ ok: false, error: `module_shape: missing ${input.entry}` }); return; }
  try {
    const value = await (fn as (facts: unknown) => unknown)(input.facts);
    self.postMessage({ ok: true, value });
  } catch (err) {
    const stage = input.entry === "planDrafterReads" ? "plan_threw" : "assemble_threw";
    self.postMessage({ ok: false, error: `${stage}: ${String((err as Error)?.message ?? err).slice(0, 220)}` });
  }
}

self.onmessage = (ev: MessageEvent<WorkerInput>) => { void handleDrafterModule(ev.data); };
