# Routing corpus (development-vessel): closed, append-only

Pins feature_compose's admission: whether a compose that names a gap may start drafting. Every case replays through
`src/resolvers/compose-admission-core.ts composeAdmission` (the closed floor, then the open
`src/judge-rules/routing-admission.ts admitCompose`, clamped), the same function production calls. The floor is
today's admission (containment); the open rules may only add a refusal before drafting.

- `MANIFEST.jsonl` chains `cases/<class>/<NNNN>-<slug>.json` (canonical bytes). Cases are appended by an operator act
  (`bun test/routing-corpus/cli.ts append <case.json>`), never edited or removed.
- `status_at_append`: `green` cases must stay green; `known_red` cases may stay red until the fix they define lands.
- `localization-record.schema.json`: the `localizationRecord` shape (the same file as goal-host's routing corpus),
  read by the admission from the gap record (`gap.localization`); the core hands the rules a record only when valid.

## What the known-red class defines
`excluded-site-admitted-before-drafting`: an AUTONOMOUS compose whose edit site the autonomy scope excludes is refused
before any draft starts, naming the excluding entry; a missing or unreadable scope record reads closed. A DIRECTED
compose (operator:direct) stays exempt, but is never silent: the core emits the shaped `excludedSiteCompose` event
(`scope-control` cases). Done is every case of the class and its controls green with every floor control still green.

The fix is NOT only an open-rules change. It needs a CLOSED core change, an operator follow-up (not built here):
- the scope read at admission (the autonomy scope port for the edit site, recorded in the composeAdmission record);
- fetch-guard routes for that read in the two protected admission tests (compose-admission-check-supply.test.ts and
  operator-hold-contains.test.ts, and compose-admission.test.ts), whose guards refuse an unrouted request;
- the core's `excludedSiteCompose` event for a directed compose on an excluded site, logged and traced;
- routing the refused need to operator review (a closed-scope proposal) rather than dropping it.
The open part is the refusal in `admitCompose` for autonomous composes. The cases define done.
