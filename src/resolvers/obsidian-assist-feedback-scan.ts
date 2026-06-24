import type { ResolverResult } from "./types.js";

/**
 * obsidian_assist_feedback_scan (2026-06-15) — closes the obsidian assist LEARNING loop.
 *
 * The substrate delivers assists to Substrate/Assists/ but, until now, never learned
 * whether they LAND. The operator's reaction IS observable: opening an assist note is
 * an `active-leaf-change` event whose path is under Substrate/Assists/ (workspace
 * events are captured even under Substrate/; only substrate file-writes are skipped).
 *
 * Each run: read recent event_observed, count assist VIEWS (active-leaf-change to
 * Substrate/Assists/*), and:
 *   - write an impulse-relevance reward for the assist activity (execution_succeeded =
 *     engaged), so Thompson learns assists that get viewed are relevant — and, once
 *     there are multiple assist variants, prefers the ones the operator actually uses;
 *   - if assists are being delivered but NOT engaged over the window, emit a
 *     substrateGap so the loop changes assist strategy (different content/placement).
 *
 * This is the reward signal that makes assist delivery SELF-IMPROVING rather than
 * fire-and-forget. Reads only + one relevance write. Side-loop, graceful idle.
 */

const DEFAULT_OBSIDIAN_ENDPOINT =
  process.env["OBSIDIAN_LEARN_ENDPOINT"] ?? process.env["OBSIDIAN_PLUGIN_ENDPOINT"] ?? "http://host.docker.internal:27183";
const DEFAULT_METABOB = process.env["METABOB_ENDPOINT"] ?? process.env["ACTIVITY_API_ENDPOINT"] ?? "http://127.0.0.1:8080";
const DEFAULT_CONCEPT_DB = process.env["CONCEPT_DB_ENDPOINT"] ?? "http://127.0.0.1:8260";
const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";
const API_KEY = process.env["METABOB_API_KEY"] ?? process.env["DEV_VESSEL_API_KEY"];
const ASSIST_PREFIX = "Substrate/Assists/";

export interface ObsidianAssistFeedbackScanPointer {
  type: "obsidian_assist_feedback_scan";
  obsidianEndpoint?: string;
  metabobEndpoint?: string;
  conceptDbBase?: string;
  emitGapUrl?: string;
  apiKey?: string;
  /** Assist activity variant id to reward. */
  assistVariantId?: string;
  eventLimit?: number;
  timeoutMs?: number;
}

interface ObservedEvent {
  kind?: string;
  sync_root_relative_path?: string;
  timestamp?: string;
}

export async function resolveObsidianAssistFeedbackScan(
  pointer: ObsidianAssistFeedbackScanPointer,
): Promise<ResolverResult> {
  const obsidian = (pointer.obsidianEndpoint ?? DEFAULT_OBSIDIAN_ENDPOINT).replace(/\/+$/, "");
  const metabob = (pointer.metabobEndpoint ?? DEFAULT_METABOB).replace(/\/+$/, "");
  const conceptBase = (pointer.conceptDbBase ?? DEFAULT_CONCEPT_DB).replace(/\/+$/, "");
  const emitUrl = pointer.emitGapUrl ?? DEFAULT_DEV_VESSEL_URL;
  const apiKey = pointer.apiKey ?? API_KEY;
  const assistVariantId = pointer.assistVariantId ?? "proposed_pattern_authored_obsidian_assist_active_note";
  const eventLimit = pointer.eventLimit ?? 5000;
  const timeoutMs = pointer.timeoutMs ?? 12_000;
  const generatedAt = new Date().toISOString();
  const auth: Record<string, string> = apiKey ? { "Content-Type": "application/json", Authorization: `ApiKey ${apiKey}` } : { "Content-Type": "application/json" };

  if (!apiKey) return { shape: "obsidianAssistReaction", body: { error: "missing_api_key" } };

  // 1. Read observed events; count assist VIEWS (operator opened an assist note).
  let events: ObservedEvent[] = [];
  try {
    const res = await fetch(`${obsidian}/resolve`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ type: "obsidian:event_observed", pointer: { type: "obsidian:event_observed", limit: eventLimit } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as { content?: string };
    const parsed = json.content ? (JSON.parse(json.content) as { events?: ObservedEvent[] }) : {};
    events = Array.isArray(parsed.events) ? parsed.events : [];
  } catch (err) {
    return { shape: "obsidianAssistReaction", body: { unreachable: true, detail: err instanceof Error ? err.message.slice(0, 120) : "err", generated_at: generatedAt } };
  }

  // PER-CLASS grading: count views by assist-note path so Thompson can learn WHICH
  // assist class the operator engages with — comparative learning, not a single
  // undifferentiated signal. Each class = one Substrate/Assists/<class>.md note.
  const viewsByClass = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== "active-leaf-change" || typeof e.sync_root_relative_path !== "string") continue;
    if (!e.sync_root_relative_path.startsWith(ASSIST_PREFIX)) continue;
    const cls = e.sync_root_relative_path.slice(ASSIST_PREFIX.length).replace(/\.md$/, "");
    if (cls) viewsByClass.set(cls, (viewsByClass.get(cls) ?? 0) + 1);
  }
  const assistViews = [...viewsByClass.values()].reduce((a, b) => a + b, 0);
  const engaged = assistViews > 0;

  // Each known assist class → its variant + delivered-note path. (Drives comparison.)
  const ASSIST_CLASSES = [
    { cls: "active-note", variant: assistVariantId },
    { cls: "next-actions", variant: "proposed_pattern_authored_obsidian_assist_next_actions" },
  ];
  let rewardWritten = false;
  let gapEmitted = false;
  let assistDelivered = false;
  const perClass: Array<{ cls: string; views: number; delivered: boolean }> = [];

  for (const { cls, variant } of ASSIST_CLASSES) {
    const path = `${ASSIST_PREFIX}${cls}.md`;
    const views = viewsByClass.get(cls) ?? 0;
    // Is this class actually delivered? (tells "ignored" from "not authored yet").
    let delivered = false;
    try {
      const res = await fetch(`${obsidian}/resolve`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ type: "obsidian:note", pointer: { type: "obsidian:note", path } }),
        signal: AbortSignal.timeout(6_000),
      });
      const json = (await res.json()) as { success?: boolean; content?: string };
      delivered = json.success === true && !!json.content;
    } catch { /* not delivered */ }
    if (delivered) assistDelivered = true;
    perClass.push({ cls, views, delivered });

    // Per-class reward: this class engaged ⇒ relevant. Thompson differentiates classes.
    // CRITICAL: engagement is a RELEVANCE signal about the delivered assist, NOT an
    // execution outcome of the assist activity. /impulse-relevance bumps the SAME
    // thompson_alpha/beta posterior that promote/prune reads — so writing
    // execution_succeeded=false here (operator simply didn't open the note this
    // window) would drag a 4/4-delivering activity below the prune bar and retire a
    // working capability. Route engagement to a DEDICATED engagement posterior
    // (`obsidian-assist-engagement:<class>`), never the executable variant, so the
    // comparative "which class lands" signal accrues without poisoning graduation.
    if (delivered || views > 0) {
      try {
        const res = await fetch(`${metabob}/v2/activities/impulse-relevance`, {
          method: "POST", headers: auth,
          body: JSON.stringify({
            impulse_id: `obsidian:assist:${cls}`,
            activity_variant_id: `obsidian-assist-engagement:${cls}`,
            was_loaded: true,
            execution_succeeded: views > 0,
            pointer_type: "obsidianAssistDelivered",
            resolver_tier: "llm",
            resolver_name: "obsidian_deliver_assist",
            source: "obsidian_assist_feedback",
            replay_weight: 0.5,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) rewardWritten = true;
      } catch { /* best-effort */ }
    }
  }

  // Delivered-but-ignored (no class engaged at all) → emit a gap to change strategy.
  if (assistDelivered && !engaged) {
    const body = {
      impulse: {
        pointer: {
          type: "substrateGap_write",
          gap: {
            id: "obsidian_assists_ignored",
            category: "obsidian_assists_ignored",
            source: "substrate_detected",
            summary:
              `The substrate is delivering obsidian assists to ${ASSIST_PREFIX} but the operator is not opening them ` +
              `(0 assist views over the last ${events.length} observed events). The assist strategy is not landing — ` +
              `the substrate should change WHAT it surfaces or WHERE/HOW (different content, a more visible placement, ` +
              `or a different assist class).`,
            detected_at: generatedAt,
            status: "open",
            classification_metadata: {
              detector: "obsidian_assist_feedback_scan",
              gap_class: "obsidian_assists_ignored",
              assist_views: 0,
              events_observed: events.length,
              suggested_remediation:
                "Author a different assist class (e.g. surface into the daily note with grant, or a more actionable suggestion) and let reaction-grading compare.",
            },
          },
        },
      },
    };
    try {
      const r = await fetch(emitUrl, { method: "POST", headers: auth, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      gapEmitted = r.ok;
    } catch { /* best-effort */ }
  }

  // 5. Persist the reaction signal for the model.
  try {
    await fetch(`${conceptBase}/v2/impulses/resolve`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        impulse: {
          pointer: {
            type: "concept_create_write",
            conceptData: {
              shape: "obsidian_assist_reaction",
              source_type: "extracted",
              summary: `obsidian assists: ${assistViews} view(s) over ${events.length} events; engaged=${engaged}; delivered=${assistDelivered}`,
              content: JSON.stringify({ assist_views: assistViews, events_observed: events.length, engaged, assist_delivered: assistDelivered, generated_at: generatedAt }),
              priority: 0.5,
              budget: 1200,
            },
          },
        },
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch { /* best-effort */ }

  return {
    shape: "obsidianAssistReaction",
    body: {
      assist_views: assistViews,
      events_observed: events.length,
      engaged,
      assist_delivered: assistDelivered,
      reward_written: rewardWritten,
      gap_emitted: gapEmitted,
      per_class: perClass,
      generated_at: generatedAt,
    },
  };
}
