// The explicit OPEN policy records, for fixtures whose subject is not the policy itself. The autonomy scope and the
// spend envelope fail closed when they are unreadable OR ABSENT: "no containment" and "no cap" exist only as
// explicit records ({unrestricted: true}, {uncapped: true}). A fixture that wants the lane open answers its pool
// reads with these, never with an empty list (an empty list is the absent case, and refuses).
export const EXPLICIT_OPEN_POLICY: ReadonlyArray<{ shape: string; updated_at: string; body: Record<string, unknown> }> = [
  { shape: "autonomyScope", updated_at: "2026-01-01T00:00:00Z", body: { unrestricted: true, reason: "test fixture: explicitly unrestricted" } },
  { shape: "spendEnvelope", updated_at: "2026-01-01T00:00:00Z", body: { uncapped: true, paused: false, reason: "test fixture: explicitly uncapped" } },
];
/** A pool producer's answer to a read of `shape`: the explicit open record of that shape, if any. */
export const openPolicyAnswer = (shape: unknown): Response => Response.json({ body: { impulses: EXPLICIT_OPEN_POLICY.filter((r) => r.shape === shape) } });
