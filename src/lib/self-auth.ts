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

import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

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

// CROSS-NODE: THE NODE'S KEY GOES ONLY TO THIS HOST (user ruling "same-host peers only, tonight").
//
// A few callers send the node key to a URL DISCOVERY supplied, not to a configured endpoint: compose placement's
// capacity read and its placed dispatch_goal (compose-placement.ts), and the composeOwnership reads of
// findComposeOwner (judge/gap-admission.ts). A discovery row is whatever a registrant or a federated peer wrote, so
// before the key is attached the target's host must be on this machine: loopback (127.0.0.0/8, ::1, localhost), the
// container runtime's name for this host, an address on a network one of this node's own non-internal interfaces
// attaches to (the host bridge sibling containers share; read at use time from the OS, no env), or a hostname that
// RESOLVES only to those. The same definition as discovery's peer-instance PEER_INSTANCE_SCOPE "same_host", so a peer
// row discovery admits is one this guard lets through. Known limit, shared with it: under host networking an attached
// LAN subnet counts.
// Anything else gets no key AND no call: crossNodeKeyHeaders answers null, the caller skips the request, and one
// line names the host (never the key).
// THE RULE IS A NAMED CONSTANT, not yet a shaped policy: no existing policy shape carries a key-egress scope, so
// widening it beyond this host is a gap to shape, not a value to edit here.
export const CROSS_NODE_KEY_SCOPE = "same-host" as const;
const DNS_BUDGET_MS = 2_000;

function bareAddress(raw: string): string {
  return raw.replace(/^\[|\]$/g, "").split("%")[0]!.toLowerCase();
}
function isLoopbackAddress(addr: string): boolean {
  const a = bareAddress(addr);
  if (isIP(a) === 4) return a.split(".")[0] === "127";
  if (a === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  return mapped ? mapped[1]!.split(".")[0] === "127" : false;
}
/** An IPv4 or IPv6 address as a bigint with its width; null when unparseable (an IPv4-mapped tail is not compared). */
function addressBits(raw: string): { v: bigint; bits: number } | null {
  const a = bareAddress(raw);
  const kind = isIP(a);
  if (kind === 4) return { v: a.split(".").reduce((x, o) => (x << 8n) | BigInt(Number(o)), 0n), bits: 32 };
  if (kind !== 6 || a.includes(".")) return null;
  const [head, tail] = a.split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  if (groups.length !== 8) return null;
  return { v: groups.reduce((x, g) => (x << 16n) | BigInt(parseInt(g || "0", 16)), 0n), bits: 128 };
}
/** Whether `addr` is on a network one of this node's own non-internal interfaces attaches to (its address included). */
function onAttachedNetwork(addr: string): boolean {
  const x = addressBits(addr);
  if (!x) return false;
  try {
    return Object.values(networkInterfaces()).flat().some((n) => {
      if (!n || n.internal) return false;
      const ad = addressBits(n.address), m = addressBits(n.netmask);
      return !!ad && !!m && ad.bits === x.bits && m.bits === x.bits && (ad.v & m.v) === (x.v & m.v);
    });
  } catch { return false; /* no interface list: only loopback counts */ }
}
/** Names a container runtime gives THIS host, from inside a container. */
const RUNTIME_HOST_ALIASES = new Set(["host.containers.internal", "host.docker.internal"]);
/** Whether `host` (a URL hostname) is this machine: loopback, the runtime's name for this host, an address on an attached
 *  network, or a name resolving only to those. */
export async function hostIsThisMachine(host: string): Promise<boolean> {
  const h = bareAddress(host);
  if (h === "localhost" || RUNTIME_HOST_ALIASES.has(h)) return true;
  const local = (addr: string): boolean => isLoopbackAddress(addr) || onAttachedNetwork(addr);
  if (isIP(h)) return local(h);
  if (!h) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addrs = await Promise.race([
      dns.lookup(h, { all: true }) as Promise<Array<{ address: string }>>,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("dns budget")), DNS_BUDGET_MS); }),
    ]);
    return addrs.length > 0 && addrs.every((a) => local(a.address));
  } catch {
    return false; // a name that does not resolve in budget cannot be shown to be this machine
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// AN OVERLAY HOP IS NOT A SAME-HOST PEER. A libp2p overlay row (a facade id `<vessel>@<substrate>`, protocol libp2p,
// origin "overlay") resolves through THIS node's own federation egress on loopback, and the egress carries the request,
// with whatever Authorization it was handed, to ANOTHER substrate. Its host passes the same-host test by construction,
// so it is refused first: from the row's own metadata (protocol, origin, the `@` facade id) and, as a backstop when a
// caller holds only a URL, from the URL (an /egress/ path, a target= hop parameter, or the federation egress port on
// loopback). Same refusal as off-host: no key, no call, one line naming the row.
/** What a caller knows about the discovery row behind a URL (all optional: a URL alone gets the URL backstop only). */
export interface CrossNodeRow { id?: string; protocol?: string; origin?: string }
const FED_EGRESS_DEFAULT = "http://127.0.0.1:8401";
function federationEgressPort(): string {
  try {
    const u = new URL(process.env["FED_TRANSPORT_EGRESS"] ?? FED_EGRESS_DEFAULT);
    return u.port || (u.protocol === "https:" ? "443" : "80");
  } catch { return "8401"; }
}
/** Why `url` (and its row) is a federation overlay hop, or null when it is not one. */
export function overlayHopReason(url: string, row: CrossNodeRow = {}): string | null {
  if (String(row.protocol ?? "").toLowerCase() === "libp2p") return "protocol libp2p";
  if (String(row.origin ?? "") === "overlay") return "origin overlay";
  if (String(row.id ?? "").includes("@")) return "overlay facade id";
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (/(^|\/)egress(\/|$)/.test(u.pathname)) return "federation egress path";
  if (u.searchParams.has("target")) return "federation hop target";
  if (isLoopbackAddress(u.hostname) || u.hostname.toLowerCase() === "localhost") {
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    if (port === federationEgressPort()) return "federation egress port";
  }
  return null;
}

/**
 * The headers for a CROSS-NODE call to a discovery-supplied `url`: `{ Authorization: "ApiKey <node key>" }` (or `{}`
 * with no key) when it is not an overlay hop and its host is this machine, otherwise null, logged once per refusal. A
 * null means: make no call at all. `row` is the discovery row's metadata when the caller has it. The key is read at
 * use time, as selfAuthKey reads it.
 */
export async function crossNodeKeyHeaders(url: string, row: CrossNodeRow = {}): Promise<Record<string, string> | null> {
  if (overlayHopReason(url, row) !== null) {
    let host = "";
    try { host = new URL(url).hostname; } catch { /* named by id below */ }
    console.warn(`[cross-node-key] refused overlay ${row.id || host || "(unparseable url)"}`);
    return null;
  }
  let host = "";
  try { host = new URL(url).hostname; } catch { /* unparseable: refused below */ }
  if (!host || !(await hostIsThisMachine(host))) {
    console.warn(`[cross-node-key] refused non-local ${host || "(unparseable url)"}`);
    return null;
  }
  const key = process.env["METABOB_API_KEY"] ?? "";
  return key ? { Authorization: `ApiKey ${key}` } : {};
}
