/* ============================================================
   config-editor.ts — YAML editor in the Config tab.

   CodeMirror is loaded lazily: it's the heaviest dependency in
   the bundle and most sessions never open this tab.
   ============================================================ */

// Type-only import: erased at compile time, so CodeMirror still lands in
// its own lazily-loaded chunk rather than the main bundle.
import type { EditorView } from "@codemirror/view";
import { fetchConfigText, saveConfigText, validateConfigText } from "./api.js";
import { byId, esc } from "./dom.js";
import { showToast } from "./toast.js";

let view: EditorView | null = null;
let loaded = "";
let validateTimer: number | null = null;
let booting: Promise<void> | null = null;

export function initConfigEditor(): void {
  byId("config-reload")?.addEventListener("click", () => void reload());
  byId("config-save")?.addEventListener("click", () => void save());
}

/** Called when the Config tab becomes visible. */
export function ensureConfigEditor(): void {
  if (view || booting) return;
  booting = boot().catch((err: unknown) => {
    setStatus("error", "No se pudo cargar el editor", err instanceof Error ? err.message : String(err));
  });
}

async function boot(): Promise<void> {
  const host = byId("config-editor");
  if (!host) return;

  const [{ EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter },
         { EditorState },
         { defaultKeymap, history, historyKeymap, indentWithTab },
         { StreamLanguage },
         { yaml },
         { oneDark }] = await Promise.all([
    import("@codemirror/view"),
    import("@codemirror/state"),
    import("@codemirror/commands"),
    import("@codemirror/language"),
    import("@codemirror/legacy-modes/mode/yaml"),
    import("@codemirror/theme-one-dark"),
  ]);

  loaded = await fetchConfigText();

  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: loaded,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        StreamLanguage.define(yaml),
        oneDark,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange();
        }),
      ],
    }),
  });

  setStatus("idle", "Sin cambios");
}

function currentText(): string {
  return view?.state.doc.toString() ?? "";
}

/** Point the device under the cursor at `path`: rewrite its `icon:`
 *  line if it has one, otherwise add the key below the cursor with
 *  the surrounding indentation. Returns false when the editor isn't
 *  open yet, so the caller can say so. */
export function applyIconPath(path: string): boolean {
  if (!view) return false;

  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const indent = /^\s*/.exec(line.text)?.[0] ?? "    ";
  const existing = /^(\s*)icon:\s.*$/.exec(line.text);

  const changes = existing
    ? { from: line.from, to: line.to, insert: `${existing[1]}icon: ${path}` }
    : { from: line.to, to: line.to, insert: `\n${indent}icon: ${path}` };

  view.dispatch({
    changes,
    selection: { anchor: changes.from + changes.insert.length },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

function onChange(): void {
  const dirty = currentText() !== loaded;
  const saveBtn = byId<HTMLButtonElement>("config-save");
  if (saveBtn) saveBtn.disabled = !dirty;

  if (!dirty) {
    setStatus("idle", "Sin cambios");
    return;
  }

  // Debounced so a validation round-trip doesn't fire on every keystroke.
  setStatus("connecting", "Validando…");
  if (validateTimer) window.clearTimeout(validateTimer);
  validateTimer = window.setTimeout(() => void validate(), 500);
}

async function validate(): Promise<void> {
  const result = await validateConfigText(currentText());
  if (result.ok) setStatus("connected", "Válido — sin guardar");
  else setStatus("error", result.error ?? "Inválido", (result.issues ?? []).join("\n"));
}

async function reload(): Promise<void> {
  try {
    const text = await fetchConfigText();
    loaded = text;
    if (view) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    }
    setStatus("idle", "Recargado desde disco");
    const saveBtn = byId<HTMLButtonElement>("config-save");
    if (saveBtn) saveBtn.disabled = true;
  } catch (err) {
    showToast(`No se pudo recargar: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

async function save(): Promise<void> {
  const text = currentText();
  const result = await saveConfigText(text);

  if (!result.ok) {
    setStatus("error", result.error ?? "No se pudo guardar", (result.issues ?? []).join("\n"));
    showToast("Guardado rechazado — revisá los errores", "error");
    return;
  }

  loaded = text;
  const saveBtn = byId<HTMLButtonElement>("config-save");
  if (saveBtn) saveBtn.disabled = true;
  setStatus("connected", "Guardado");
  showToast("config.yaml guardado", "success");
  // The backend broadcasts a config event; main.ts re-renders from that.
}

function setStatus(state: string, label: string, detail?: string): void {
  const el = byId("config-status");
  if (!el) return;
  el.className = `conn-status state-${state}`;
  el.innerHTML =
    '<span class="conn-dot"></span>' +
    `<span class="conn-text">${esc(label)}</span>` +
    (detail ? `<span class="conn-err">${esc(detail)}</span>` : "");
}
