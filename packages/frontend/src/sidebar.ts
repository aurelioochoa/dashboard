/* ============================================================
   sidebar.ts — sidebar renderers (network card + stats grid).
   ============================================================ */

import type { Config, Device, Network } from "@homelab/shared";
import { byId, copyText, esc } from "./dom.js";

export function renderNetwork(config: Config): void {
  const el = byId("network-info");
  if (!el) return;

  const net: Network = config.network ?? {};
  const online = (config.devices ?? []).length;

  const upstreamHtml =
    net.upstream_gateway || net.upstream_ssid
      ? '<div class="net-upstream">' +
        '<div class="net-upstream-label">Upstream</div>' +
        optRow("Gateway", net.upstream_gateway, true) +
        optRow("SSID", net.upstream_ssid, true) +
        "</div>"
      : "";

  el.innerHTML =
    `<div class="net-row"><span class="net-label">Subnet</span>` +
    `<span class="net-value" data-copy="${esc(net.subnet ?? "")}">${esc(net.subnet ?? "—")}</span></div>` +
    `<div class="net-row"><span class="net-label">Gateway</span>` +
    `<span class="net-value" data-copy="${esc(net.gateway ?? "")}">${esc(net.gateway ?? "—")}</span></div>` +
    optRow("DNS", net.dns, true) +
    optRow("Domain", net.domain, false) +
    upstreamHtml +
    `<div class="net-online"><span class="pulse-dot"></span>${online} online</div>`;
}

function optRow(label: string, value: string | undefined, copyable: boolean): string {
  if (!value) return "";
  const copy = copyable ? ` data-copy="${esc(value)}"` : "";
  return (
    `<div class="net-row"><span class="net-label">${esc(label)}</span>` +
    `<span class="net-value"${copy}>${esc(value)}</span></div>`
  );
}

export function renderStats(devices: Device[]): void {
  const totals = { devices: devices.length, containers: 0, services: 0, ports: 0 };
  for (const d of devices) {
    totals.containers += d.docker?.length ?? 0;
    totals.services += d.services?.length ?? 0;
    totals.ports += (d.port_map?.length ?? 0) || (d.ports?.length ?? 0);
  }

  const el = byId("stats-grid");
  if (!el) return;
  el.innerHTML =
    statCell("green", totals.devices, "Devices") +
    statCell("blue", totals.containers, "Containers") +
    statCell("amber", totals.services, "Services") +
    statCell("purple", totals.ports, "Ports");
}

function statCell(tone: string, value: number, label: string): string {
  return (
    `<div class="stat-cell ${tone}">` +
    `<span class="stat-value">${value}</span>` +
    `<span class="stat-label">${esc(label)}</span>` +
    `</div>`
  );
}

/** One delegated listener for every copyable value in the sidebar. */
export function initSidebarCopy(): void {
  const sidebar = document.querySelector(".sidebar");
  sidebar?.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-copy]");
    if (target) void copyText(target.dataset.copy ?? "");
  });
}
