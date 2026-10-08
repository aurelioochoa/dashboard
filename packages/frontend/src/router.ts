/* ============================================================
   router.ts — hash router.

   Routes:
     #/dashboard                 (default)
     #/topology
     #/services
     #/config
     #/dashboard/device/<name>   focus a specific card

   Hash-based rather than History API so the dashboard works
   when served from any path without server rewrite rules.
   ============================================================ */

export const TAB_IDS = ["dashboard", "topology", "services", "config"] as const;
export type TabId = (typeof TAB_IDS)[number];

export interface Route {
  tab: TabId;
  /** Device name from #/dashboard/device/<name>, if present. */
  device?: string;
}

type Listener = (route: Route) => void;

const listeners = new Set<Listener>();
let current: Route = parseHash(window.location.hash);

function isTabId(value: string): value is TabId {
  return (TAB_IDS as readonly string[]).includes(value);
}

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const tab = path[0] && isTabId(path[0]) ? path[0] : "dashboard";
  if (path[1] === "device" && path[2]) {
    return { tab, device: decodeURIComponent(path[2]) };
  }
  return { tab };
}

export function formatRoute(route: Route): string {
  const base = `#/${route.tab}`;
  return route.device ? `${base}/device/${encodeURIComponent(route.device)}` : base;
}

export function currentRoute(): Route {
  return current;
}

export function navigate(route: Route, replace = false): void {
  const hash = formatRoute(route);
  if (hash === window.location.hash) return;
  if (replace) {
    window.history.replaceState(null, "", hash);
    handleHashChange();
  } else {
    window.location.hash = hash;
  }
}

export function onRouteChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function handleHashChange(): void {
  const next = parseHash(window.location.hash);
  if (next.tab === current.tab && next.device === current.device) return;
  current = next;
  for (const fn of listeners) fn(current);
}

export function initRouter(): void {
  window.addEventListener("hashchange", handleHashChange);
  // Normalise a bare or absent hash so the URL always reflects the view.
  if (!window.location.hash) {
    window.history.replaceState(null, "", formatRoute(current));
  }
}
