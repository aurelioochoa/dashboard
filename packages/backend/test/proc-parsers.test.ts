/* Parser tests driven by fixtures captured from real hosts:
   - armbian-*  : Armbian 26.2 aarch64 SBC (live capture)
   - arch-*     : Arch Linux x86_64 (live capture)
   - alpine-*   : BusyBox coreutils, as found on Alpine and older hosts */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  cpuPercent, netRates, parseCpuCount, parseDf, parseLoadAvg, parseMemInfo,
  parseNetDev, parseProcStat, parseThermal, parseUptime,
} from "../src/collectors/proc-parsers.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): string => readFileSync(resolve(here, "fixtures", name), "utf8");

describe("parseProcStat / cpuPercent", () => {
  it.each(["armbian-proc-stat.txt", "arch-proc-stat.txt"])("parses %s", (file) => {
    const stat = parseProcStat(fx(file));
    expect(stat).toBeDefined();
    expect(stat!.total).toBeGreaterThan(0);
    expect(stat!.idle).toBeGreaterThan(0);
    expect(stat!.idle).toBeLessThanOrEqual(stat!.total);
  });

  it("counts cores", () => {
    expect(parseCpuCount(fx("armbian-proc-stat.txt"))).toBe(4);
    expect(parseCpuCount(fx("arch-proc-stat.txt"))).toBeGreaterThan(0);
  });

  it("computes utilisation between two samples", () => {
    // 1000 jiffies elapsed, 250 of them idle → 75% busy.
    expect(cpuPercent({ total: 1000, idle: 800 }, { total: 2000, idle: 1050 })).toBe(75);
  });

  it("returns undefined for a zero-length or backwards window", () => {
    expect(cpuPercent({ total: 1000, idle: 800 }, { total: 1000, idle: 800 })).toBeUndefined();
    // Counter reset after a reboot must not produce a bogus reading.
    expect(cpuPercent({ total: 5000, idle: 4000 }, { total: 100, idle: 80 })).toBeUndefined();
  });

  it("returns undefined on garbage", () => {
    expect(parseProcStat("")).toBeUndefined();
    expect(parseProcStat("not a stat file")).toBeUndefined();
  });
});

describe("parseMemInfo", () => {
  it("reads the Armbian capture (3.8 GiB board)", () => {
    const mem = parseMemInfo(fx("armbian-meminfo.txt"))!;
    expect(mem).toBeDefined();
    expect(mem.totalBytes / 1024 ** 3).toBeGreaterThan(3);
    expect(mem.totalBytes / 1024 ** 3).toBeLessThan(5);
    expect(mem.usedPct).toBeGreaterThan(0);
    expect(mem.usedPct).toBeLessThanOrEqual(100);
    expect(mem.usedBytes).toBeLessThanOrEqual(mem.totalBytes);
  });

  it("reads the x86_64 capture", () => {
    const mem = parseMemInfo(fx("arch-meminfo.txt"))!;
    expect(mem.totalBytes).toBeGreaterThan(0);
    expect(mem.swapTotalBytes).toBeGreaterThanOrEqual(0);
  });

  it("falls back to free+buffers+cached when MemAvailable is absent", () => {
    const mem = parseMemInfo(
      ["MemTotal:  1000000 kB", "MemFree: 200000 kB", "Buffers: 100000 kB", "Cached: 200000 kB"].join("\n"),
    )!;
    // available = 500000 → used = 500000 → 50%
    expect(mem.usedPct).toBe(50);
  });

  it("prefers MemAvailable when present", () => {
    const mem = parseMemInfo(
      ["MemTotal: 1000000 kB", "MemFree: 100000 kB", "MemAvailable: 750000 kB", "Cached: 600000 kB"].join("\n"),
    )!;
    expect(mem.usedPct).toBe(25);
  });

  it("reports no swap as 0% rather than NaN", () => {
    const mem = parseMemInfo(["MemTotal: 1000 kB", "MemAvailable: 500 kB", "SwapTotal: 0 kB", "SwapFree: 0 kB"].join("\n"))!;
    expect(mem.swapPct).toBe(0);
  });

  it("returns undefined without MemTotal", () => {
    expect(parseMemInfo("MemFree: 100 kB")).toBeUndefined();
  });
});

describe("parseDf", () => {
  it("keeps real filesystems and drops pseudo ones (Armbian)", () => {
    const disks = parseDf(fx("armbian-df.txt"));
    const mounts = disks.map((d) => d.mount);
    expect(mounts).toContain("/");
    // The capture is full of tmpfs, udev and docker overlay entries.
    expect(mounts.some((m) => m.startsWith("/run"))).toBe(false);
    expect(mounts.some((m) => m.includes("/var/lib/docker/rootfs/overlayfs"))).toBe(false);
    const root = disks.find((d) => d.mount === "/")!;
    expect(root.totalBytes).toBeGreaterThan(100 * 1024 ** 3);
    expect(root.usedPct).toBeGreaterThan(0);
  });

  it("handles Arch's bare `dev`/`run`/`none` source names", () => {
    const mounts = parseDf(fx("arch-df.txt")).map((d) => d.mount);
    expect(mounts).toContain("/");
    expect(mounts).toContain("/boot");
    expect(mounts).not.toContain("/dev");
    expect(mounts).not.toContain("/run");
    expect(mounts.some((m) => m.startsWith("/sys"))).toBe(false);
  });

  it("parses BusyBox df output (Alpine)", () => {
    const disks = parseDf(fx("alpine-df.txt"));
    expect(disks.map((d) => d.mount)).toEqual(["/", "/boot"]);
    expect(disks[0]!.totalBytes).toBe(17825792 * 1024);
  });

  it("sorts largest first", () => {
    const disks = parseDf(fx("armbian-df.txt"));
    for (let i = 1; i < disks.length; i++) {
      expect(disks[i - 1]!.totalBytes).toBeGreaterThanOrEqual(disks[i]!.totalBytes);
    }
  });

  it("ignores short and zero-size lines instead of throwing", () => {
    expect(parseDf("Filesystem 1024-blocks Used Available Capacity Mounted on\ngarbage\n")).toEqual([]);
    expect(parseDf("header\n/dev/sda1 0 0 0 0% /mnt\n")).toEqual([]);
  });

  it("keeps mount points containing spaces intact", () => {
    const disks = parseDf("header\n/dev/sdb1 1000 500 500 50% /mnt/my drive\n");
    expect(disks[0]!.mount).toBe("/mnt/my drive");
  });
});

describe("parseThermal", () => {
  it("reads the Armbian sensors", () => {
    const temps = parseThermal(fx("armbian-thermal.txt"));
    expect(temps.length).toBe(4);
    expect(temps.map((t) => t.label)).toContain("cpu-thermal");
    // Sorted hottest first.
    expect(temps[0]!.celsius).toBeGreaterThanOrEqual(temps[1]!.celsius);
    expect(temps[0]!.celsius).toBeGreaterThan(20);
    expect(temps[0]!.celsius).toBeLessThan(100);
  });

  it("disambiguates duplicate zone names (x86 reports several acpitz)", () => {
    const temps = parseThermal("acpitz=67000\nacpitz=20000");
    expect(temps.map((t) => t.label)).toEqual(["acpitz", "acpitz 2"]);
  });

  it("accepts plain degrees as well as millidegrees", () => {
    expect(parseThermal("cpu=45")).toEqual([{ label: "cpu", celsius: 45 }]);
    expect(parseThermal("cpu=45000")).toEqual([{ label: "cpu", celsius: 45 }]);
  });

  it("drops disabled or nonsensical zones", () => {
    expect(parseThermal("dead=0\nbogus=-40000\nhuge=999000")).toEqual([]);
  });

  it("returns an empty list for a host with no thermal zones", () => {
    expect(parseThermal("")).toEqual([]);
  });
});

describe("parseNetDev / netRates", () => {
  it("keeps physical interfaces and drops loopback and docker bridges", () => {
    const ifaces = parseNetDev(fx("armbian-net-dev.txt")).map((c) => c.iface);
    expect(ifaces).not.toContain("lo");
    expect(ifaces.some((i) => i.startsWith("veth"))).toBe(false);
    expect(ifaces.some((i) => i.startsWith("docker"))).toBe(false);
    expect(ifaces.length).toBeGreaterThan(0);
  });

  it("computes per-second rates from two samples", () => {
    const rates = netRates(
      [{ iface: "eth0", rxBytes: 1000, txBytes: 2000 }],
      [{ iface: "eth0", rxBytes: 3000, txBytes: 2500 }],
      2000,
    );
    expect(rates).toEqual([
      { iface: "eth0", rxBytesPerSec: 1000, txBytesPerSec: 250, rxBytesTotal: 3000, txBytesTotal: 2500 },
    ]);
  });

  it("drops interfaces whose counters went backwards (reboot / 32-bit wrap)", () => {
    expect(netRates(
      [{ iface: "eth0", rxBytes: 5000, txBytes: 5000 }],
      [{ iface: "eth0", rxBytes: 10, txBytes: 10 }],
      1000,
    )).toEqual([]);
  });

  it("ignores interfaces absent from the previous sample", () => {
    expect(netRates([], [{ iface: "eth0", rxBytes: 10, txBytes: 10 }], 1000)).toEqual([]);
  });

  it("returns nothing for a zero-length window", () => {
    expect(netRates(
      [{ iface: "eth0", rxBytes: 0, txBytes: 0 }],
      [{ iface: "eth0", rxBytes: 10, txBytes: 10 }],
      0,
    )).toEqual([]);
  });
});

describe("parseLoadAvg / parseUptime", () => {
  it("parses a loadavg line", () => {
    expect(parseLoadAvg("0.52 0.48 0.44 1/523 12345")).toEqual([0.52, 0.48, 0.44]);
  });

  it("parses uptime seconds", () => {
    expect(parseUptime("123456.78 987654.32")).toBe(123456.78);
  });

  it("returns undefined on malformed input", () => {
    expect(parseLoadAvg("")).toBeUndefined();
    expect(parseUptime("nope")).toBeUndefined();
  });
});
