import { $ } from "./dom.js";
import { get } from "../store.js";

const TMDB_ORIGIN = "https://api.themoviedb.org/*";

function allOrigins(players) {
  const set = new Set([TMDB_ORIGIN]);
  for (const tracks of Object.values(players || {})) {
    for (const t of ["sub", "dub"]) {
      for (const entry of (tracks[t] || [])) {
        try { const u = new URL(entry.rule.base_url); set.add(`${u.protocol}//${u.hostname}/*`); }
        catch { /* rule mal formada: se ignora aquí, config.js ya valida al guardar */ }
      }
    }
  }
  return [...set];
}

export function ensurePermissions() {
  if (typeof chrome === "undefined" || !chrome.permissions) return Promise.resolve();
  return get("players", {}).then(players => {
    const origins = allOrigins(players);
    if (!origins.length) return Promise.resolve();
    return chrome.permissions.request({ origins }).catch(e => {
      $("#msg").textContent = "No se pudo pedir el permiso: " + e.message;
    });
  });
}

export async function updatePermBanner() {
  const banner = $("#permBanner");
  if (!banner || typeof chrome === "undefined" || !chrome.permissions) return;
  const origins = allOrigins(await get("players", {}));
  const ok = !origins.length || await chrome.permissions.contains({ origins });
  banner.hidden = ok;
}

const grantBtn = $("#grantPerms");
if (grantBtn) grantBtn.onclick = async () => { await ensurePermissions(); updatePermBanner(); };
