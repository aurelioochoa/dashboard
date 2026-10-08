/* ============================================================
   palette.ts — the Ctrl+K command palette.

   Built on <dialog> so focus trapping, Esc-to-close and the
   backdrop come from the platform rather than from us.
   ============================================================ */

import type { Config } from "@homelab/shared";
import { requestScan } from "./api.js";
import { byId, copyText, esc } from "./dom.js";
import { navigate, type TabId } from "./router.js";
import { focusDevice } from "./render.js";
import { buildIndex, search, type Match, type SearchEntry } from "./search.js";
import { showToast } from "./toast.js";

let entries: SearchEntry[] = [];
let matches: Match[] = [];
let selected = 0;

let dialog: HTMLDialogElement | null = null;
let input: HTMLInputElement | null = null;
let list: HTMLElement | null = null;

export function initPalette(config: Config): void {
  entries = buildIndex(config);

  dialog = byId<HTMLDialogElement>("palette");
  input = byId<HTMLInputElement>("palette-input");
  list = byId("palette-results");
  if (!dialog || !input || !list) return;

  byId("palette-open")?.addEventListener("click", () => openPalette());

  input.addEventListener("input", () => refresh());
  input.addEventListener("keydown", onKeydown);

  list.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement | null)?.closest<HTMLElement>(".palette-item");
    const index = Number(item?.dataset["index"]);
    if (Number.isInteger(index)) activate(index);
  });

  // Clicking the backdrop (outside the panel) dismisses.
  const el = dialog;
  el.addEventListener("click", (e) => {
    if (e.target === el) el.close();
  });
}

/** Rebuild the index after a config change without losing an open query. */
export function refreshPaletteIndex(config: Config): void {
  entries = buildIndex(config);
  if (dialog?.open) refresh();
}

export function openPalette(prefill = ""): void {
  if (!dialog || !input) return;
  if (!dialog.open) dialog.showModal();
  input.value = prefill;
  refresh();
  input.focus();
  input.select();
}

export function isPaletteOpen(): boolean {
  return Boolean(dialog?.open);
}

function refresh(): void {
  matches = search(entries, input?.value ?? "");
  selected = 0;
  renderList();
}

function renderList(): void {
  if (!list) return;

  if (!matches.length) {
    list.innerHTML = '<li class="palette-empty">Sin resultados</li>';
    return;
  }

  list.innerHTML = matches
    .map((match, i) => {
      const title = highlight(match.entry.title, match.ranges);
      return (
        `<li class="palette-item" role="option" data-index="${i}" aria-selected="${i === selected}">` +
        `<span class="palette-item-icon">${esc(match.entry.icon)}</span>` +
        '<span class="palette-item-main">' +
        `<span class="palette-item-title">${title}</span>` +
        `<span class="palette-item-sub">${esc(match.entry.subtitle)}</span>` +
        "</span>" +
        `<span class="palette-item-kind">${esc(match.entry.kind)}</span>` +
        "</li>"
      );
    })
    .join("");

  scrollSelectedIntoView();
}

/** Wrap matched ranges in <mark>, escaping each slice separately so the
 *  markup we add is the only markup in the output. */
function highlight(text: string, ranges: Array<[number, number]>): string {
  if (!ranges.length) return esc(text);

  let out = "";
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) out += esc(text.slice(at, start));
    out += `<mark>${esc(text.slice(start, end))}</mark>`;
    at = end;
  }
  return out + esc(text.slice(at));
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
    e.preventDefault();
    move(1);
  } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
    e.preventDefault();
    move(-1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    activate(selected);
  } else if (e.key === "Home") {
    e.preventDefault();
    selected = 0;
    renderList();
  } else if (e.key === "End") {
    e.preventDefault();
    selected = matches.length - 1;
    renderList();
  }
  // Esc is handled by <dialog> itself.
}

function move(delta: number): void {
  if (!matches.length) return;
  // Wrap around: a list this short is faster to cycle than to reverse.
  selected = (selected + delta + matches.length) % matches.length;
  renderList();
}

function scrollSelectedIntoView(): void {
  list?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

function activate(index: number): void {
  const match = matches[index];
  if (!match) return;
  dialog?.close();
  void run(match.entry);
}

async function run(entry: SearchEntry): Promise<void> {
  if (entry.tab) {
    navigate({ tab: entry.tab as TabId });
    return;
  }

  if (entry.action) {
    await runAction(entry.action);
    return;
  }

  if (entry.url) {
    window.open(entry.url, "_blank", "noopener");
    return;
  }

  if (entry.device) {
    navigate({ tab: "dashboard", device: entry.device });
    focusDevice(entry.device);
    // Ports and IPs are usually looked up in order to paste them somewhere.
    if (entry.kind === "port" && entry.copy) void copyText(entry.copy);
  }
}

async function runAction(action: string): Promise<void> {
  if (action === "scan") {
    navigate({ tab: "topology" });
    const started = await requestScan();
    showToast(
      started ? "Escaneo solicitado" : "No se pudo iniciar el escaneo",
      started ? "info" : "error",
    );
    return;
  }
  if (action === "probe") {
    const res = await fetch("/api/health/check", { method: "POST" });
    showToast(res.ok ? "Health checks lanzados" : "Fallo al lanzar health checks", res.ok ? "success" : "error");
    return;
  }
  if (action === "shortcuts") {
    byId<HTMLDialogElement>("shortcuts")?.showModal();
  }
}
