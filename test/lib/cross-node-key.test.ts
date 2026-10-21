// crossNodeKeyHeaders: the node key is attached only to a host on this machine (self-auth.ts; "same-host peers only").
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { networkInterfaces } from "node:os";
import { crossNodeKeyHeaders, hostIsThisMachine, overlayHopReason, CROSS_NODE_KEY_SCOPE } from "../../src/lib/self-auth.js";

const saved = process.env["METABOB_API_KEY"];
const KEY = `synthetic-node-key-${Math.random().toString(36).slice(2, 10)}`;
const origWarn = console.warn;
let warned: string[] = [];
beforeEach(() => { process.env["METABOB_API_KEY"] = KEY; warned = []; console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); }; });
afterAll(() => { console.warn = origWarn; if (saved === undefined) delete process.env["METABOB_API_KEY"]; else process.env["METABOB_API_KEY"] = saved; });

describe("crossNodeKeyHeaders", () => {
  it("is the same-host rule", () => { expect(CROSS_NODE_KEY_SCOPE).toBe("same-host"); });

  it("attaches the key to loopback targets, any port: 127.0.0.0/8, ::1, localhost, and the runtime's name for this host", async () => {
    for (const u of ["http://127.0.0.1:8090/x", "http://127.4.5.6:18090/x", "http://[::1]:8090/x", "http://localhost:18090/x", "http://host.containers.internal:18090/x"]) {
      expect(await crossNodeKeyHeaders(u)).toEqual({ Authorization: `ApiKey ${KEY}` });
    }
    expect(warned).toEqual([]);
  });

  it("attaches the key to an address on one of this node's own interfaces", async () => {
    const own = Object.values(networkInterfaces()).flat().map((i) => i?.address).find((a): a is string => !!a && !a.startsWith("127.") && a !== "::1" && !a.includes("%"));
    if (!own) return; // a loopback-only host has no such address; the loopback case covers it
    expect(await hostIsThisMachine(own)).toBe(true);
    const host = own.includes(":") ? `[${own}]` : own;
    expect(await crossNodeKeyHeaders(`http://${host}:8090/x`)).toEqual({ Authorization: `ApiKey ${KEY}` });
  });

  it("attaches the key to a sibling on a network one of this node's interfaces attaches to (the shared host bridge)", async () => {
    const nic = Object.values(networkInterfaces()).flat().find((i) => !!i && !i.internal && i.family === "IPv4" && i.netmask !== "255.255.255.255" && i.netmask !== "255.255.255.254");
    if (!nic) return; // no attached IPv4 network (an isolated container): only loopback counts, covered above
    const o = nic.address.split(".").map(Number);
    o[3] = o[3] === 1 ? 2 : 1; // another host part, same /24-or-wider network
    const sibling = o.join(".");
    if (!nic.netmask.startsWith("255.255.255.") || nic.netmask === "255.255.255.0") expect(await hostIsThisMachine(sibling)).toBe(true);
  });

  it("refuses any other host: null (no key, no call) and one line naming the host only", async () => {
    for (const [u, h] of [["http://203.0.113.7:8090/x", "203.0.113.7"], ["https://198.51.100.20/v2", "198.51.100.20"], ["not a url", "(unparseable url)"]] as const) {
      warned = [];
      expect(await crossNodeKeyHeaders(u)).toBeNull();
      expect(warned).toEqual([`[cross-node-key] refused non-local ${h}`]);
    }
    expect(warned.some((w) => w.includes(KEY))).toBe(false);
  });

  it("refuses an overlay hop on loopback: from the row's metadata, and from the URL alone as a backstop", async () => {
    const savedEgress = process.env["FED_TRANSPORT_EGRESS"];
    process.env["FED_TRANSPORT_EGRESS"] = "http://127.0.0.1:8401"; // the egress port is read at use time
    try {
    const egress = "http://127.0.0.1:8401/egress/resolve?target=%2Fip4%2F203.0.113.5%2Ftcp%2F4001";
    for (const [u, row, why] of [
      ["http://127.0.0.1:18401/v2/impulses/resolve", { id: "development-vessel-local@far", protocol: "libp2p" }, "protocol libp2p"],
      ["http://127.0.0.1:18401/v2/impulses/resolve", { id: "x", origin: "overlay" }, "origin overlay"],
      ["http://127.0.0.1:18401/v2/impulses/resolve", { id: "development-vessel-local@far" }, "overlay facade id"],
      [egress, {}, "federation egress path"],
      ["http://127.0.0.1:18990/v2/impulses/resolve?target=%2Fip4%2F203.0.113.5", {}, "federation hop target"],
      ["http://127.0.0.1:8401/v2/impulses/resolve", {}, "federation egress port"],
    ] as const) {
      expect(overlayHopReason(u, row)).toBe(why);
      warned = [];
      expect(await crossNodeKeyHeaders(u, row)).toBeNull();
      expect(warned.length).toBe(1);
      expect(warned[0]!.startsWith("[cross-node-key] refused overlay ")).toBe(true);
    }
    expect(warned.some((w) => w.includes(KEY))).toBe(false);
    // a same-host HTTP row (peer origin, plain id, ordinary port) is not an overlay hop
    expect(overlayHopReason("http://127.0.0.1:28090/v2/impulses/resolve", { id: "development-vessel-local", origin: "peer:http://127.0.0.1:28100" })).toBeNull();
    } finally { if (savedEgress === undefined) delete process.env["FED_TRANSPORT_EGRESS"]; else process.env["FED_TRANSPORT_EGRESS"] = savedEgress; }
  });

  it("with no node key, a local target gets no header but is not refused", async () => {
    delete process.env["METABOB_API_KEY"];
    expect(await crossNodeKeyHeaders("http://127.0.0.1:8090/x")).toEqual({});
  });
});
