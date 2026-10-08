/* ============================================================
   Server-side reachability probe results.
   ============================================================ */

export type HealthState = "up" | "down" | "unknown";

export interface HealthResult {
  /** Stable id: "<device>|<kind>|<target>" — see healthId(). */
  id: string;
  device: string;
  kind: "http" | "tcp";
  /** URL for http probes, "host:port" for tcp probes. */
  target: string;
  /** Human label — link label, service name, or port service. */
  label: string;
  state: HealthState;
  /** Round-trip time in milliseconds, when the probe succeeded. */
  responseMs?: number;
  /** HTTP status code, for http probes. */
  status?: number;
  error?: string;
  checkedAt: number;
}

export function healthId(device: string, kind: "http" | "tcp", target: string): string {
  return `${device}|${kind}|${target}`;
}
