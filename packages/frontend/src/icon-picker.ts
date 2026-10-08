/* ============================================================
   icon-picker.ts — the icon gallery, in two guises.

   Same grid either way: docked beside the YAML editor in the
   Config tab, or in a <dialog> opened from a device card's
   avatar. The docked one writes into the editor at the cursor;
   the dialog patches config.yaml for one named device and saves.

   Both also upload and delete custom icons, which live server
   side under config/icons/ and are served from
   /assets/icons/user/.
   ============================================================ */

import { PRESET_ICONS, presetIconPath, setDeviceIcon, type PresetIcon } from "@homelab/shared";
import {
  deleteIcon,
  fetchConfigText,
  fetchIcons,
  saveConfigText,
  uploadIcon,
  type IconCatalog,
} from "./api.js";
import { applyIconPath } from "./config-editor.js";
import { byId, copyText, esc, escUrl, qsa } from "./dom.js";
import { showToast } from "./toast.js";

/** Latest listing from the backend; `null` until the first fetch. */
let catalog: IconCatalog | null = null;

/** Every mounted gallery, so an upload refreshes the panel and the
 *  dialog alike without either knowing about the other. */
const mounted = new Set<HTMLElement>();

let dialog: HTMLDialogElement | null = null;
let dialogDevice = "";

/* ─── Docked gallery (Config tab) ─── */

export function ensureIconPicker(): void {
  const host = byId("icon-picker");
  if (!host || mounted.has(host)) return;

  mount(host, (path) => {
    if (!applyIconPath(path)) {
      showToast("Abrí el editor y ubicá el cursor en un dispositivo", "error");
      return;
    }
    void copyText(path);
  });

  byId<HTMLInputElement>("icon-filter")?.addEventListener("input", (ev) => {
    filterGallery(host, (ev.target as HTMLInputElement).value);
  });
}

/* ─── Dialog (device card) ─── */

/** Open the gallery for one device; picking writes config.yaml. */
export function openIconDialog(deviceName: string): void {
  dialogDevice = deviceName;

  if (!dialog) {
    dialog = byId<HTMLDialogElement>("icon-dialog");
    if (!dialog) return;
    const el = dialog;

    el.addEventListener("click", (ev) => {
      if (ev.target === el) el.close();
    });
    byId("icon-dialog-close")?.addEventListener("click", () => el.close());
    byId<HTMLInputElement>("icon-dialog-filter")?.addEventListener("input", (ev) => {
      const host = byId("icon-dialog-picker");
      if (host) filterGallery(host, (ev.target as HTMLInputElement).value);
    });

    const host = byId("icon-dialog-picker");
    if (host) mount(host, (path) => void assignToDevice(dialogDevice, path));
  }

  const label = byId("icon-dialog-device");
  if (label) label.textContent = deviceName;

  const filter = byId<HTMLInputElement>("icon-dialog-filter");
  if (filter) {
    filter.value = "";
    const host = byId("icon-dialog-picker");
    if (host) filterGallery(host, "");
  }

  dialog.showModal();
  filter?.focus();
}

async function assignToDevice(deviceName: string, path: string): Promise<void> {
  try {
    const text = await fetchConfigText();
    const next = setDeviceIcon(text, deviceName, path);
    if (next === text) {
      showToast(`No encontré "${deviceName}" en config.yaml`, "error");
      return;
    }
    const result = await saveConfigText(next);
    if (!result.ok) {
      showToast(result.error ?? "No se pudo guardar", "error");
      return;
    }
    // The backend broadcasts `config`; main.ts re-renders the cards.
    showToast(`Icono de ${deviceName} actualizado`, "success");
    dialog?.close();
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), "error");
  }
}

/* ─── Shared gallery machinery ─── */

type PickHandler = (path: string) => void;

const handlers = new WeakMap<HTMLElement, PickHandler>();

function mount(host: HTMLElement, onPick: PickHandler): void {
  mounted.add(host);
  handlers.set(host, onPick);

  host.addEventListener("click", (ev) => void onHostClick(host, ev));
  host.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") void onHostClick(host, ev);
  });

  paint(host);
  void refreshCatalog();
}

async function onHostClick(host: HTMLElement, ev: Event): Promise<void> {
  const target = ev.target as HTMLElement | null;

  const remove = target?.closest<HTMLElement>("[data-icon-delete]");
  if (remove) {
    ev.preventDefault();
    ev.stopPropagation(); // Never also count as picking the icon.
    await removeIcon(remove.dataset["iconDelete"] ?? "");
    return;
  }

  const tile = target?.closest<HTMLElement>(".icon-tile");
  const path = tile?.dataset["path"];
  if (!path) return;
  ev.preventDefault();
  handlers.get(host)?.(path);
}

async function refreshCatalog(): Promise<void> {
  try {
    catalog = await fetchIcons();
  } catch {
    // The presets are compiled in, so a failed listing costs only the
    // custom section; keep the gallery usable.
    catalog = catalog ?? null;
  }
  repaintAll();
}

/** Called from main.ts when the backend reports an icon change. */
export function onIconsChanged(): void {
  void refreshCatalog();
}

function repaintAll(): void {
  for (const host of mounted) {
    const query = filterInputFor(host)?.value ?? "";
    paint(host);
    if (query) filterGallery(host, query);
  }
}

function filterInputFor(host: HTMLElement): HTMLInputElement | null {
  return byId<HTMLInputElement>(host.id === "icon-picker" ? "icon-filter" : "icon-dialog-filter");
}

function paint(host: HTMLElement): void {
  host.innerHTML = renderCustomGroup() + renderPresetGroups();
  wireUpload(host);
}

function renderPresetGroups(): string {
  const categories = [...new Set(PRESET_ICONS.map((i) => i.category))];
  return categories
    .map((category) => {
      const tiles = PRESET_ICONS.filter((i) => i.category === category)
        .map((icon) => renderTile(presetIconPath(icon.id), icon.label, searchText(icon)))
        .join("");
      return group(category, tiles);
    })
    .join("");
}

function renderCustomGroup(): string {
  const tiles = (catalog?.user ?? [])
    .map((icon) => {
      const label = icon.name.replace(/\.[^.]+$/, "");
      return renderTile(icon.path, label, `${icon.name} ${label} personalizado custom`, icon.name);
    })
    .join("");

  const upload =
    '<label class="icon-upload" tabindex="0">' +
    '<input type="file" accept=".svg,.png,.webp,.jpg,.jpeg,image/svg+xml,image/png,image/webp,image/jpeg" multiple hidden>' +
    '<span class="icon-upload-plus" aria-hidden="true">+</span>' +
    "<span>Subir</span>" +
    "</label>";

  return group("Personalizados", tiles + upload, "personalizados subir upload custom");
}

function group(title: string, tiles: string, extraSearch = ""): string {
  return (
    `<div class="icon-group" data-search="${esc(extraSearch)}">` +
    `<h4 class="icon-group-title">${esc(title)}</h4>` +
    `<div class="icon-grid">${tiles}</div>` +
    "</div>"
  );
}

function searchText(icon: PresetIcon): string {
  return `${icon.id} ${icon.label} ${icon.keywords.join(" ")}`.toLowerCase();
}

/** One grid cell. The delete control is a sibling of the tile, not a
 *  child: a <button> inside a <button> is invalid HTML and the parser
 *  hoists the inner one right out of the tile. */
function renderTile(path: string, label: string, haystack: string, deleteName?: string): string {
  const remove = deleteName
    ? `<button type="button" class="icon-delete" data-icon-delete="${esc(deleteName)}" ` +
      `title="Borrar ${esc(deleteName)}" aria-label="Borrar ${esc(deleteName)}">×</button>`
    : "";
  return (
    `<div class="icon-cell" data-search="${esc(haystack.toLowerCase())}">` +
    `<button type="button" class="icon-tile" data-path="${esc(path)}" title="${esc(path)}">` +
    `<img src="${escUrl(path)}" alt="" loading="lazy">` +
    `<span class="icon-tile-label">${esc(label)}</span>` +
    "</button>" +
    remove +
    "</div>"
  );
}

/* ─── Upload ─── */

function wireUpload(host: HTMLElement): void {
  const label = host.querySelector<HTMLElement>(".icon-upload");
  const input = label?.querySelector<HTMLInputElement>("input[type=file]");
  if (!label || !input) return;

  // The <label> wraps the input, so a click already opens the picker;
  // this only adds keyboard parity.
  label.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      input.click();
    }
  });

  input.addEventListener("change", () => {
    void send([...(input.files ?? [])]);
    input.value = "";
  });

  for (const name of ["dragover", "dragenter"]) {
    label.addEventListener(name, (ev) => {
      ev.preventDefault();
      label.classList.add("is-dropping");
    });
  }
  for (const name of ["dragleave", "drop"]) {
    label.addEventListener(name, () => label.classList.remove("is-dropping"));
  }
  label.addEventListener("drop", (ev) => {
    ev.preventDefault();
    void send([...((ev as DragEvent).dataTransfer?.files ?? [])]);
  });
}

async function send(files: File[]): Promise<void> {
  if (!files.length) return;
  for (const file of files) {
    try {
      const icon = await uploadIcon(file);
      showToast(`${icon.name} subido`, "success");
    } catch (err) {
      showToast(`${file.name}: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }
  await refreshCatalog();
}

async function removeIcon(name: string): Promise<void> {
  if (!name) return;
  try {
    await deleteIcon(name);
    showToast(`${name} borrado`, "success");
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), "error");
  }
  await refreshCatalog();
}

/* ─── Filtering ─── */

/** Hides non-matching tiles, and any group left with none. */
function filterGallery(host: HTMLElement, query: string): void {
  const q = query.trim().toLowerCase();
  for (const group of qsa<HTMLElement>(".icon-group", host)) {
    const groupMatch = !q || (group.dataset["search"] ?? "").includes(q);
    let visible = 0;
    for (const cell of qsa<HTMLElement>(".icon-cell", group)) {
      const match = !q || groupMatch || (cell.dataset["search"] ?? "").includes(q);
      cell.hidden = !match;
      if (match) visible++;
    }
    // The upload button belongs to the custom group, so it follows it.
    const upload = group.querySelector<HTMLElement>(".icon-upload");
    if (upload) upload.hidden = !(!q || groupMatch);
    group.hidden = visible === 0 && !(upload && !upload.hidden);
  }
}
