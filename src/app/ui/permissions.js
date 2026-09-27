import { $ } from "./dom.js";
import { prov } from "./state.js";

// Copia de la lista tal y como la acaba de pintar renderMain(). Existe para que
// ensurePermissions() pueda leerla SIN await: chrome.permissions.request() solo funciona si se
// llama dentro de la pila de llamadas del clic, y cualquier await previo rompe ese gesto.
export let watchlistCache = [];
export function setWatchlistCache(w) { watchlistCache = w; }

function domainOrigin(p) { const u = new URL(p.base_url); return `${u.protocol}//${u.hostname}/*`; }

function watchlistOrigins(extraIds) {
  const ids = new Set(watchlistCache.map(w => w.provider));
  (Array.isArray(extraIds) ? extraIds : extraIds ? [extraIds] : []).forEach(id => ids.add(id));
  return [...new Set([...ids].map(id => prov(id)).filter(Boolean).map(domainOrigin))];
}

// Pide permiso de Chrome para los dominios de los providers en uso, en el mismo gesto de clic
// que ya está en curso. OJO: nada de await antes de chrome.permissions.request() — por eso la
// función no es async y usa watchlistCache. La PWA no tiene chrome.permissions (usa un proxy
// CORS): ahí es un no-op inmediato.
export function ensurePermissions(extraIds) {
  if (typeof chrome === "undefined" || !chrome.permissions) return Promise.resolve();
  const origins = watchlistOrigins(extraIds);
  if (!origins.length) return Promise.resolve();
  return chrome.permissions.request({ origins }).catch(e => {
    $("#msg").textContent = "No se pudo pedir el permiso: " + e.message;
  });
}

// El aviso de permisos es el único sitio donde un usuario normal puede concederlos de golpe.
// La PWA no tiene banner de permisos (#permBanner no existe en su HTML) — no-op ahí.
export async function updatePermBanner() {
  const banner = $("#permBanner");
  if (!banner || typeof chrome === "undefined" || !chrome.permissions) return;
  const origins = watchlistOrigins();
  const ok = !origins.length || await chrome.permissions.contains({ origins });
  banner.hidden = ok;
}

const grantBtn = $("#grantPerms"); // no existe en la PWA
if (grantBtn) grantBtn.onclick = async () => { await ensurePermissions(); updatePermBanner(); };
