/* ============================================================
   toast.ts — transient bottom-right notifications.
   Replaces the old one-off fixed-position "copy-tooltip".
   ============================================================ */

export type ToastKind = "info" | "success" | "error";

const STACK_ID = "toast-stack";
const DEFAULT_MS = 2200;

function stack(): HTMLElement {
  let el = document.getElementById(STACK_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = STACK_ID;
    el.className = "toast-stack";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  return el;
}

export function showToast(message: string, kind: ToastKind = "info", ms = DEFAULT_MS): void {
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  stack().appendChild(el);

  window.setTimeout(() => {
    el.classList.add("toast-leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
    // Belt and braces: drop it even if the animation never fires.
    window.setTimeout(() => el.remove(), 400);
  }, ms);
}
