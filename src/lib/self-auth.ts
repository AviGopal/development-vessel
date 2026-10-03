// THE NODE'S OWN KEY ON ITS OWN SELF-CALLS.
//
// This vessel calls its own resolve route over HTTP (rhythm settlements, structural-break gaps, remedy
// dispatch, gap checks). That route refuses every write-type pointer without `Authorization: ApiKey <key>`
// (lib/caller-credential.ts isWritePointerType), and it accepts this process's METABOB_API_KEY locally as
// node-self. A self-call therefore carries that key.
//
// ONLY TO THE SELF ENDPOINT. The key is attached when the target URL is exactly the module's own self
// endpoint, never to a caller-supplied or arbitrary URL: a pointer that overrides the endpoint must not be
// able to collect the node's credential. Same rule as ui-legibility-scan's selfAuth.
//
// EMPTY KEY. With METABOB_API_KEY unset the header is omitted, as elsewhere in this codebase; the gate
// refuses the write either way (an empty key is not a credential), so the omission changes nothing but
// the log line. The key is read at use time, like caller-credential.ts reads it.

/** `{ Authorization: "ApiKey <node key>" }` when `url` is exactly `selfUrl` and the key is set; otherwise `{}`. */
export function selfAuthHeaders(url: string, selfUrl: string): Record<string, string> {
  const key = process.env["METABOB_API_KEY"] ?? "";
  if (!key || url !== selfUrl) return {};
  return { Authorization: `ApiKey ${key}` };
}

// UNSET IS NOT AN OVERRIDE. Templates fill endpoint fields from the goal (`'{{goal.devVesselImpulsesUrl}}'`).
// A goal that leaves the field out yields "" or the placeholder text itself. Neither is a URL anyone chose,
// so both mean "use the configured endpoint", and the node key goes with it. Only a real value overrides,
// and an override never gets the key (selfAuthHeaders).
const UNRENDERED = /\{\{[^}]*\}\}/;

/** A pointer's endpoint field as an override: `undefined` when it is absent, not a string, blank, or an unrendered `{{…}}` placeholder. */
export function pointerOverride(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.trim() === "" || UNRENDERED.test(value)) return undefined;
  return value;
}
