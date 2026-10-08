/* ============================================================
   topology.ts — the Topology tab: draws the netmap graph as
   interactive SVG with pan/zoom and click-through to cards.
   ============================================================ */

import { ROLE_ACCENT, type Config, type TopologySnapshot } from "@homelab/shared";
import { requestScan } from "./api.js";
import { byId, esc } from "./dom.js";
import { navigate } from "./router.js";
import { focusDevice } from "./render.js";
import { showToast } from "./toast.js";
import { buildLayout, neighboursOf, type Layout } from "./topology-layout.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3;

let config: Config | null = null;
let snapshot: TopologySnapshot = { graph: null, scannedAt: null, scanning: false };
let layout: Layout | null = null;

let svg: SVGSVGElement | null = null;
let viewport: SVGGElement | null = null;
const view = { x: 0, y: 0, scale: 1 };
let bound = false;

export function initTopology(nextConfig: Config): void {
  config = nextConfig;

  if (!bound) {
    byId("topology-scan")?.addEventListener("click", () => void onScan());
    byId("topology-fit")?.addEventListener("click", () => fit());
    bound = true;
  }
  draw();
}

export function applyTopology(next: TopologySnapshot): void {
  const isFirstGraph = !snapshot.graph && Boolean(next.graph);
  snapshot = next;
  draw();
  if (isFirstGraph) fit();
}

async function onScan(): Promise<void> {
  const button = byId<HTMLButtonElement>("topology-scan");
  if (button) button.disabled = true;

  const ok = await requestScan();
  showToast(
    ok ? "Escaneo solicitado — puede tardar un minuto" : "No se pudo iniciar el escaneo",
    ok ? "info" : "error",
  );

  // The sidecar clears its lock file when done, which arrives over SSE;
  // this only re-enables the button if that never happens.
  window.setTimeout(() => {
    if (button) button.disabled = false;
  }, 5000);
}

function draw(): void {
  const canvas = byId("topology-canvas");
  if (!canvas || !config) return;

  if (!snapshot.graph) {
    layout = null;
    updateMeta();
    canvas.innerHTML =
      '<div class="topology-empty">' +
      '<div class="placeholder-icon">🗺️</div>' +
      `<p>${esc(snapshot.error ?? "Todavía no hay un escaneo de red.")}</p>` +
      "<p>Ejecutá <strong>Escanear ahora</strong> para que netmap descubra la red.</p>" +
      "</div>";
    renderLegend([]);
    return;
  }

  layout = buildLayout(snapshot.graph, config);
  // After buildLayout: the meta line reports how many hosts matched config.
  updateMeta();
  renderSvg(canvas, layout);
  renderLegend(layout.nodes.map((n) => n.role));
}

function updateMeta(): void {
  const meta = byId("topology-meta");
  if (!meta) return;

  if (snapshot.scanning) {
    meta.textContent = "Escaneando…";
    return;
  }
  if (!snapshot.scannedAt) {
    meta.textContent = "Sin escaneos todavía";
    return;
  }

  const hosts = snapshot.graph ? Object.keys(snapshot.graph.hosts).length : 0;
  const known = layout?.nodes.filter((n) => n.known).length ?? 0;
  const when = new Date(snapshot.scannedAt).toLocaleString("es-ES");
  meta.textContent = `${hosts} hosts (${known} conocidos) · ${when}`;
}

function renderSvg(canvas: HTMLElement, current: Layout): void {
  svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Topología de red");

  viewport = document.createElementNS(SVG_NS, "g");
  svg.appendChild(viewport);

  // Tier bands first so they sit behind everything.
  for (const tier of current.tiers) {
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("class", "topo-tier-label");
    label.setAttribute("x", "8");
    label.setAttribute("y", String(tier.y - 10));
    label.textContent = tier.label;
    viewport.appendChild(label);
  }

  for (const edge of current.edges) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("class", "topo-edge");
    path.dataset["from"] = edge.from;
    path.dataset["to"] = edge.to;
    // A vertical cubic curve reads better than a straight diagonal when
    // several children fan out from one parent.
    const midY = (edge.fromY + edge.toY) / 2;
    path.setAttribute(
      "d",
      `M ${edge.fromX} ${edge.fromY} C ${edge.fromX} ${midY}, ${edge.toX} ${midY}, ${edge.toX} ${edge.toY}`,
    );
    viewport.appendChild(path);
  }

  for (const node of current.nodes) {
    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("class", `topo-node ${node.known ? "known" : "unknown"}`);
    group.setAttribute("transform", `translate(${node.x}, ${node.y})`);
    group.setAttribute("tabindex", "0");
    group.dataset["id"] = node.id;
    if (node.device) group.dataset["device"] = node.device.name;
    group.style.setProperty("--node-accent", ROLE_ACCENT[node.role]);

    const openPorts = node.host?.open_ports?.length ?? 0;
    const title = document.createElementNS(SVG_NS, "title");
    title.textContent = [
      node.label,
      node.ip,
      node.host?.mac ? `MAC ${node.host.mac}` : "",
      node.host?.vendor ?? "",
      `Rol: ${node.role}`,
      openPorts ? `${openPorts} puertos abiertos` : "",
      node.known ? "Configurado en config.yaml" : "Descubierto — no está en config.yaml",
    ]
      .filter(Boolean)
      .join("\n");
    group.appendChild(title);

    const box = document.createElementNS(SVG_NS, "rect");
    box.setAttribute("class", "topo-node-box");
    box.setAttribute("width", String(node.width));
    box.setAttribute("height", String(node.height));
    group.appendChild(box);

    group.appendChild(text("topo-node-role", 10, 15, node.role.toUpperCase()));
    group.appendChild(text("topo-node-label", 10, 31, truncate(node.label, 20)));
    group.appendChild(text("topo-node-sub", 10, 44, node.sublabel));

    viewport.appendChild(group);
  }

  svg.setAttribute("viewBox", `0 0 ${current.width} ${current.height}`);
  canvas.replaceChildren(svg);

  attachInteractions(canvas);
  applyTransform();
}

function text(cls: string, x: number, y: number, content: string): SVGTextElement {
  const el = document.createElementNS(SVG_NS, "text");
  el.setAttribute("class", cls);
  el.setAttribute("x", String(x));
  el.setAttribute("y", String(y));
  el.textContent = content;
  return el;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function attachInteractions(canvas: HTMLElement): void {
  if (!svg) return;

  svg.addEventListener("click", (e) => {
    const group = (e.target as Element | null)?.closest<SVGGElement>(".topo-node");
    const device = group?.dataset["device"];
    if (!device) return;
    navigate({ tab: "dashboard", device });
    focusDevice(device);
  });

  svg.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const group = (e.target as Element | null)?.closest<SVGGElement>(".topo-node");
    const device = group?.dataset["device"];
    if (!device) return;
    e.preventDefault();
    navigate({ tab: "dashboard", device });
    focusDevice(device);
  });

  // Hover dims everything that isn't a direct neighbour.
  svg.addEventListener("mouseover", (e) => {
    const group = (e.target as Element | null)?.closest<SVGGElement>(".topo-node");
    const id = group?.dataset["id"];
    if (id && layout) highlight(neighboursOf(layout, id), id);
  });
  svg.addEventListener("mouseout", (e) => {
    if ((e.target as Element | null)?.closest(".topo-node")) clearHighlight();
  });

  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onPointerDown);
}

function highlight(neighbours: Set<string>, focusId: string): void {
  if (!viewport) return;
  for (const node of viewport.querySelectorAll<SVGGElement>(".topo-node")) {
    node.classList.toggle("dimmed", !neighbours.has(node.dataset["id"] ?? ""));
  }
  for (const edge of viewport.querySelectorAll<SVGPathElement>(".topo-edge")) {
    const touches = edge.dataset["from"] === focusId || edge.dataset["to"] === focusId;
    edge.classList.toggle("highlight", touches);
    edge.classList.toggle("dimmed", !touches);
  }
}

function clearHighlight(): void {
  if (!viewport) return;
  for (const el of viewport.querySelectorAll(".dimmed, .highlight")) {
    el.classList.remove("dimmed", "highlight");
  }
}

/* ─── Pan / zoom ─── */

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const next = clamp(view.scale * factor, MIN_ZOOM, MAX_ZOOM);

  // Zoom toward the pointer rather than the origin.
  const canvas = e.currentTarget as HTMLElement;
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const ratio = next / view.scale;

  view.x = px - (px - view.x) * ratio;
  view.y = py - (py - view.y) * ratio;
  view.scale = next;
  applyTransform();
}

function onPointerDown(e: PointerEvent): void {
  // Let clicks on nodes through; only empty space pans.
  if ((e.target as Element | null)?.closest(".topo-node")) return;

  const canvas = e.currentTarget as HTMLElement;
  const startX = e.clientX - view.x;
  const startY = e.clientY - view.y;
  canvas.classList.add("panning");
  canvas.setPointerCapture(e.pointerId);

  const move = (ev: PointerEvent): void => {
    view.x = ev.clientX - startX;
    view.y = ev.clientY - startY;
    applyTransform();
  };
  const up = (): void => {
    canvas.classList.remove("panning");
    canvas.releasePointerCapture(e.pointerId);
    canvas.removeEventListener("pointermove", move);
    canvas.removeEventListener("pointerup", up);
    canvas.removeEventListener("pointercancel", up);
  };

  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
}

function applyTransform(): void {
  viewport?.setAttribute("transform", `translate(${view.x}, ${view.y}) scale(${view.scale})`);
}

/** Reset pan/zoom so the whole graph is visible. */
export function fit(): void {
  view.x = 0;
  view.y = 0;
  view.scale = 1;
  applyTransform();
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function renderLegend(roles: string[]): void {
  const host = byId("topology-legend");
  if (!host) return;

  const present = [...new Set(roles)];
  if (!present.length) {
    host.innerHTML = "";
    return;
  }

  host.innerHTML =
    present
      .map(
        (role) =>
          `<span class="legend-item" style="color:${ROLE_ACCENT[role as keyof typeof ROLE_ACCENT] ?? "var(--muted)"}">` +
          `<span class="legend-swatch"></span>${esc(role)}</span>`,
      )
      .join("") +
    '<span class="legend-item" style="color:var(--muted)"><span class="legend-swatch" style="border-style:dashed"></span>No configurado</span>';
}
