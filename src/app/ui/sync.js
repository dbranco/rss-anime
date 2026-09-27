import { syncNow } from "../sync.js";

let syncing = null;

// La extensión delega al service worker: el popup es un contexto efímero que se destruye al
// perder el foco, cancelando cualquier fetch en curso, así que centraliza y deduplica ahí. La
// PWA no tiene ese contexto persistente — sincroniza aquí mismo con dedup en memoria.
export function requestSync() {
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    return chrome.runtime.sendMessage({ type: "sync" }).then(r => {
      if (!r?.ok) throw new Error(r?.error || "Sync fallida");
    });
  }
  if (!syncing) syncing = syncNow().finally(() => { syncing = null; });
  return syncing;
}
