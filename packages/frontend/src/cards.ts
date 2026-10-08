/* ============================================================
   cards.ts — device card construction.
   Exports createCard(device) → <article> element.

   Cards are built as HTML strings (fast, and the shape is
   static); every interpolated value goes through esc()/escUrl().
   Live regions are marked with data-* hooks that metrics.ts and
   health.ts update in place rather than re-rendering.
   ============================================================ */

import {
  inferType,
  osClass,
  shortOs,
  shortPortService,
  shortServiceName,
  TYPE_TINT,
  type Device,
  type DeviceType,
} from "@homelab/shared";
import { esc, escUrl } from "./dom.js";
import { healthId } from "@homelab/shared";

export function createCard(device: Device): HTMLElement {
  const type: DeviceType = device.type ?? inferType(device.role);
  const typeLabel = device.type_label ?? (device.role ? device.role.toUpperCase() : "DEVICE");
  const avatar = device.avatar ?? "💻";

  const article = document.createElement("article");
  article.className = "device-card";
  article.dataset.device = device.name;
  article.dataset.type = type;
  article.tabIndex = 0;
  article.setAttribute("role", "group");
  article.setAttribute("aria-label", `${device.name} (${device.ip})`);
  article.style.setProperty("--accent", `var(--accent-${type})`);
  article.style.setProperty("--avatar-bg", TYPE_TINT[type] ?? TYPE_TINT["server-x86"]);

  article.innerHTML =
    renderCardHeader(device, type, typeLabel, avatar) +
    '<div class="card-body">' +
    '<div class="card-face card-face-default">' +
    renderMetricsRow(device) +
    renderServicePills(device) +
    renderPortTags(device) +
    renderActions(device) +
    "</div>" +
    '<div class="card-face card-face-specs">' +
    renderSpecsTable(device.specs) +
    "</div>" +
    "</div>";

  return article;
}

function renderCardHeader(
  device: Device,
  type: DeviceType,
  typeLabel: string,
  avatar: string,
): string {
  const iconHtml =
    device.icon && device.icon.includes("/")
      ? `<img src="${escUrl(device.icon)}" alt="" loading="lazy">`
      : esc(avatar);

  const typeBadge = `<span class="badge type-${esc(type)}">${esc(typeLabel)}</span>`;

  const osText = device.os ?? (device.specs?.["OS"] as string | undefined) ?? "";
  const osBadge = osText
    ? `<span class="badge ${osClass(osText)}" title="${esc(osText)}">${esc(shortOs(osText))}</span>`
    : "";

  const sshCmd = `ssh root@${device.ip}`;
  const sshBadge = device.ssh
    ? `<span class="badge ssh" data-copy="${esc(sshCmd)}" title="${esc(sshCmd)}" role="button" tabindex="0">SSH</span>`
    : "";

  // Always present: the collector state dot doubles as the reachability
  // indicator once metrics start arriving.
  const stateDot =
    `<span class="integration-dot idle" data-state-dot title="Awaiting metrics"></span>`;

  const specsToggle = device.specs
    ? '<button class="specs-toggle" data-specs-toggle type="button" title="Toggle specs" aria-label="Toggle specs" aria-expanded="false">' +
      '<span class="toggle-default">⚙</span><span class="toggle-specs">←</span>' +
      "</button>"
    : "";

  const hostnameHtml = device.hostname
    ? `<span class="card-hostname" data-copy="${esc(device.hostname)}" title="Copy hostname">${esc(device.hostname)}</span>`
    : "";

  const macHtml = device.mac
    ? `<span class="card-mac" data-copy="${esc(device.mac)}" title="Copy MAC">${esc(device.mac)}</span>`
    : "";

  const wanHtml = device.upstream_ip
    ? '<div class="card-wan">' +
      '<span class="card-wan-label">WAN</span>' +
      `<span class="card-wan-ip" data-copy="${esc(device.upstream_ip)}" title="Copy upstream IP">${esc(device.upstream_ip)}</span>` +
      "</div>"
    : "";

  const aliasesHtml = device.aliases?.length
    ? '<div class="card-aliases">' +
      device.aliases
        .map(
          (a) =>
            `<span class="card-alias" data-copy="${esc(a)}" title="Copy alias">${esc(a)}</span>`,
        )
        .join("") +
      "</div>"
    : "";

  return (
    '<div class="card-header">' +
    `<button type="button" class="card-avatar" data-icon-picker="${esc(device.name)}" ` +
    `title="Cambiar icono" aria-label="Cambiar el icono de ${esc(device.name)}">${iconHtml}</button>` +
    '<div class="card-head-main">' +
    '<div class="card-head-top">' +
    `<h3 class="card-name">${esc(device.name)}${stateDot}</h3>` +
    `<div class="badge-row">${typeBadge}${osBadge}${sshBadge}${specsToggle}</div>` +
    "</div>" +
    '<div class="card-id">' +
    `<span class="card-ip" data-copy="${esc(device.ip)}" title="Copy IP">${esc(device.ip)}</span>` +
    hostnameHtml +
    macHtml +
    "</div>" +
    wanHtml +
    aliasesHtml +
    "</div>" +
    "</div>"
  );
}

/* ─── Live metrics ───
   Rendered as placeholder rows for every device the backend can
   collect from; metrics.ts fills the values in place. Devices with
   no collector get no row at all. */
function renderMetricsRow(device: Device): string {
  const collectible = device.ssh || device.integration || device.metrics;
  if (!collectible) return "";

  return (
    '<div class="health-row" data-health-row>' +
    '<span class="live-pill" data-live-pill>LIVE</span>' +
    metricItem("cpu", "CPU") +
    metricItem("mem", "RAM") +
    '<div class="metric-extras" data-metric-extras></div>' +
    '<div class="metric-foot"><span data-uptime></span><span data-net></span></div>' +
    "</div>"
  );
}

function metricItem(key: string, label: string): string {
  return (
    `<div class="health-item" data-metric="${esc(key)}">` +
    `<div class="health-label">${esc(label)} <span class="health-dim">—</span></div>` +
    '<div class="health-track"><div class="health-fill" style="width:0%;background:var(--muted)"></div></div>' +
    `<svg class="spark" data-spark viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true"></svg>` +
    "</div>"
  );
}

function renderServicePills(device: Device): string {
  if (!device.services?.length) return "";
  const pills = device.services
    .map((s) => {
      const declaredUp = ["active", "healthy", "running"].includes(s.status ?? "active");
      return (
        `<span class="svc-pill" data-service="${esc(s.name)}" title="${esc(s.info ?? s.name)}">` +
        `<span class="svc-dot ${declaredUp ? "up" : "down"}"></span>` +
        esc(shortServiceName(s.name)) +
        "</span>"
      );
    })
    .join("");
  return `<div class="service-pills">${pills}</div>`;
}

function renderPortTags(device: Device): string {
  const list = device.port_map?.length
    ? device.port_map.map((pm) => ({ port: pm.port, service: shortPortService(pm.service) }))
    : (device.ports ?? []).map((p) => ({ port: p, service: "" }));
  if (!list.length) return "";

  const tags = list
    .map((p) => {
      const id = healthId(device.name, "tcp", `${device.ip}:${p.port}`);
      return (
        `<span class="port-tag" data-copy="${p.port}" data-health-id="${esc(id)}" title="Copy port ${p.port}">` +
        `<span class="port-dot" data-health-dot></span>` +
        `<span class="port-num">${p.port}</span>` +
        (p.service ? ` ${esc(p.service)}` : "") +
        "</span>"
      );
    })
    .join("");
  return `<div class="port-tags">${tags}</div>`;
}

function renderActions(device: Device): string {
  const actions: Array<{ label: string; href: string }> = [];
  if (device.web) actions.push({ label: "Panel Web", href: device.web });
  for (const l of device.links ?? []) actions.push({ label: l.label, href: l.url });
  if (!actions.length) return "";

  const btns = actions
    .map((a) => {
      const id = healthId(device.name, "http", a.href);
      return (
        `<a class="action-btn" href="${escUrl(a.href)}" target="_blank" rel="noopener" data-health-id="${esc(id)}">` +
        `<span class="action-dot" data-health-dot></span>` +
        `${esc(a.label)} ↗</a>`
      );
    })
    .join("");
  return `<div class="card-actions">${btns}</div>`;
}

function renderSpecsTable(specs: Device["specs"]): string {
  const keys = specs ? Object.keys(specs) : [];
  if (!keys.length) return '<div class="specs-empty">Sin specs definidas.</div>';

  const rows = keys
    .map(
      (k) =>
        '<div class="spec-row">' +
        `<span class="spec-key">${esc(k)}</span>` +
        `<span class="spec-val">${esc(String(specs![k]))}</span>` +
        "</div>",
    )
    .join("");
  return `<div class="specs-table">${rows}</div>`;
}
