import { get, set } from "./store.js";
import { live } from "./list.js";
import { live as liveGroups, currentStep } from "./groups.js";
import { syncNow, getSession } from "./sync.js";

const ALARM = "check";
const MAX_AHEAD = 5;
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

async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (!ctx.length) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["DOM_PARSER"],
      justification: "Parsear el HTML de las webs configuradas"
    });
  }
}

async function callOffscreen(op, ...args) {
  await ensureOffscreen();
  let r;
  for (let i = 0; i < 4; i++) {
    try {
      r = await chrome.runtime.sendMessage({ target: "offscreen", op, args });
      break;
    } catch (e) { // el documento aún no registró su listener
      if (i === 3) throw e;
      await new Promise(res => setTimeout(res, 300));
    }
  }
  if (!r?.ok) throw new Error(r?.error || "sin respuesta");
  return r.data;
}

async function checkAll() {
  const list = live(await get("watchlist", []));
  const providers = await get("providers", []);
  const news = await get("news", []);
  const notified = await get("notified", []);
  for (const it of list) {
    const p = providers.find(x => x.id === it.provider);
    if (!p) continue;
    const last = it.last || 0;
    for (let n = last + 1; n <= last + MAX_AHEAD; n++) {
      let r;
      try { r = await callOffscreen("checkEpisode", p, it.slug, n); }
      catch (e) { console.warn(`Fallo en ${it.title} ep ${n}:`, e); break; }
      if (!r.exists) break;
      const id = `${it.provider}-${it.slug}-e${n}`;
      if (notified.includes(id)) continue;
      notified.push(id);
      news.unshift({ id, provider: it.provider, slug: it.slug, episode: n,
                     title: `${it.title} — episodio ${n}`, link: r.url });
      chrome.notifications.create(id, {
        type: "basic", iconUrl: "icons/icon128.png",
        title: "Nuevo episodio", message: `${it.title} — episodio ${n}`
      });
    }
  }
  await set("news", news.slice(0, NEWS_CAP));
  await set("notified", notified.slice(-500));
}

async function checkGroups() {
  const groups = liveGroups(await get("groups", []));
  if (!groups.length) return;
  const watchlist = live(await get("watchlist", []));
  const providers = await get("providers", []);
  const news = await get("news", []);
  const notified = await get("notified", []);
  for (const g of groups) {
    const cur = currentStep(g, watchlist);
    if (!cur?.next) continue;
    if (!cur.item) continue; // paso colgando: el ítem se borró de la lista (la UI ya lo avisa)
    const p = providers.find(x => x.id === cur.step.provider);
    if (!p) continue;
    let r;
    try { r = await callOffscreen("checkEpisode", p, cur.step.slug, cur.next); }
    catch (e) { console.warn(`Fallo en grupo ${g.name}:`, e); continue; }
    if (!r.exists) continue;
    const id = `group-${g.id}-e${cur.next}`;
    if (notified.includes(id)) continue;
    notified.push(id);
    const title = cur.item?.title || cur.step.slug;
    news.unshift({ id, provider: cur.step.provider, slug: cur.step.slug, episode: cur.next,
                   title: `${g.name}: ${title} — episodio ${cur.next}`, link: r.url });
    chrome.notifications.create(id, {
      type: "basic", iconUrl: "icons/icon128.png",
      title: "Nuevo episodio (grupo)", message: `${g.name}: ${title} — episodio ${cur.next}`
    });
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
    await checkGroups();
  } finally { running = false; }
}

chrome.runtime.onInstalled.addListener(async () => {
  if (!(await get("providers"))) {
    const r = await fetch(chrome.runtime.getURL("providers.example.json"));
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
  if (n) chrome.tabs.create({ url: n.link });
  chrome.notifications.clear(id);
});
chrome.runtime.onMessage.addListener((m, _s, send) => {
  if (m.type === "checkNow") { run().then(() => send(true)); return true; }
  if (m.type === "sync") {
    requestSync().then(() => send({ ok: true })).catch(e => send({ ok: false, error: String(e.message || e) }));
    return true;
  }
});
