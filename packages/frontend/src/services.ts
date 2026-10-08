/* ============================================================
   services.ts — the Servicios tab.

   Flattens every service, port, container and link across all
   devices into one sortable, filterable table with live probe
   state. This is the config-driven half of "service discovery";
   the topology view supplies the discovered half.
   ============================================================ */

import { healthId, shortServiceName, type Config, type Device } from "@homelab/shared";
import { byId, copyText, esc, escUrl, qsa } from "./dom.js";
import { describe, latestHealth } from "./health.js";
import { navigate } from "./router.js";
import { focusDevice } from "./render.js";

type Kind = "service" | "port" | "container" | "link";

interface Row {
  kind: Kind;
  name: string;
  device: string;
  detail: string;
  url?: string;
  copy?: string;
  /** Probe id, when this row corresponds to something we can reach. */
  healthId?: string;
  port?: number;
}

const KIND_LABELS: Record<Kind, string> = {
  service: "servicio",
  port: "puerto",
  container: "contenedor",
  link: "enlace",
};

type SortKey = "name" | "device" | "kind" | "state";

let rows: Row[] = [];
let query = "";
let activeKinds = new Set<Kind>();
let sortKey: SortKey = "device";
let sortAsc = true;
let bound = false;

export function initServices(config: Config): void {
  rows = config.devices.flatMap(rowsForDevice);
  renderKindChips();

  if (!bound) {
    byId<HTMLInputElement>("services-filter")?.addEventListener("input", (e) => {
      query = (e.target as HTMLInputElement).value.trim().toLowerCase();
      renderTable();
    });

    byId("services-table")?.addEventListener("click", onTableClick);
    bound = true;
  }

  renderTable();
}

/** Repaint state columns when new probe results arrive.
 *  Skipped while the tab is hidden — showServices() repaints on entry. */
export function refreshServicesHealth(): void {
  if (byId("services-view")?.hidden) return;
  renderTable();
}

/** Called when the Servicios tab becomes visible, so probe results that
 *  arrived while another tab was open are reflected. */
export function showServices(): void {
  if (rows.length) renderTable();
}

function rowsForDevice(device: Device): Row[] {
  const out: Row[] = [];

  for (const service of device.services ?? []) {
    out.push({
      kind: "service",
      name: shortServiceName(service.name),
      device: device.name,
      detail: service.info ?? service.name,
    });
  }

  for (const container of device.docker ?? []) {
    out.push({
      kind: "container",
      name: container.name,
      device: device.name,
      detail: [container.image, container.info].filter(Boolean).join(" — "),
    });
  }

  const ports = device.port_map?.length
    ? device.port_map.map((p) => ({ port: p.port, label: p.service ?? "", proto: p.proto ?? "" }))
    : (device.ports ?? []).map((p) => ({ port: p, label: "", proto: "" }));

  for (const { port, label, proto } of ports) {
    out.push({
      kind: "port",
      name: String(port),
      device: device.name,
      detail: [label, proto].filter(Boolean).join(" · "),
      copy: String(port),
      port,
      healthId: /^udp$/i.test(proto) ? undefined : healthId(device.name, "tcp", `${device.ip}:${port}`),
    });
  }

  if (device.web) {
    out.push({
      kind: "link",
      name: "Panel Web",
      device: device.name,
      detail: device.web,
      url: device.web,
      healthId: healthId(device.name, "http", device.web),
    });
  }

  for (const link of device.links ?? []) {
    out.push({
      kind: "link",
      name: link.label,
      device: device.name,
      detail: link.url,
      url: link.url,
      healthId: healthId(device.name, "http", link.url),
    });
  }

  return out;
}

function renderKindChips(): void {
  const host = byId("services-kinds");
  if (!host) return;

  const counts = new Map<Kind, number>();
  for (const row of rows) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);

  host.innerHTML = (Object.keys(KIND_LABELS) as Kind[])
    .filter((k) => counts.has(k))
    .map(
      (k) =>
        `<button type="button" class="chip" data-kind="${k}" aria-pressed="false">` +
        `${KIND_LABELS[k]}<span class="chip-count">${counts.get(k)}</span></button>`,
    )
    .join("");

  host.addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement | null)?.closest<HTMLElement>(".chip");
    const kind = chip?.dataset["kind"] as Kind | undefined;
    if (!chip || !kind) return;
    if (activeKinds.has(kind)) activeKinds.delete(kind);
    else activeKinds.add(kind);
    chip.setAttribute("aria-pressed", String(activeKinds.has(kind)));
    renderTable();
  });
}

function stateOf(row: Row): "up" | "down" | "unknown" {
  if (!row.healthId) return "unknown";
  return latestHealth().get(row.healthId)?.state ?? "unknown";
}

function visibleRows(): Row[] {
  const filtered = rows.filter((row) => {
    if (activeKinds.size && !activeKinds.has(row.kind)) return false;
    if (!query) return true;
    return `${row.name} ${row.device} ${row.detail}`.toLowerCase().includes(query);
  });

  const order = { up: 0, unknown: 1, down: 2 };
  const dir = sortAsc ? 1 : -1;

  return filtered.sort((a, b) => {
    switch (sortKey) {
      case "state":
        return (order[stateOf(a)] - order[stateOf(b)]) * dir || a.device.localeCompare(b.device);
      case "kind":
        return a.kind.localeCompare(b.kind) * dir || a.name.localeCompare(b.name);
      case "name":
        // Ports sort numerically; everything else alphabetically.
        if (a.port !== undefined && b.port !== undefined) return (a.port - b.port) * dir;
        return a.name.localeCompare(b.name, undefined, { numeric: true }) * dir;
      default:
        return a.device.localeCompare(b.device) * dir || a.name.localeCompare(b.name);
    }
  });
}

function renderTable(): void {
  const table = byId("services-table");
  if (!table) return;

  const list = visibleRows();
  const header =
    "<thead><tr>" +
    th("state", "Estado") +
    th("name", "Nombre") +
    th("kind", "Tipo") +
    th("device", "Dispositivo") +
    "<th>Detalle</th>" +
    "</tr></thead>";

  if (!list.length) {
    table.innerHTML = `${header}<tbody><tr><td colspan="5" class="services-empty">Sin coincidencias</td></tr></tbody>`;
    return;
  }

  const body = list
    .map((row) => {
      const state = stateOf(row);
      const probe = row.healthId ? latestHealth().get(row.healthId) : undefined;
      const stateTitle = probe ? describe(probe) : "Sin sonda";
      const ms = probe?.responseMs !== undefined ? `${probe.responseMs} ms` : "";

      const nameCell = row.url
        ? `<a href="${escUrl(row.url)}" target="_blank" rel="noopener">${esc(row.name)} ↗</a>`
        : row.copy
          ? `<span class="col-mono" data-copy="${esc(row.copy)}" title="Copiar">${esc(row.name)}</span>`
          : esc(row.name);

      return (
        "<tr>" +
        `<td title="${esc(stateTitle)}"><span class="state-dot ${state}"></span><span class="col-mono">${esc(ms)}</span></td>` +
        `<td>${nameCell}</td>` +
        `<td><span class="kind-tag">${esc(KIND_LABELS[row.kind])}</span></td>` +
        `<td class="col-device" data-device="${esc(row.device)}" title="Ir a la tarjeta">${esc(row.device)}</td>` +
        `<td class="col-detail">${esc(row.detail)}</td>` +
        "</tr>"
      );
    })
    .join("");

  table.innerHTML = `${header}<tbody>${body}</tbody>`;
}

function th(key: SortKey, label: string): string {
  const sort = sortKey === key ? (sortAsc ? "ascending" : "descending") : "none";
  return `<th data-sort="${key}" aria-sort="${sort}">${esc(label)}</th>`;
}

function onTableClick(e: Event): void {
  const target = e.target as HTMLElement | null;
  if (!target) return;

  const header = target.closest<HTMLElement>("th[data-sort]");
  if (header) {
    const key = header.dataset["sort"] as SortKey;
    if (key === sortKey) sortAsc = !sortAsc;
    else {
      sortKey = key;
      sortAsc = true;
    }
    renderTable();
    return;
  }

  if (target.closest("a")) return;

  const deviceCell = target.closest<HTMLElement>(".col-device");
  if (deviceCell?.dataset["device"]) {
    const name = deviceCell.dataset["device"];
    navigate({ tab: "dashboard", device: name });
    focusDevice(name);
    return;
  }

  const copyEl = target.closest<HTMLElement>("[data-copy]");
  if (copyEl) void copyText(copyEl.dataset["copy"] ?? "");
}

/** Reset filter chips when the config reloads and kinds may have changed. */
export function resetServiceFilters(): void {
  activeKinds = new Set();
  for (const chip of qsa<HTMLElement>("#services-kinds .chip")) {
    chip.setAttribute("aria-pressed", "false");
  }
}
