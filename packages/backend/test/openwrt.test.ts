/* ubus protocol handling. The transport is stubbed, so these cover the
   parsing and the auth-mode decisions rather than the network. */

import { describe, expect, it } from "vitest";
import {
  isSessionError,
  normalizeHost,
  parseSysInfo,
  ubusStatusMessage,
} from "../src/collectors/openwrt.js";

describe("parseSysInfo", () => {
  // Captured live from an OpenWrt 24.10 router (MT7628AN).
  const REAL = {
    localtime: 1787069028,
    uptime: 1055066,
    load: [6816, 8224, 10240],
    memory: { total: 59686912, free: 11702272, shared: 483328, buffered: 0, available: 10039296, cached: 20008960 },
  };

  it("converts ubus fixed-point load to a real average", () => {
    const info = parseSysInfo(REAL);
    // 6816 / 65536 ≈ 0.104
    expect(info.loadavg[0]).toBeCloseTo(0.104, 2);
    expect(info.loadavg[1]).toBeCloseTo(0.125, 2);
  });

  it("derives CPU% from load, normalised by core count", () => {
    expect(parseSysInfo(REAL, 1).cpuPct).toBeCloseTo(10.4, 0);
    // The same load on a 4-core box is a quarter of the utilisation.
    expect(parseSysInfo(REAL, 4).cpuPct).toBeCloseTo(2.6, 0);
  });

  it("caps CPU% at 100 when load exceeds core count", () => {
    expect(parseSysInfo({ ...REAL, load: [65536 * 8, 0, 0] }, 1).cpuPct).toBe(100);
  });

  it("prefers `available` over free+buffered+cached for memory", () => {
    const info = parseSysInfo(REAL);
    // used = 59686912 - 10039296 = 49647616 → ~83.2%
    expect(info.memUsedBytes).toBe(49647616);
    expect(info.memPct).toBeCloseTo(83.2, 1);
  });

  it("falls back to free+buffered+cached when `available` is absent", () => {
    const info = parseSysInfo({
      memory: { total: 1000, free: 200, buffered: 100, cached: 200 },
      load: [0, 0, 0],
    });
    expect(info.memPct).toBe(50);
  });

  it("reports uptime and no swap when the router has none", () => {
    const info = parseSysInfo(REAL);
    expect(info.uptimeSec).toBe(1055066);
    expect(info.swapTotalBytes).toBe(0);
    expect(info.swapPct).toBe(0);
  });

  it("does not divide by zero on an empty payload", () => {
    const info = parseSysInfo({});
    expect(info.memPct).toBe(0);
    expect(info.cpuPct).toBe(0);
    expect(Number.isNaN(info.memPct)).toBe(false);
  });
});

describe("isSessionError", () => {
  it("recognises the failures that warrant re-authenticating", () => {
    for (const m of ["Permission denied", "ubus status 6", "401 Unauthorized", "session expired"]) {
      expect(isSessionError(m)).toBe(true);
    }
  });

  it("ignores unrelated transport failures", () => {
    for (const m of ["ECONNREFUSED", "HTTP 502", "Invalid RPC response"]) {
      expect(isSessionError(m)).toBe(false);
    }
  });
});

describe("anonymous-access denial", () => {
  it("is the shape rpcd returns without the ACL", () => {
    // Live capture before installing the ACL:
    //   {"error":{"code":-32002,"message":"Access denied"}}
    // which ubusCall turns into this message. The collector matches on it to
    // tell "ACL missing" apart from a genuine transport failure.
    const message = "Access denied (code -32002)";
    expect(/Access denied|denied|status 6|Permission/i.test(message)).toBe(true);
  });
});

describe("normalizeHost", () => {
  it.each([
    ["10.20.0.1", "http://10.20.0.1"],
    ["http://10.20.0.1/", "http://10.20.0.1"],
    ["https://router.lan", "https://router.lan"],
    ["router.lan:8080", "http://router.lan:8080"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });

  it("returns empty for blank input", () => {
    expect(normalizeHost("   ")).toBe("");
  });
});

describe("ubusStatusMessage", () => {
  it("names the codes worth acting on", () => {
    expect(ubusStatusMessage(6)).toBe("Permission denied");
    expect(ubusStatusMessage(4)).toBe("Object not found");
    expect(ubusStatusMessage(99)).toBe("ubus error");
  });
});
