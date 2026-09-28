import { get, set } from "../app/store.js";
import { live } from "../app/list.js";
import { syncNow, getSession } from "../app/sync.js";
import * as tmdb from "../app/tmdb.js";

const ALARM = "check";
const NEWS_CAP = 200;
let running = false;
let syncPromise = null;

// Único punto de entrada a syncNow(): popup, opciones y el alarm pueden pedir sync a la vez
// (popup y opciones son contextos efímeros e independientes entre sí y del service worker).
// Si ya hay una sincronización en curso, todos los que la pidan comparten la misma promesa en
// lugar de disparar fetches concurrentes que pueden pisarse el refresh_token (Supabase lo rota).
function requestSync() {
  if (!syncPromise) syncPromise = syncNow().finally(() => { syncPromise = null; });
  return syncPromise;
}

async function schedule() {
  const mins = Math.max(10, await get("interval", 60));
  await chrome.alarms.clear(ALARM);
  chrome.alarms.create(ALARM, { periodInMinutes: mins, delayInMinutes: 1 });
}

async function updateBadge(news) {
  await chrome.action.setBadgeBackgroundColor({ color: "#d33" });
  await chrome.action.setBadgeText({ text: news.length ? String(news.length) : "" });
}

// Compara `last` contra los episodios de TMDB con `air_date` ya pasada. Cubre tanto los ítems
// sueltos como los que solo existen para trackear un paso de grupo (visible:false) — los grupos
// ya derivan su progreso de `last` (sin cambios), así que no hace falta un checkGroups() aparte.
async function checkAll() {
  const list = live(await get("watchlist", []));
  const lang = await get("lang_pref", "es-ES");
  const news = await get("news", []);
  const notified = await get("notified", []);
  const today = new Date().toISOString().slice(0, 10);
  for (const it of list) {
    if (it.media_type !== "tv") continue; // las películas no tienen calendario de episodios
    let episodes;
    try { episodes = await tmdb.getSeasonEpisodes(it.tmdb_id, 1, lang); }
    catch (e) { console.warn(`Fallo en ${it.title}:`, e); continue; }
    const last = it.last || 0;
    const next = episodes.find(e => e.number === last + 1);
    if (next && next.air_date && next.air_date <= today) {
      const id = `${it.tmdb_id}-e${next.number}`;
      if (!notified.includes(id)) {
        notified.push(id);
        news.unshift({ id, tmdb_id: it.tmdb_id, episode: next.number,
                       title: `${it.title} — episodio ${next.number}`, link: null });
        chrome.notifications.create(id, {
          type: "basic", iconUrl: "extension/icons/icon128.png",
          title: "Nuevo episodio", message: `${it.title} — episodio ${next.number}`
        });
      }
    }
  }
  await set("news", news.slice(0, NEWS_CAP));
  await set("notified", notified.slice(-500));
}

// Sincroniza (si hay sesión) y luego comprueba episodios.
async function run() {
  if (running) return;
  running = true;
  try {
    try { if (await getSession()) await requestSync(); } catch (e) { console.warn("Sync fallida:", e); }
    await checkAll();
  } finally { running = false; }
}

chrome.runtime.onInstalled.addListener(async () => {
  if (!(await get("providers"))) {
    const r = await fetch(chrome.runtime.getURL("extension/providers.example.json"));
    await set("providers", await r.json());
  }
  schedule();
});
chrome.runtime.onStartup.addListener(async () => { schedule(); updateBadge(await get("news", [])); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === ALARM) run(); });
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== "local") return;
  if (c.news) updateBadge(c.news.newValue || []);
  if (c.interval) schedule();
});
chrome.notifications.onClicked.addListener(async id => {
  const n = (await get("news", [])).find(x => x.id === id);
  // Ya no siempre hay una URL directa al episodio (TMDB solo confirma que "ya emitió"): sin
  // link no hay adónde navegar, así que simplemente no se abre pestaña (Plan A).
  if (n?.link) chrome.tabs.create({ url: n.link });
  chrome.notifications.clear(id);
});
chrome.runtime.onMessage.addListener((m, _s, send) => {
  if (m.type === "checkNow") { run().then(() => send(true)); return true; }
  if (m.type === "sync") {
    requestSync().then(() => send({ ok: true })).catch(e => send({ ok: false, error: String(e.message || e) }));
    return true;
  }
});
