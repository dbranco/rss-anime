// Mantiene la pantalla encendida mientras el iframe de reproducción está en el DOM. El sitio
// original lo hace porque su <video> propio dispara el Wake Lock al reproducir; aquí no hay
// acceso a eso (el player va embebido en un iframe cross-origin, ej. animeav1 — no se puede
// engancharse a sus eventos play/pause), así que el wake lock se pide "a ciegas" en cuanto se
// monta el iframe y se suelta en cuanto se desmonta.
let sentinel = null;
let active = false; // true mientras *debería* haber un lock, aunque el navegador lo suelte solo
                     // (pestaña en segundo plano) — sirve para volver a pedirlo al recuperar foco.

async function acquire() {
  if (!("wakeLock" in navigator)) return;
  try {
    sentinel = await navigator.wakeLock.request("screen");
    sentinel.addEventListener("release", () => { sentinel = null; });
  } catch { /* permiso denegado, sin pestaña visible, etc. — sin esto no hay más que tapping manual */ }
}

// Exportadas para el botón de pantalla-encendida/apagable de player.js: deja al usuario soltar el
// lock a mano (ej. si pausa el video dentro del iframe, algo que no podemos detectar nosotros) y
// volver a pedirlo sin tener que cerrar y reabrir el panel.
export function requestWakeLock() {
  active = true;
  if (!sentinel) acquire();
}

export function releaseWakeLock() {
  active = false;
  const s = sentinel;
  sentinel = null;
  s?.release().catch(() => {});
}

document.addEventListener("visibilitychange", () => {
  if (active && !sentinel && document.visibilityState === "visible") acquire();
});

// Pide el wake lock y lo suelta solo él solo en cuanto `el` deja de estar en el documento (el
// usuario cierra el panel, cambia de servidor/pista, o abre otro episodio — todos esos casos
// desmontan el iframe vía replaceChildren en algún padre, nunca un evento explícito de "cerrar").
export function holdWakeLockWhileConnected(el) {
  releaseWakeLock(); // solo un iframe reproduce a la vez en esta app: suelta cualquier lock anterior
  requestWakeLock();
  // Sin MutationObserver (entorno de test con jsdom pelado, sin este global) no hay forma de
  // detectar el desmontaje — el lock se queda activo hasta que otro holdWakeLockWhileConnected()
  // lo reemplace, en vez de soltarse solo al cerrar el panel. Degradación aceptable: en un
  // navegador real MutationObserver siempre existe.
  if (typeof MutationObserver === "undefined") return;
  const obs = new MutationObserver(() => {
    if (!el.isConnected) { obs.disconnect(); releaseWakeLock(); }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}
