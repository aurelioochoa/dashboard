/* ============================================================
   api.ts — backend client: REST helpers + the SSE subscription.
   ============================================================ */

import {
  ConfigSchema, HostGraphSchema,
  type Config, type DeviceMetrics, type HealthResult,
  type MetricSample, type PresetIcon, type TopologySnapshot,
} from "@homelab/shared";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchConfig(): Promise<Config> {
  const parsed = ConfigSchema.safeParse(await getJson<unknown>("/api/config"));
  if (!parsed.success) {
    throw new Error(`Config failed validation: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  }
  return parsed.data;
}

export function fetchConfigText(): Promise<string> {
  return fetch("/api/config/raw").then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  });
}

export interface SaveResult {
  ok: boolean;
  error?: string;
  issues?: string[];
}

async function postYaml(url: string, method: "PUT" | "POST", yamlText: string): Promise<SaveResult> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yaml: yamlText }),
  });
  const body = (await res.json().catch(() => ({}))) as SaveResult;
  if (res.ok) return { ok: true };
  return { ok: false, error: body.error ?? `HTTP ${res.status}`, issues: body.issues };
}

export const saveConfigText = (yamlText: string): Promise<SaveResult> =>
  postYaml("/api/config", "PUT", yamlText);

export const validateConfigText = (yamlText: string): Promise<SaveResult> =>
  postYaml("/api/config/validate", "POST", yamlText);

/* ─── Icons ─── */

export interface UserIcon {
  name: string;
  path: string;
  bytes: number;
  modified: number;
}

export interface IconCatalog {
  presets: (PresetIcon & { path: string })[];
  user: UserIcon[];
  maxBytes: number;
}

export const fetchIcons = (): Promise<IconCatalog> => getJson("/api/icons");

/** Upload one icon. The file is sent as base64 in a JSON body — small
 *  payloads, and it keeps a multipart parser out of the backend. */
export async function uploadIcon(file: File): Promise<UserIcon> {
  const data = await fileToBase64(file);
  const res = await fetch("/api/icons", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, mime: file.type, data }),
  });
  const body = (await res.json().catch(() => ({}))) as UserIcon & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export async function deleteIcon(name: string): Promise<void> {
  const res = await fetch(`/api/icons/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.onload = () => {
      const result = String(reader.result);
      // readAsDataURL gives "data:<mime>;base64,<payload>"; send the payload.
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

export const fetchMetrics = (): Promise<DeviceMetrics[]> => getJson("/api/metrics");

export const fetchHealth = (): Promise<HealthResult[]> => getJson("/api/health");

export const fetchHistory = (device: string, windowSec = 3600): Promise<{ device: string; samples: MetricSample[] }> =>
  getJson(`/api/metrics/history?device=${encodeURIComponent(device)}&window=${windowSec}`);

export async function fetchTopology(): Promise<TopologySnapshot> {
  const raw = await getJson<TopologySnapshot>("/api/topology");
  if (!raw.graph) return raw;
  const parsed = HostGraphSchema.safeParse(raw.graph);
  return parsed.success ? { ...raw, graph: parsed.data } : { ...raw, graph: null, error: "Invalid graph" };
}

export async function requestScan(): Promise<boolean> {
  const res = await fetch("/api/topology/scan", { method: "POST" });
  return res.ok;
}

/* ─── SSE ─── */

export type StreamState = "connecting" | "connected" | "error";

export interface StreamHandlers {
  metrics?: (m: DeviceMetrics) => void;
  health?: (h: HealthResult[]) => void;
  topology?: (t: TopologySnapshot) => void;
  config?: (c: { reason: string }) => void;
  icons?: (i: { reason: string }) => void;
  state?: (s: StreamState) => void;
}

/**
 * Subscribe to the backend event stream.
 *
 * EventSource handles reconnection itself, so this only reports state
 * transitions; no manual retry loop is needed.
 */
export function openStream(handlers: StreamHandlers): () => void {
  const source = new EventSource("/api/stream");
  handlers.state?.("connecting");

  source.addEventListener("open", () => handlers.state?.("connected"));
  source.addEventListener("error", () => {
    // readyState CONNECTING here means EventSource is already retrying.
    handlers.state?.(source.readyState === EventSource.CLOSED ? "error" : "connecting");
  });

  const on = <T>(name: string, fn: ((value: T) => void) | undefined): void => {
    if (!fn) return;
    source.addEventListener(name, (event) => {
      try {
        fn(JSON.parse((event as MessageEvent<string>).data) as T);
      } catch {
        // A malformed frame must not tear down the subscription.
      }
    });
  };

  on("metrics", handlers.metrics);
  on("health", handlers.health);
  on("topology", handlers.topology);
  on("config", handlers.config);
  on("icons", handlers.icons);

  return () => source.close();
}
