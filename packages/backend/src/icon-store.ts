/* ============================================================
   icon-store.ts — user-uploaded device icons.

   They live beside config.yaml (config/icons/ by default) rather
   than in the frontend bundle: that directory is already a bind
   mount in docker-compose.yml, so uploads survive an image
   rebuild and can be inspected from the host.
   ============================================================ */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { env } from "./env.js";
import { publish } from "./events.js";

export class IconError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "IconError";
  }
}

/** Public URL prefix the static handler serves `env.iconDir` under. */
export const USER_ICON_PREFIX = "assets/icons/user";

export const MAX_ICON_BYTES = 512 * 1024;

const TYPES = [
  { ext: ".svg", mime: "image/svg+xml" },
  { ext: ".png", mime: "image/png" },
  { ext: ".webp", mime: "image/webp" },
  { ext: ".jpg", mime: "image/jpeg" },
] as const;

const EXT_BY_MIME = new Map<string, string>([
  ["image/svg+xml", ".svg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/jpeg", ".jpg"],
  ["image/jpg", ".jpg"],
]);

const ALLOWED_EXT: ReadonlySet<string> = new Set<string>(TYPES.map((t) => t.ext));

/** Raster magic bytes, so a renamed .exe can't pose as a PNG. */
function rasterLooksRight(ext: string, bytes: Buffer): boolean {
  if (ext === ".png") return bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (ext === ".jpg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (ext === ".webp") {
    return bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return true;
}

/** Reject SVGs that could execute in the viewer's origin. The static
 *  handler also sends nosniff + a locked-down CSP, but an SVG reached
 *  directly (or later exported) shouldn't carry script at all. */
const SVG_HAZARDS = [
  /<\s*script/i,
  /<\s*foreignObject/i,
  /\son\w+\s*=/i,
  /(href|xlink:href)\s*=\s*["']?\s*javascript:/i,
  /<!ENTITY/i,
];

function assertSafeSvg(text: string): void {
  for (const pattern of SVG_HAZARDS) {
    if (pattern.test(text)) {
      throw new IconError("SVG rejected: it contains script, event handlers or entities", 422);
    }
  }
  if (!/<\s*svg[\s>]/i.test(text)) throw new IconError("Not an SVG document", 422);
}

/**
 * Reduce a user-supplied name to a safe file name.
 *
 * Path separators and dot segments are stripped rather than escaped, so
 * `../../etc/passwd` becomes `etcpasswd` — there is no input that can
 * address anything outside the icon directory.
 */
export function safeIconName(input: string, ext: string): string {
  const base = input.replace(/\.[^.]*$/, "");
  const slug = base
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!slug) throw new IconError("Name must contain at least one letter or digit");
  return `${slug}${ext}`;
}

export interface UserIcon {
  /** File name, which is also the id used by DELETE. */
  name: string;
  /** Path to write into `icon:`. */
  path: string;
  bytes: number;
  modified: number;
}

export async function listUserIcons(): Promise<UserIcon[]> {
  let entries: string[];
  try {
    entries = await readdir(env.iconDir);
  } catch {
    return []; // Nothing uploaded yet — not an error.
  }

  const icons: UserIcon[] = [];
  for (const name of entries.sort()) {
    if (!ALLOWED_EXT.has(extname(name).toLowerCase())) continue;
    try {
      const info = await stat(join(env.iconDir, name));
      if (!info.isFile()) continue;
      icons.push({
        name,
        path: `${USER_ICON_PREFIX}/${name}`,
        bytes: info.size,
        modified: info.mtimeMs,
      });
    } catch {
      // Raced with a delete; just leave it out of the listing.
    }
  }
  return icons;
}

/** Validate and store one icon, overwriting a same-named upload. */
export async function saveUserIcon(name: string, mime: string, data: Buffer): Promise<UserIcon> {
  const ext = EXT_BY_MIME.get(mime.toLowerCase().split(";")[0]?.trim() ?? "");
  if (!ext) throw new IconError(`Unsupported type ${mime} — use SVG, PNG, WebP or JPEG`, 415);
  if (data.length === 0) throw new IconError("File is empty");
  if (data.length > MAX_ICON_BYTES) {
    throw new IconError(`File is ${Math.round(data.length / 1024)} KB; the limit is 512 KB`, 413);
  }

  if (ext === ".svg") assertSafeSvg(data.toString("utf8"));
  else if (!rasterLooksRight(ext, data)) {
    throw new IconError(`File content does not look like ${ext.slice(1).toUpperCase()}`, 422);
  }

  const fileName = safeIconName(name, ext);
  await mkdir(env.iconDir, { recursive: true });

  // Same temp+rename dance as config-store: a half-written icon must
  // never be servable.
  const target = join(env.iconDir, fileName);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, target);

  publish({ type: "icons", data: { reason: "saved" } });
  const info = await stat(target);
  return {
    name: fileName,
    path: `${USER_ICON_PREFIX}/${fileName}`,
    bytes: info.size,
    modified: info.mtimeMs,
  };
}

export async function deleteUserIcon(name: string): Promise<void> {
  const ext = extname(name).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) throw new IconError("Unknown icon", 404);

  const fileName = safeIconName(name, ext);
  const target = resolve(env.iconDir, fileName);
  // Belt and braces: safeIconName already removed any separator.
  if (!target.startsWith(resolve(env.iconDir))) throw new IconError("Unknown icon", 404);

  try {
    await readFile(target);
  } catch {
    throw new IconError("Unknown icon", 404);
  }
  await rm(target);
  publish({ type: "icons", data: { reason: "deleted" } });
}
