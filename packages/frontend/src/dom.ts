/* ============================================================
   dom.ts — DOM utilities: HTML escaping, element lookup,
   clipboard with toast feedback.
   ============================================================ */

import { showToast } from "./toast.js";

/** Escape a value for safe interpolation into an HTML string. */
export function esc(str: unknown): string {
  if (str == null) return "";
  const div = document.createElement("div");
  div.appendChild(document.createTextNode(String(str)));
  return div.innerHTML;
}

/** Escape a URL for an href, neutralising javascript:/data: schemes.
 *  Config is self-authored, but a typo shouldn't become an XSS vector. */
export function escUrl(url: unknown): string {
  const raw = String(url ?? "").trim();
  if (/^(javascript|data|vbscript):/i.test(raw)) return "#";
  return esc(raw);
}

/** Typed getElementById that returns null rather than throwing. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** Typed querySelector rooted at an element or document. */
export function qs<T extends Element = Element>(
  selector: string,
  root: ParentNode = document,
): T | null {
  return root.querySelector<T>(selector);
}

export function qsa<T extends Element = Element>(
  selector: string,
  root: ParentNode = document,
): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

/** Copy text to the clipboard and confirm with a toast. */
export async function copyText(text: string): Promise<void> {
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // Older/insecure-context fallback — a LAN dashboard served over
      // plain http:// has no navigator.clipboard.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    showToast(`Copied ${truncate(text, 40)}`, "success");
  } catch {
    showToast("Copy failed", "error");
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
