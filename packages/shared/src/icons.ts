/* ============================================================
   icons.ts — the preset icon set shipped with the dashboard.

   The SVGs live in `packages/frontend/public/assets/icons/` and
   are served from `/assets/icons/<id>.svg`, so a device picks
   one by writing that path into `icon:` in config.yaml.

   `icon:` still accepts any other path, so a custom image drops
   into `public/assets/` and works exactly as before — this
   catalog only exists so the Config tab can offer a gallery
   instead of asking you to remember file names.
   ============================================================ */

export type IconCategory =
  | "Red"
  | "Cómputo"
  | "Almacenamiento"
  | "Energía y consola"
  | "Periféricos e IoT"
  | "Clientes";

export interface PresetIcon {
  /** Stable id; also the SVG's file name. */
  id: string;
  /** Shown under the tile in the picker and searched by the palette. */
  label: string;
  category: IconCategory;
  /** Words that should also match this icon when filtering. */
  keywords: string[];
}

export const ICON_BASE = "assets/icons";

export const PRESET_ICONS: readonly PresetIcon[] = [
  // ─── Red ───
  { id: "router", label: "Router", category: "Red", keywords: ["gateway", "wifi", "openwrt", "ubiquiti"] },
  { id: "access-point", label: "Access point", category: "Red", keywords: ["ap", "wifi", "wireless", "unifi"] },
  { id: "switch", label: "Switch", category: "Red", keywords: ["ethernet", "puertos", "lan"] },
  { id: "modem", label: "Módem", category: "Red", keywords: ["isp", "ont", "fibra", "cable"] },
  { id: "firewall", label: "Firewall", category: "Red", keywords: ["opnsense", "pfsense", "nftables", "seguridad"] },
  { id: "vpn-gateway", label: "VPN", category: "Red", keywords: ["wireguard", "tailscale", "túnel", "gateway"] },
  { id: "antenna", label: "Antena / repetidor", category: "Red", keywords: ["mesh", "repeater", "señal", "cpe"] },

  // ─── Cómputo ───
  { id: "server-rack", label: "Rack", category: "Cómputo", keywords: ["servidor", "datacenter", "1u", "gabinete"] },
  { id: "server-tower", label: "Servidor torre", category: "Cómputo", keywords: ["tower", "host", "hipervisor", "proxmox"] },
  { id: "desktop", label: "PC de escritorio", category: "Cómputo", keywords: ["workstation", "monitor", "torre"] },
  { id: "laptop", label: "Laptop", category: "Cómputo", keywords: ["notebook", "portátil"] },
  { id: "mini-pc", label: "Mini PC", category: "Cómputo", keywords: ["nuc", "thin client", "sff"] },
  { id: "sbc", label: "SBC", category: "Cómputo", keywords: ["raspberry", "rock pi", "placa", "arm", "gpio"] },
  { id: "microcontroller", label: "Microcontrolador", category: "Cómputo", keywords: ["esp32", "arduino", "mcu", "iot"] },

  // ─── Almacenamiento ───
  { id: "nas", label: "NAS", category: "Almacenamiento", keywords: ["synology", "truenas", "bahías", "raid"] },
  { id: "hdd", label: "Disco duro", category: "Almacenamiento", keywords: ["hdd", "sata", "plato", "backup"] },
  { id: "ssd", label: "SSD", category: "Almacenamiento", keywords: ["nvme", "m.2", "flash"] },
  { id: "usb-drive", label: "USB", category: "Almacenamiento", keywords: ["pendrive", "memoria", "flash"] },

  // ─── Energía y consola ───
  { id: "ups", label: "UPS", category: "Energía y consola", keywords: ["batería", "nut", "respaldo", "apc"] },
  { id: "power-plug", label: "Enchufe inteligente", category: "Energía y consola", keywords: ["pdu", "smart plug", "tasmota", "regleta"] },
  { id: "kvm", label: "KVM", category: "Energía y consola", keywords: ["kvm over ip", "consola", "ipmi", "remoto"] },
  { id: "gpu", label: "GPU", category: "Energía y consola", keywords: ["tarjeta gráfica", "cuda", "llm", "vram"] },

  // ─── Periféricos e IoT ───
  { id: "printer", label: "Impresora", category: "Periféricos e IoT", keywords: ["cups", "escáner", "papel"] },
  { id: "printer-3d", label: "Impresora 3D", category: "Periféricos e IoT", keywords: ["klipper", "octoprint", "ender"] },
  { id: "camera", label: "Cámara IP", category: "Periféricos e IoT", keywords: ["cctv", "frigate", "vigilancia", "rtsp"] },
  { id: "sensor", label: "Sensor", category: "Periféricos e IoT", keywords: ["temperatura", "zigbee", "home assistant", "iot"] },

  // ─── Clientes ───
  { id: "phone", label: "Teléfono", category: "Clientes", keywords: ["móvil", "smartphone", "android"] },
  { id: "tablet", label: "Tablet", category: "Clientes", keywords: ["ipad", "pantalla"] },
  { id: "tv", label: "TV", category: "Clientes", keywords: ["smart tv", "chromecast", "media", "kodi"] },
  { id: "unknown", label: "Desconocido", category: "Clientes", keywords: ["genérico", "otro", "sin identificar"] },
] as const;

/** Path to write into `icon:` for a preset id. */
export function presetIconPath(id: string): string {
  return `${ICON_BASE}/${id}.svg`;
}

/** The preset an `icon:` value refers to, if it refers to one. */
export function presetIconFor(icon: string | undefined): PresetIcon | undefined {
  if (!icon) return undefined;
  const id = icon.replace(/^\/?/, "").replace(`${ICON_BASE}/`, "").replace(/\.svg$/, "");
  return PRESET_ICONS.find((i) => i.id === id);
}
