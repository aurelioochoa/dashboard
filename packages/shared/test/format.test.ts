import { describe, expect, it } from "vitest";
import {
  formatBytes, formatRate, formatUptime, healthColor, inferType,
  osClass, shortOs, shortPortService, shortServiceName,
} from "../src/index.js";

describe("shortOs", () => {
  it.each([
    ["OpenWrt 23.05", "OpenWrt 23.05"],
    // No digit directly after the first word, so it falls back to the
    // first-two-words form rather than "Alpine 3.19".
    ["Alpine Linux v3.19", "Alpine Linux"],
    ["Armbian 26.2.0 (Debian 13 Trixie)", "Armbian 26.2"],
    ["Arch Linux (rolling)", "Arch Linux"],
  ])("%s → %s", (input, expected) => {
    expect(shortOs(input)).toBe(expected);
  });

  it("returns empty for undefined", () => {
    expect(shortOs(undefined)).toBe("");
  });
});

describe("osClass", () => {
  it.each([
    ["OpenWrt 23.05", "os-openwrt"],
    ["Arch Linux", "os-arch"],
    ["Armbian 26.2.0 (Debian 13 Trixie)", "os-armbian"],
    ["Alpine Linux v3.19", "os-alpine"],
    ["Windows 11", "os-generic"],
  ])("%s → %s", (input, expected) => {
    expect(osClass(input)).toBe(expected);
  });
});

describe("shortPortService / shortServiceName", () => {
  it.each([
    ["Dropbear SSH", "SSH"],
    ["dnsmasq (DNS/DHCP)", "dnsmasq"],
    ["Grafana API", "API"],
    ["sshd", "sshd"],
    ["Homelab Dashboard", "Homelab"],
  ])("shortPortService(%s) → %s", (input, expected) => {
    expect(shortPortService(input)).toBe(expected);
  });

  it("collapses parenthesised service names", () => {
    expect(shortServiceName("firewall (nftables)")).toBe("firewall");
    expect(shortServiceName("mosquitto (MQTT)")).toBe("mosquitto");
  });

  it("handles empty input without throwing", () => {
    expect(shortPortService(undefined)).toBe("");
    expect(shortPortService("")).toBe("");
    expect(shortPortService("   ")).toBe("");
  });
});

describe("healthColor", () => {
  it("escalates accent → amber → red", () => {
    expect(healthColor(10, "router")).toBe("var(--accent-router)");
    expect(healthColor(70, "router")).toBe("var(--amber)");
    expect(healthColor(95, "router")).toBe("var(--red)");
  });
});

describe("inferType", () => {
  it("detects routers by role and falls back to x86", () => {
    expect(inferType("Router")).toBe("router");
    expect(inferType("Server")).toBe("server-x86");
    expect(inferType(undefined)).toBe("server-x86");
  });
});

describe("formatBytes / formatRate / formatUptime", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [1024, "1 KiB"],
    [1536, "1.5 KiB"],
    [1024 ** 3 * 2, "2 GiB"],
  ])("formatBytes(%i) → %s", (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });

  it("suffixes rates", () => {
    expect(formatRate(2048)).toBe("2 KiB/s");
  });

  it.each([
    [90, "1m"],
    [3660, "1h 1m"],
    [93784, "1d 2h 3m"],
  ])("formatUptime(%i) → %s", (input, expected) => {
    expect(formatUptime(input)).toBe(expected);
  });

  it("returns a dash for nonsense", () => {
    expect(formatBytes(NaN)).toBe("—");
    expect(formatUptime(-1)).toBe("—");
  });
});
