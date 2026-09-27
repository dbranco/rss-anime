// Pide al service worker que sincronice, en vez de llamar a syncNow() desde este contexto.
// popup y opciones son contextos efímeros (el popup se destruye al perder el foco, cancelando
// cualquier fetch en curso) e independientes entre sí; el service worker centraliza y deduplica.
export function requestSync() {
  return chrome.runtime.sendMessage({ type: "sync" }).then(r => {
    if (!r?.ok) throw new Error(r?.error || "Sync fallida");
  });
}
