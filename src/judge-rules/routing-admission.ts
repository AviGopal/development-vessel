// THE COMPOSE ADMISSION RULES (pure): may a feature_compose that names a gap start drafting?
//
// Called by the closed core (src/resolvers/compose-admission-core.ts composeAdmission) only AFTER its floor has
// admitted the compose. The floor is today's admission, closed (store unreadable, check-supply gap missing, operator
// hold, ineligible unless the check supply's ledger admits it): containment, which nothing open may loosen. What is open
// is what may be ADDED before drafting. The core gathers the evidence, clamps this answer (admit, or a scope_excluded
// refusal naming an entry the input's scope port returned) and renders any refusal. Pinned by the routing corpus
// (test/routing-corpus/).
//
// Version 1 is today's behaviour: everything the floor admits is admitted. The scope is read at landing only.
//
// PURITY. No I/O, clock, randomness or environment; type-only imports and other src/judge-rules files only. A rule that
// could tell replay from production could pass the corpus and behave differently live.
import type { AdmissionDecision, ComposeAdmissionInput } from "../resolvers/compose-admission-core.js";

export function admitCompose(_input: ComposeAdmissionInput): AdmissionDecision {
  return { admit: true, refusal: null };
}
