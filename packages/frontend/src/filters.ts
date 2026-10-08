/* ============================================================
   filters.ts — type chips + free-text filtering of the bento
   grid. Filter state lives in the URL query so a filtered view
   can be bookmarked and shared.
   ============================================================ */

import { DEVICE_TYPES, inferType, type Config, type Device, type DeviceType } from "@homelab/shared";
import { byId, qsa } from "./dom.js";
import { getDeviceElement } from "./render.js";

const TYPE_LABELS: Record<DeviceType, string> = {
  router: "Router",
  "server-x86": "x86",
  "server-arm": "ARM",
  legacy: "Legacy",
};

let devices: Device[] = [];
const activeTypes = new Set<DeviceType>();
let query = "";

export function initFilters(config: Config): void {
  devices = config.devices ?? [];
  renderChips();
  apply();
}

/** Everything about a device that free-text search should match. */
function haystack(device: Device): string {
  return [
    device.name,
    device.ip,
    device.hostname,
    device.mac,
    device.os,
    device.role,
    device.type_label,
    ...(device.aliases ?? []),
    ...(device.services ?? []).map((s) => s.name),
    ...(device.docker ?? []).map((d) => `${d.name} ${d.image ?? ""}`),
    ...(device.links ?? []).map((l) => l.label),
    ...(device.port_map ?? []).map((p) => `${p.port} ${p.service ?? ""}`),
    ...(device.ports ?? []).map(String),
    ...Object.entries(device.specs ?? {}).map(([k, v]) => `${k} ${String(v)}`),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function renderChips(): void {
  const host = byId("type-chips");
  if (!host) return;

  const counts = new Map<DeviceType, number>();
  for (const d of devices) {
    const type = d.type ?? inferType(d.role);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }

  host.innerHTML = DEVICE_TYPES.filter((t) => counts.has(t))
    .map(
      (t) =>
        `<button type="button" class="chip" data-type="${t}" aria-pressed="false" ` +
        `style="--chip-accent: var(--accent-${t})">` +
        `<span class="chip-dot"></span>${TYPE_LABELS[t]}` +
        `<span class="chip-count">${counts.get(t)}</span></button>`,
    )
    .join("");

  host.addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement | null)?.closest<HTMLElement>(".chip");
    const type = chip?.dataset["type"] as DeviceType | undefined;
    if (!chip || !type) return;

    if (activeTypes.has(type)) activeTypes.delete(type);
    else activeTypes.add(type);
    chip.setAttribute("aria-pressed", String(activeTypes.has(type)));
    apply();
  });
}

export function setQuery(next: string): void {
  query = next.trim().toLowerCase();
  apply();
}

export function clearFilters(): boolean {
  if (!query && activeTypes.size === 0) return false;
  query = "";
  activeTypes.clear();
  for (const chip of qsa<HTMLElement>(".chip")) chip.setAttribute("aria-pressed", "false");
  apply();
  return true;
}

export function hasActiveFilters(): boolean {
  return Boolean(query) || activeTypes.size > 0;
}

function apply(): void {
  let visible = 0;

  for (const device of devices) {
    const card = getDeviceElement(device.name);
    if (!card) continue;

    const type = device.type ?? inferType(device.role);
    const typeOk = activeTypes.size === 0 || activeTypes.has(type);
    const textOk = !query || haystack(device).includes(query);
    const show = typeOk && textOk;

    card.hidden = !show;
    if (show) visible++;
  }

  const count = byId("grid-count");
  if (count) {
    count.textContent = hasActiveFilters()
      ? `${visible} de ${devices.length} dispositivos`
      : `${devices.length} dispositivos`;
  }
}
