/* ============================================================
   config-edit.ts — surgical edits to config.yaml text.

   Deliberately line-based rather than a js-yaml round trip:
   config.yaml is hand-written and full of comments, blank-line
   grouping and quoting choices, and `yaml.dump(yaml.load(text))`
   throws all of that away. These helpers touch one line and
   leave every other byte alone.
   ============================================================ */

/** Indentation of a line, e.g. "    " for `    icon: x`. */
function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

/** True for `- name: atlas` / `name: atlas`, quoted or not. */
function nameValue(line: string): string | undefined {
  const m = /^[ \t]*(?:-[ \t]+)?name:[ \t]*(.*?)[ \t]*$/.exec(line);
  if (!m) return undefined;
  const raw = m[1] ?? "";
  const unquoted = /^(['"])(.*)\1$/.exec(raw);
  return unquoted ? unquoted[2] : raw;
}

/** Where a device's block ends: the next line that starts a sibling
 *  list item at the same indentation, or end of document. */
function blockEnd(lines: string[], start: number, itemIndent: string): number {
  const marker = `${itemIndent}-`;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith(marker)) return i;
    // A key at or above the list's own indentation ends the `devices:` block.
    if (line.trim() !== "" && !line.startsWith(" ") && !line.startsWith("\t")) return i;
  }
  return lines.length;
}

/**
 * Point `deviceName` at `iconPath`, returning the new YAML text.
 *
 * Rewrites the device's existing `icon:` line when it has one, and
 * otherwise inserts the key right after its `- name:` line, matching
 * the indentation of its siblings. Returns the text unchanged when no
 * device by that name is present.
 */
export function setDeviceIcon(text: string, deviceName: string, iconPath: string): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);

  const nameIndex = lines.findIndex(
    (line) => /^[ \t]*-[ \t]+name:/.test(line) && nameValue(line) === deviceName,
  );
  if (nameIndex === -1) return text;

  const nameLine = lines[nameIndex] ?? "";
  const itemIndent = indentOf(nameLine);
  // `- name: x` puts the key two columns in from the dash.
  const keyIndent = `${itemIndent}  `;
  const end = blockEnd(lines, nameIndex, itemIndent);

  for (let i = nameIndex; i < end; i++) {
    const existing = /^([ \t]*)icon:[ \t]/.exec(lines[i] ?? "");
    if (existing) {
      lines[i] = `${existing[1]}icon: ${iconPath}`;
      return lines.join(newline);
    }
  }

  lines.splice(nameIndex + 1, 0, `${keyIndent}icon: ${iconPath}`);
  return lines.join(newline);
}
