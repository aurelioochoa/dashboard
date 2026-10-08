import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PRESET_ICONS, presetIconFor, presetIconPath } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "../../frontend/public");

describe("preset icons", () => {
  it("ships an SVG for every catalog entry", () => {
    const missing = PRESET_ICONS.filter(
      (icon) => !existsSync(resolve(publicDir, presetIconPath(icon.id))),
    ).map((icon) => icon.id);
    expect(missing).toEqual([]);
  });

  it("has unique ids", () => {
    const ids = PRESET_ICONS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves an icon: value back to its preset", () => {
    expect(presetIconFor("assets/icons/nas.svg")?.label).toBe("NAS");
    expect(presetIconFor("/assets/icons/nas.svg")?.id).toBe("nas");
    // A custom image is not a preset, and neither is an empty field.
    expect(presetIconFor("assets/my-logo.svg")).toBeUndefined();
    expect(presetIconFor(undefined)).toBeUndefined();
  });
});
