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

/**
 * `{ Authorization: "ApiKey <key>" }` when `url` is exactly `selfUrl`, otherwise `{}`. The key is the
 * caller's (`callerKey`, a pointer's own apiKey) when one is given, and the node key otherwise. A URL that is
 * not the configured one gets NO key, the caller's included: internal callers pass the node key down as
 * `apiKey`, so a pointer key is no proof that it belongs to whoever named the URL.
 */
export function selfAuthHeaders(url: string, selfUrl: string, callerKey?: string): Record<string, string> {
  const key = selfAuthKey(url, selfUrl, callerKey);
  return key ? { Authorization: `ApiKey ${key}` } : {};
}

/** The key itself, for helpers that build their own header: the same rule as selfAuthHeaders, "" when none. */
export function selfAuthKey(url: string, selfUrl: string, callerKey?: string): string {
  if (url !== selfUrl) return "";
  return callerKey || (process.env["METABOB_API_KEY"] ?? "");
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

/** True when `url` is exactly the configured endpoint: the predicate behind selfAuthHeaders, for helpers holding a non-key credential (a JWT). */
export function selfAuthTrusted(url: string, configured: string): boolean {
  return url === configured;
}
