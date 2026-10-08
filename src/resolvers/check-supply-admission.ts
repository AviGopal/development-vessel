/**
 * CHECK-SUPPLY ADMISSION (slice G of the supply->lane test-writing mode, 2026-10-08).
 *
 * gap-check-supply (gap-check-supply.ts) writes the failing test for an UNARMED gap: unarmed is its entry criterion.
 * It dispatches the test-writing goal with structured variables { gap_id, check_supply: true }, and records the
 * dispatchId /run-goal returned in the gap's ledger (classification_metadata.check_supply: state "goal_dispatched",
 * dispatch_id). goal-host's edit-intent route carries that as the pointer field check_supply: { gap_id, dispatch_id }.
 * feature_compose's admission (composeEligibilitySkipReason) refused every such compose "not compose work: unarmed":
 * measured node1+compose2 2026-10-05..10-08, 24 treatment dispatches, 0 reached.
 *
 * THE LEDGER IS THE AUTHORITY, NOT THE MARKER. Any caller can put fields on a pointer; only the supply writes its own
 * ledger after dispatching. So the unarmed reason is waived exactly when the STORED row's ledger says the supply
 * dispatched this gap with THIS dispatch id, and nothing else is waived: composeEligibilitySkipReason returns
 * "unarmed" before it looks at the edit site or the hold, so this predicate re-applies the hold checks itself (open,
 * no operator hold, no parking disposition, no landing awaiting its verdict), allowing only the supply's own
 * disposition (CHECK_SUPPLY_DISPOSITION), and skips the edit-site check (a test-writing target is the test file).
 *
 * The supply writes its ledger AFTER goal-host's 202, so a compose can read the store before the write lands (on a
 * retry it then reads the previous attempt's dispatch id). The marked path re-reads, bounded, before refusing.
 */
import { CHECK_SUPPLY_DISPOSITION, isAwaitingLandVerification, isParkingDisposition } from "./gap-to-feature.js";

/** The compose mode an admitted supply compose runs in. Written and carried only in slice G; nothing reads it yet. */
export const CHECK_SUPPLY_COMPOSE_MODE = "test_writing";

export type CheckSupplyMarker = { gap_id: string; dispatch_id: string };

/** The structured marker on a feature_compose pointer, or null. Never derived from spec or goal text. */
export function checkSupplyMarkerOf(pointer: unknown): CheckSupplyMarker | null {
  const m = (pointer as { check_supply?: unknown } | null | undefined)?.check_supply;
  if (!m || typeof m !== "object") return null;
  const { gap_id, dispatch_id } = m as { gap_id?: unknown; dispatch_id?: unknown };
  if (typeof gap_id !== "string" || gap_id.length === 0 || typeof dispatch_id !== "string" || dispatch_id.length === 0) return null;
  return { gap_id, dispatch_id };
}

export type CheckSupplyAdmission =
  | { admit: true }
  | { admit: false; why: "marker_gap_mismatch" | "dispatch_id_mismatch" | "ledger_mismatch" | "not_unarmed" | "held" | "not_open" };

/**
 * Whether a stored row is test-writing work for the supply's dispatch named by `marker`. `skipReason` is the row's
 * composeEligibilitySkipReason; only "unarmed" can be waived. `composeGapId` is the pointer's gap id and
 * `authoringExecutionId` the pointer's dispatch id (goal-host sets both from the same variables).
 */
export function checkSupplyAdmission(
  stored: Record<string, unknown>,
  marker: CheckSupplyMarker,
  composeGapId: string,
  authoringExecutionId: unknown,
  skipReason: string | null,
): CheckSupplyAdmission {
  if (skipReason !== "unarmed") return { admit: false, why: "not_unarmed" };
  if (marker.gap_id !== composeGapId || String(stored["id"] ?? "") !== composeGapId) return { admit: false, why: "marker_gap_mismatch" };
  if (typeof authoringExecutionId === "string" && authoringExecutionId !== marker.dispatch_id) return { admit: false, why: "dispatch_id_mismatch" };
  if (String(stored["status"] ?? "open") !== "open") return { admit: false, why: "not_open" };
  const rawMeta = stored["classification_metadata"] ?? stored["metadata"];
  const meta = (rawMeta && typeof rawMeta === "object" ? rawMeta : {}) as Record<string, unknown>;
  if (meta["operator_hold"] === true || (meta["disposition"] !== CHECK_SUPPLY_DISPOSITION && isParkingDisposition(meta["disposition"])) || isAwaitingLandVerification(stored)) {
    return { admit: false, why: "held" };
  }
  const ledger = meta["check_supply"];
  if (!ledger || typeof ledger !== "object") return { admit: false, why: "ledger_mismatch" };
  const { state, dispatch_id } = ledger as { state?: unknown; dispatch_id?: unknown };
  if (state !== "goal_dispatched" || typeof dispatch_id !== "string" || dispatch_id !== marker.dispatch_id) return { admit: false, why: "ledger_mismatch" };
  return { admit: true };
}

type LedgerWait = { attempts: number; delay_ms: number; read_timeout_ms: number };
/** Covers the supply's ledger write landing after goal-host's 202 (one self-resolve write): ~10 s in all. */
const DEFAULT_LEDGER_WAIT: LedgerWait = { attempts: 5, delay_ms: 2_000, read_timeout_ms: 10_000 };
let ledgerWait: LedgerWait = DEFAULT_LEDGER_WAIT;
export function checkSupplyLedgerWait(): LedgerWait { return ledgerWait; }
/** Test seam: shorten the bounded re-read; null restores the default. */
export function __setCheckSupplyLedgerWaitForTests(w: Partial<LedgerWait> | null): void {
  ledgerWait = w ? { ...DEFAULT_LEDGER_WAIT, ...w } : DEFAULT_LEDGER_WAIT;
}

/** A read that does not answer within `ms` is unreadable (null), never an admission. */
export async function readWithin<T>(read: () => Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read().catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
