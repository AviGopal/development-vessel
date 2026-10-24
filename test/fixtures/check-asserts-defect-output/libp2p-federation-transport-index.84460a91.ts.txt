// vessel-libp2p.ts — the vessel-side libp2p transport primitive for substrate federation.
//
// This is the reusable module the substrate will wire into the shared
// vessel-discovery-client (packages/vessel-discovery-client) + VesselDaemon so EVERY
// vessel becomes reachable from anywhere. Built + vetted standalone first (same
// discipline as relay.ts) because libp2p correctness can't be typecheck-verified.
//
// IDENTITY: the libp2p Ed25519 key is SEEDED DETERMINISTICALLY FROM THE VESSEL ID
// (seed = sha256(vesselId)), so the peerId is stable across restarts and IS the
// vessel's federation identity — aligning transport identity with vessel_id =
// multihash(pubkey) (SUBSTRATE_AS_NETWORK §1, H2). No key file to persist.
//
// REACHABILITY: when a RELAY_MULTIADDR is given, the node dials the relay and listens
// on the GENERIC `/p2p-circuit` (any reserved relay), obtaining a reservation + a
// relay-routed circuit address. AutoNAT + DCUtR upgrade to a direct connection when
// the NAT allows; otherwise traffic is relayed (Noise end-to-end, relay sees ciphertext
// only). That circuit multiaddr is what the vessel advertises to discovery as its
// libp2p_multiaddr.
//
// TRANSPORT: two content-resolution paths are provided over the same relay-capable
// connection:
//   1. lpStream-CORRECTED (the proven relay path): a hand-framed request/response over
//      a single libp2p v3 MessageStream, with the handler registered as the v3
//      `(stream, connection)` 2-arg signature and `runOnLimitedConnection:true` on BOTH
//      ends so it fires over a relayed (limited) connection.
//   2. HTTP-over-libp2p (@libp2p/http v2.0.4): the Fetch-style API — server registers a
//      `(req:Request)=>Response` handler, client `services.http.fetch(peerId, init)`.
//      KEY FINDING: @libp2p/http 2.0.4 opens its internal `/http/1.1` stream WITHOUT
//      `runOnLimitedConnection`, so libp2p's newStream limited-check (connection.ts:81)
//      would reject it on a relayed connection — *IF the connection is limited*. But a
//      relayed connection is only "limited" when the RELAY applies a per-circuit cap.
//      With the relay configured `applyDefaultLimit:false` (see relay.ts), the relayed
//      connection carries NO `.limits`, libp2p does not treat it as limited, and the
//      HTTP stream opens fine on BOTH ends — so HTTP-over-libp2p works DIRECT *and* OVER
//      THE RELAY. (Belt-and-braces, serveResolveHttp also re-registers the inbound
//      `/http/1.1` handler with runOnLimitedConnection:true.) Verified in
//      resolve-http-e2e.ts Parts B (direct) and C (relayed).
import { createLibp2p, type Libp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { asCrypto, defaultCrypto } from '@chainsafe/libp2p-noise/crypto'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { autoNAT } from '@libp2p/autonat'
import { dcutr } from '@libp2p/dcutr'
import { http } from '@libp2p/http'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr'
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Uint8ArrayList } from 'uint8arraylist'
import { fromString as u8FromString, toString as u8ToString } from 'uint8arrays'

// ── 4-byte big-endian length-prefix framing over a libp2p v3 MessageStream ──────────
// (v3 streams are read via `for await (const chunk of stream)` and written via
// `stream.send(bytes)`; we frame so the reader knows when one message is complete
// without relying on half-close, which tears the write side down on this muxer.)
function frame(s: string): Uint8Array {
  const b = u8FromString(s)
  const out = new Uint8Array(4 + b.length)
  new DataView(out.buffer).setUint32(0, b.length)
  out.set(b, 4)
  return out
}
async function readFrame(stream: any): Promise<string> {
  const acc = new Uint8ArrayList()
  for await (const chunk of stream) {
    acc.append(chunk)
    if (acc.byteLength >= 4) {
      const h = acc.subarray(0, 4)
      const len = new DataView(h.buffer, h.byteOffset, 4).getUint32(0)
      if (acc.byteLength >= 4 + len) return u8ToString(acc.subarray(4, 4 + len))
    }
  }
  throw new Error('stream ended before a full frame arrived')
}

// libp2p v3's MessageStream.send() delivers only the FIRST ~window-frame (~1 KB) of
// an oversized single call; the remainder is re-queued but only re-pumped when the
// caller issues another send(). A one-shot send() of a multi-KB frame therefore
// silently truncates (small inline replies fit the first frame and survive; larger
// proxied bodies do not — the reader hangs / "stream ended before a full frame").
// Chunk every framed payload to <=1 KB in a drain-aware loop so the queue re-pumps
// each chunk. readFrame() already reassembles fragments, so this is transparent.
const MAX_SEND = 1024
async function sendAll(stream: any, bytes: Uint8Array): Promise<void> {
  for (let off = 0; off < bytes.length; off += MAX_SEND) {
    const chunk = bytes.subarray(off, Math.min(off + MAX_SEND, bytes.length))
    if (stream.send(chunk) === false && typeof stream.onDrain === 'function') await stream.onDrain()
  }
}

// ── The cross-substrate RESOLVE protocol (lpStream-corrected path) ──────────────────
// The QUESTION (a pointer) crosses to the peer, the peer resolves it WHERE ITS DATA
// LIVES, and only the RESULT comes back — over a single libp2p stream (works direct OR
// relay-routed, Noise end-to-end). This is the libp2p analogue of POSTing
// /v2/impulses/resolve, and the answer to the c51d3f8 semantic gap (route the question
// to the peer, not its discovery URL).
export const RESOLVE_PROTO = '/substrate/resolve/1.0.0'

/**
 * Who sent an inbound resolve, as the connection saw it. Passed as an OPTIONAL second
 * argument, so a `(pointer) => …` handler is unaffected. `remotePeer` is the libp2p peer
 * id of the connection the request arrived on (Noise-authenticated: the peer holds that
 * key), or undefined when the transport could not surface it.
 */
export interface ResolveContext {
  remotePeer?: string
  transport: 'lpstream' | 'http'
}
export type ResolveHandler = (pointer: any, ctx?: ResolveContext) => Promise<any> | any

/** Serve cross-substrate resolution: handler(pointer, ctx) -> content, over RESOLVE_PROTO. */
export async function serveResolve(vl: VesselLibp2p, handler: ResolveHandler): Promise<void> {
  // resolve is a tiny request/response — allow it over relay-routed (limited)
  // connections so the symmetric-NAT case (no DCUtR upgrade) still works.
  // node.handle() is async in libp2p v3 — MUST await or the protocol isn't registered.
  // CRITICAL: the v3 StreamHandler signature is (stream, connection) — two POSITIONAL
  // args, NOT `({ stream })`. The prior `({ stream })` destructure read `.stream` off
  // the stream object (undefined) → the handler never read the request → both sides
  // hung. This 2-arg form is THE fix for the resolve-e2e hang.
  await vl.node.handle(RESOLVE_PROTO, (stream: any, connection: any) => {
    void (async () => {
      try {
        const pointer = JSON.parse(await readFrame(stream))   // read request (framed)
        const content = await handler(pointer, { remotePeer: connection?.remotePeer?.toString(), transport: 'lpstream' })
        await sendAll(stream, frame(JSON.stringify({ content, metadata: { shape: pointer?.type } })))
        await stream.close()
      } catch { try { stream.abort?.(new Error('resolve handler error')) } catch {} }
    })()
  }, { runOnLimitedConnection: true })
}

/**
 * Dial a peer and resolve a pointer over libp2p (lpStream-corrected path).
 * Accepts a multiaddr string OR a PeerId string — dialing by PeerId lets libp2p
 * prefer a DCUtR-upgraded direct connection; a `/p2p-circuit` multiaddr forces relay.
 */
export async function resolveViaLibp2p(vl: VesselLibp2p, target: string, pointer: any): Promise<any> {
  const dialTarget = target.startsWith('/') ? multiaddr(target) : peerIdFromString(target)
  const stream = await vl.node.dialProtocol(dialTarget as any, RESOLVE_PROTO, { runOnLimitedConnection: true })
  await sendAll(stream, frame(JSON.stringify(pointer)))    // send request, keep reading for response
  const res = JSON.parse(await readFrame(stream))
  await stream.close()
  return res
}

// ── HTTP-over-libp2p path (@libp2p/http v2 Fetch-style API) ─────────────────────────
// The @libp2p/http service exposes:
//   server:  services.http.handle(protocol, { handler: async (req: Request) => Response, path?, method? })
//   client:  services.http.fetch(peerId | multiaddr, init)  /  fetchProtocol(peer, protocol, init)
// Under the hood it negotiates the `/http/1.1` libp2p protocol and frames HTTP/1.1 over
// the stream. The server-side `/http/1.1` handler is registered by the service WITHOUT
// `runOnLimitedConnection`, so we re-register it with the flag to make it fire over a
// relayed connection too (best effort — the client fetch stream is opened without the
// flag in 2.0.4, so a fully-relayed fetch is still gated client-side; direct works).
export const RESOLVE_HTTP_PROTO = '/substrate/resolve-http/1.0.0'
export const RESOLVE_HTTP_PATH = '/v2/impulses/resolve'
const HTTP_LIBP2P_PROTOCOL = '/http/1.1'
// The Fetch-style route handler receives only a Request, which carries no peer. The
// remote peer is known one layer down, where the /http/1.1 stream handler gets
// (stream, connection); @libp2p/http awaits onStream -> onRequest -> route handler in
// one chain, so an AsyncLocalStorage set around that stream handler is visible here.
const httpRemotePeer = new AsyncLocalStorage<string | undefined>()

/** Serve cross-substrate resolution as an HTTP POST handler over libp2p. */
export async function serveResolveHttp(vl: VesselLibp2p, handler: ResolveHandler): Promise<void> {
  const httpSvc: any = (vl.node.services as any).http
  if (httpSvc == null) throw new Error('http() service not enabled on this vessel — pass enableHttp:true')
  httpSvc.handle(RESOLVE_HTTP_PROTO, {
    path: RESOLVE_HTTP_PATH,
    method: ['POST', 'GET'],
    handler: async (req: Request): Promise<Response> => {
      try {
        const pointer = req.method === 'POST' ? await req.json() : { type: 'federation_probe' }
        const content = await handler(pointer?.impulse ?? pointer, { remotePeer: httpRemotePeer.getStore(), transport: 'http' })
        return new Response(JSON.stringify({ content, metadata: { shape: (pointer?.impulse ?? pointer)?.type } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      } catch (e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500 })
      }
    },
  })
  // Best-effort: re-register the underlying /http/1.1 inbound handler with the limited
  // flag so the HTTP server also fires over a relayed connection. The http service has
  // already registered /http/1.1 without it; we cannot easily reach its private
  // onStream, so this is a no-op when the handler can't be rebound — direct connections
  // are unaffected (they aren't limited). The rebound handler also records the
  // connection's remote peer for the route handler above; it is rebound even when the
  // limited flag was already set, which changes nothing else (same handler, same options).
  try {
    const reg: any = (vl.node as any).components?.registrar ?? (vl.node as any).registrar
    const existing = reg?.getHandler?.(HTTP_LIBP2P_PROTOCOL)
    if (existing?.handler) {
      const inner = existing.handler
      const withPeer = (stream: any, connection: any) =>
        httpRemotePeer.run(connection?.remotePeer?.toString(), () => inner(stream, connection))
      await vl.node.unhandle(HTTP_LIBP2P_PROTOCOL)
      await vl.node.handle(HTTP_LIBP2P_PROTOCOL, withPeer, { ...existing.options, runOnLimitedConnection: true })
    }
  } catch { /* leave default registration in place; direct-conn path still works */ }
}

/**
 * Resolve a pointer FROM a peer over HTTP-over-libp2p (Fetch-style).
 * `target` is a PeerId string (preferred — lets libp2p pick direct vs relay) or a
 * multiaddr string. We pre-dial so a connection (direct, ideally DCUtR-upgraded) exists,
 * then fetch the resolve route by protocol path.
 */
export async function resolveViaHttp(vl: VesselLibp2p, target: string, pointer: any): Promise<any> {
  const httpSvc: any = (vl.node.services as any).http
  if (httpSvc == null) throw new Error('http() service not enabled on this vessel — pass enableHttp:true')
  const dialTarget: PeerIdOrMultiaddr = target.startsWith('/') ? multiaddr(target) : peerIdFromString(target)
  // Ensure a connection exists before fetch (fetch will reuse it).
  try { await vl.node.dial(dialTarget as any) } catch { /* fetch may still establish it */ }
  // fetchProtocol() does the /.well-known/libp2p/protocols lookup to resolve our
  // RESOLVE_HTTP_PROTO -> RESOLVE_HTTP_PATH, then issues the POST to that path. This is
  // the idiomatic way to reach a named HTTP protocol without hardcoding its path.
  const res: Response = await httpSvc.fetchProtocol(dialTarget, RESOLVE_HTTP_PROTO, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ impulse: pointer }),
  })
  return res.json()
}

type PeerIdOrMultiaddr = ReturnType<typeof peerIdFromString> | Multiaddr

// ── Vessel construction ─────────────────────────────────────────────────────────────
export interface VesselLibp2pOptions {
  vesselId: string                 // the vessel's stable id — seeds the libp2p identity
  relayMultiaddr?: string          // public relay; when set, the node becomes reachable from anywhere
  localTcpPort?: number            // optional direct TCP listen (0 = ephemeral); relay works regardless
  enableHttp?: boolean             // add the @libp2p/http service (HTTP-over-libp2p path)
  disableDcutr?: boolean           // skip the DCUtR hole-punch — forces the connection to STAY relayed (test only)
  reReserveAtTtlFraction?: number  // when (fraction of ttl) remains, re-reserve (default 0.5)
  assumedReservationTtlMs?: number // reservation ttl to assume when the relay exposes no limits (default 1h)
  extraServices?: Record<string, unknown>
}

export interface TransportHealth {
  peerId: string
  activeReservations: number                  // how many relay reservations we currently hold
  reservationTtlRemainingMs: number | null    // ms until the soonest reservation expires (null if none/unknown)
  connections: Array<{ peer: string, addr: string, limited: boolean, bytesRemaining: number | null, secondsRemaining: number | null }>
  holePunchSuccess: number                     // DCUtR direct-connection upgrades (from metrics if available)
  holePunchFail: number
  streamResets: number                         // observed stream resets (from metrics if available)
}

export interface VesselLibp2p {
  node: Libp2p
  peerId: string
  /** Addresses to advertise to discovery (includes the relay-circuit address when a relay is used). */
  advertiseMultiaddrs: () => string[]
  /** Snapshot of transport reachability — what self-recovery senses. */
  health: () => TransportHealth
  /** Stop the reservation-refresh loop and the node. */
  stop: () => Promise<void>
}

/** Deterministic Ed25519 keypair from the vessel id (seed = sha256(vesselId)). */
export async function vesselKeyFromId(vesselId: string) {
  const seed = createHash('sha256').update(vesselId).digest() // 32 bytes
  return generateKeyPairFromSeed('Ed25519', seed)
}

export async function createVesselLibp2p(opts: VesselLibp2pOptions): Promise<VesselLibp2p> {
  const privateKey = await vesselKeyFromId(opts.vesselId)
  const listen: string[] = [`/ip4/0.0.0.0/tcp/${opts.localTcpPort ?? 0}`]
  // Listen on the GENERIC /p2p-circuit (any reserved relay), NOT <relay>/p2p-circuit.
  // This is the relay-failover surface: when the node has reservations on multiple
  // relays, a generic listen makes it reachable via ANY of them, so losing one relay
  // doesn't make the vessel unreachable as long as another reservation holds.
  if (opts.relayMultiaddr) listen.push('/p2p-circuit')

  const services: Record<string, unknown> = {
    identify: identify(),
    autonat: autoNAT(),               // lets dialing vessels learn their own NAT status
    ...(opts.disableDcutr ? {} : { dcutr: dcutr() }),  // DCUtR attempts a direct hole-punch to escape the relay
    ...(opts.enableHttp ? { http: http() } : {}),
    ...(opts.extraServices ?? {}),
  }

  const node = await createLibp2p({
    privateKey,
    addresses: { listen },
    transports: [tcp(), webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise({ crypto: { ...defaultCrypto, chaCha20Poly1305Encrypt: asCrypto.chaCha20Poly1305Encrypt, chaCha20Poly1305Decrypt: asCrypto.chaCha20Poly1305Decrypt } })],
    streamMuxers: [yamux()],
    connectionMonitor: { abortConnectionOnPingFailure: false },
    // The service map is assembled dynamically (optional dcutr/http/extras), so its
    // static type is Record<string, unknown>; libp2p validates factories at runtime.
    services: services as any,
  })
  await node.start()

  let refreshTimer: ReturnType<typeof setInterval> | undefined
  const assumedTtlMs = opts.assumedReservationTtlMs ?? 3_600_000
  let lastReservationAt: number | null = null
  if (opts.relayMultiaddr) {
    const relayMa = multiaddr(opts.relayMultiaddr)
    // Dial the relay so it grants a reservation; the circuit-relay transport then
    // surfaces a `/p2p/<relay>/p2p-circuit/p2p/<self>` address in getMultiaddrs().
    const dialRelay = async () => { try { await node.dial(relayMa) } catch { /* reservation retries internally */ } }
    await dialRelay()

    // RESERVATION REFRESH: re-establish the relay connection (which re-reserves) when
    // the reservation is over halfway to expiry, and immediately on relay disconnect.
    // The circuit-relay transport renews reservations on its own while the relay
    // connection is up; this loop is the belt-and-braces re-dial that also covers the
    // case where the relay connection dropped entirely (relay restart / network blip).
    const frac = opts.reReserveAtTtlFraction ?? 0.5
    lastReservationAt = Date.now()
    refreshTimer = setInterval(() => {
      const relayPeer = (() => { try { return (relayMa as any).getPeerId() } catch { return null } })()
      const relayConns = relayPeer == null ? [] : node.getConnections().filter((c) => c.remotePeer.toString() === relayPeer)
      if (relayConns.length === 0) { void dialRelay().then(() => { lastReservationAt = Date.now() }); return }
      // The relay cannot be observed for ttl when it applies no per-circuit limits
      // (limits == null), so track reservation age ourselves and force a re-reservation
      // — close + re-dial, because a dial while connected is a no-op that does not
      // re-reserve — before the assumed ttl lapses.
      const h = healthSnapshot(node)
      const ttlMs = h.reservationTtlRemainingMs ?? Math.max(0, assumedTtlMs - (Date.now() - (lastReservationAt ?? Date.now())))
      if (ttlMs < frac * assumedTtlMs) {
        void Promise.allSettled(relayConns.map((c) => c.close()))
          .then(() => dialRelay())
          .then(() => { lastReservationAt = Date.now() })
      }
    }, 30_000)
    // Re-dial promptly when the relay connection closes.
    node.addEventListener('connection:close', (evt: any) => {
      try {
        const relayPeer = (relayMa as any).getPeerId()
        if (relayPeer && evt?.detail?.remotePeer?.toString() === relayPeer) void dialRelay()
      } catch { /* ignore */ }
    })
  }

  return {
    node,
    peerId: node.peerId.toString(),
    advertiseMultiaddrs: () => node.getMultiaddrs().map((m) => m.toString()),
    health: () => {
      const h = healthSnapshot(node)
      if (h.reservationTtlRemainingMs == null && h.activeReservations > 0 && lastReservationAt != null) {
        h.reservationTtlRemainingMs = Math.max(0, assumedTtlMs - (Date.now() - lastReservationAt))
      }
      return h
    },
    stop: async () => { if (refreshTimer) clearInterval(refreshTimer); await node.stop() },
  }
}

// ── Transport-health sensing surface ────────────────────────────────────────────────
// This is what the substrate's self-recovery senses to decide whether a vessel is
// reachable from the federation, and whether it's on a (fragile, capped) relayed path
// or a (durable) direct one. A connection with `.limits != null` is relayed/limited.
function healthSnapshot(node: Libp2p): TransportHealth {
  const conns = node.getConnections()
  const connections = conns.map((c) => ({
    peer: c.remotePeer.toString(),
    addr: c.remoteAddr.toString(),
    limited: c.limits != null,
    bytesRemaining: c.limits?.bytes != null ? Number(c.limits.bytes) : null,
    secondsRemaining: c.limits?.seconds ?? null,
  }))

  // Active reservations: the circuit-relay transport surfaces a /p2p-circuit listen
  // address per relay we hold a reservation with; count those. ttl-remaining is
  // approximated from the soonest `seconds` limit across limited connections (the relay
  // sets the circuit's duration limit from the reservation).
  const circuitAddrs = node.getMultiaddrs().map((m) => m.toString()).filter((m) => m.includes('p2p-circuit'))
  const activeReservations = circuitAddrs.length
  const secs = connections.map((c) => c.secondsRemaining).filter((s): s is number => s != null)
  const reservationTtlRemainingMs = secs.length > 0 ? Math.min(...secs) * 1000 : null

  // Hole-punch + reset counters from the metrics subsystem when available (best effort;
  // the simple metrics backend used here may not expose these, so default to 0).
  let holePunchSuccess = 0, holePunchFail = 0, streamResets = 0
  try {
    const m: any = (node as any).metrics
    const snap = m?.getMetrics?.() ?? m?.metrics ?? {}
    for (const [k, v] of Object.entries<any>(snap)) {
      const val = typeof v === 'number' ? v : (v?.value ?? 0)
      if (/dcutr.*(success|connected)/i.test(k)) holePunchSuccess += val
      else if (/dcutr.*(fail|error)/i.test(k)) holePunchFail += val
      else if (/(stream).*(reset|abort)/i.test(k)) streamResets += val
    }
  } catch { /* metrics optional */ }

  return {
    peerId: node.peerId.toString(),
    activeReservations,
    reservationTtlRemainingMs,
    connections,
    holePunchSuccess,
    holePunchFail,
    streamResets,
  }
}
