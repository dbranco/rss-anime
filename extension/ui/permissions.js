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
// función no es async y usa watchlistCache. Si ya estaba concedido no muestra nada. extraIds
// puede ser un id suelto o un array (ej. todos los providers de la búsqueda multi-idioma).
export function ensurePermissions(extraIds) {
  const origins = watchlistOrigins(extraIds);
  if (!origins.length) return Promise.resolve();
  return chrome.permissions.request({ origins }).catch(e => {
    $("#msg").textContent = "No se pudo pedir el permiso: " + e.message;
  });
}

// El aviso de permisos es el único sitio donde un usuario normal puede concederlos de golpe:
// sin ellos, el chequeo periódico por chrome.alarms (que nunca tiene gesto de usuario) no
// puede hacer fetch a los dominios de los providers. contains() no necesita gesto.
export async function updatePermBanner() {
  const origins = watchlistOrigins();
  const ok = !origins.length || await chrome.permissions.contains({ origins });
  $("#permBanner").hidden = ok;
}

$("#grantPerms").onclick = async () => {
  await ensurePermissions();
  updatePermBanner();
};
