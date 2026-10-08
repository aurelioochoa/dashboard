import { describe, expect, it } from "vitest";
import { setDeviceIcon } from "../src/index.js";

const YAML = `title: Homelab Dashboard

devices:
  # The router sits in front of everything.
  - name: edge-router
    role: Router
    icon: assets/vendor-logo.svg
    ip: 10.20.0.1
    specs:
      RAM: 64 MiB

  - name: atlas
    role: Server
    ip: 10.20.0.10   # trailing comment
    ssh: true
`;

describe("setDeviceIcon", () => {
  it("rewrites an existing icon: line in place", () => {
    const out = setDeviceIcon(YAML, "edge-router", "assets/icons/router.svg");
    expect(out).toContain("    icon: assets/icons/router.svg");
    expect(out).not.toContain("vendor-logo");
    // Everything else survives, comments included.
    expect(out).toContain("# The router sits in front of everything.");
    expect(out).toContain("10.20.0.10   # trailing comment");
    expect(out.split("\n").length).toBe(YAML.split("\n").length);
  });

  it("inserts icon: below the name when the device has none", () => {
    const out = setDeviceIcon(YAML, "atlas", "assets/icons/server-tower.svg");
    const lines = out.split("\n");
    const at = lines.indexOf("  - name: atlas");
    expect(lines[at + 1]).toBe("    icon: assets/icons/server-tower.svg");
    // The other device keeps its own icon.
    expect(out).toContain("icon: assets/vendor-logo.svg");
  });

  it("edits only the named device", () => {
    const out = setDeviceIcon(YAML, "atlas", "assets/icons/nas.svg");
    expect(out.match(/icon:/g)).toHaveLength(2);
    expect(out).toContain("icon: assets/vendor-logo.svg");
  });

  it("leaves the text alone when the device is absent", () => {
    expect(setDeviceIcon(YAML, "nope", "assets/icons/nas.svg")).toBe(YAML);
  });

  it("matches a quoted name and preserves CRLF line endings", () => {
    const crlf = 'devices:\r\n  - name: "pi node"\r\n    ip: 1.2.3.4\r\n';
    const out = setDeviceIcon(crlf, "pi node", "assets/icons/sbc.svg");
    expect(out).toContain('  - name: "pi node"\r\n    icon: assets/icons/sbc.svg\r\n');
    expect(out).not.toContain("\n\n");
  });

  it("does not reach into the next device's block", () => {
    // `atlas` has no icon; the insertion must not land in edge-router's block.
    const out = setDeviceIcon(YAML, "atlas", "assets/icons/nas.svg");
    const routerBlock = out.slice(out.indexOf("- name: edge-router"), out.indexOf("- name: atlas"));
    expect(routerBlock).not.toContain("nas.svg");
  });
});
