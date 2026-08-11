// Pins restart attribution, and above all pins that an UNATTRIBUTED start is
// reported as unattributed.
//
// THE HUNT (2026-08-11). Three mechanisms can restart the compose host and systemd
// records none of them. A breadcrumb can only cover sources that write one — and
// the source we cannot name will not write one. So the load-bearing behaviour is
// the ABSENCE case: no breadcrumb, or a stale one, must read UNATTRIBUTED rather
// than being silently attributed to whatever was written last. Attributing this
// start to an earlier restart is exactly how a plausible-but-wrong mechanism gets
// believed, which happened twice in one session.
import { describe, expect, test } from "bun:test";
import {
  breadcrumbPath, parseBreadcrumb, breadcrumbIsFresh, describeStart, BREADCRUMB_FRESH_MS,
} from "./restart-attribution";

const NOW = Date.parse("2026-08-11T21:30:00.000Z");
const fresh = (over: Partial<Record<string, unknown>> = {}) => ({
  requester: "mitosis-cutover",
  reason: "cutover for gap route-edit-1",
  in_flight: 0,
  at: new Date(NOW - 5_000).toISOString(),
  ...over,
} as never);

describe("an unattributed start is REPORTED as unattributed", () => {
  test("no breadcrumb at all", () => {
    const s = describeStart(null, NOW);
    expect(s).toContain("UNATTRIBUTED START");
    expect(s).toContain("without declaring itself");
  });

  test("a STALE breadcrumb does not get to explain this start", () => {
    const old = parseBreadcrumb(JSON.stringify(fresh({ at: new Date(NOW - BREADCRUMB_FRESH_MS - 1000).toISOString() })));
    expect(old).not.toBeNull();
    const s = describeStart(old, NOW);
    expect(s).toContain("UNATTRIBUTED START");
    expect(s).toContain("EARLIER restart");
  });

  test("a breadcrumb from the FUTURE is a clock problem, not an explanation", () => {
    const future = parseBreadcrumb(JSON.stringify(fresh({ at: new Date(NOW + 10 * 60_000).toISOString() })));
    expect(breadcrumbIsFresh(future!, NOW)).toBe(false);
  });

  test("garbage never becomes an attribution", () => {
    for (const raw of ["", "{", "null", "[]", '{"reason":"no requester"}', '{"requester":""}']) {
      expect(parseBreadcrumb(raw)).toBeNull();
    }
  });
});

describe("a fresh breadcrumb attributes the start, and says whether it was lossy", () => {
  test("names the requester and the reason", () => {
    const s = describeStart(parseBreadcrumb(JSON.stringify(fresh())), NOW);
    expect(s).toContain("mitosis-cutover");
    expect(s).toContain("cutover for gap route-edit-1");
    expect(s).not.toContain("UNATTRIBUTED");
  });

  test("in_flight > 0 is called out as LOSSY — that is the whole point", () => {
    const s = describeStart(parseBreadcrumb(JSON.stringify(fresh({ in_flight: 3 }))), NOW);
    expect(s).toContain("3 in flight");
    expect(s).toContain("LOSSY");
  });

  test("in_flight 0 says nothing was lost", () => {
    expect(describeStart(parseBreadcrumb(JSON.stringify(fresh({ in_flight: 0 }))), NOW)).toContain("nothing was lost");
  });

  test("a missing in_flight makes no claim either way", () => {
    const s = describeStart(parseBreadcrumb(JSON.stringify(fresh({ in_flight: undefined }))), NOW);
    expect(s).not.toContain("LOSSY");
    expect(s).not.toContain("nothing was lost");
  });
});

describe("breadcrumbPath cannot be talked out of its directory", () => {
  test("a vessel name is sanitised to a filename", () => {
    expect(breadcrumbPath("development-vessel", "/tmp/x")).toBe("/tmp/x/development-vessel.json");
  });

  test("traversal in the vessel name is neutralised", () => {
    // The property that matters is that no SEPARATOR survives, so the result
    // cannot leave the directory. Dots may remain — `..-..-etc-passwd.json` is an
    // odd filename and a perfectly safe one. Asserting "no dots" would be testing
    // the sanitiser's cosmetics instead of its security property.
    const p = breadcrumbPath("../../etc/passwd", "/tmp/x");
    expect(p.startsWith("/tmp/x/")).toBe(true);
    expect(p.slice("/tmp/x/".length)).not.toContain("/");
  });

  test("an empty vessel name still yields a usable path", () => {
    expect(breadcrumbPath("", "/tmp/x")).toBe("/tmp/x/unknown.json");
  });
});
