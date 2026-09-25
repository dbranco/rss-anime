import "./proxy.js"; // registra globalThis.__seriesTrackerFetch antes de usar engine.js
import * as engine from "../extension/engine.js";
import { get, set } from "../extension/store.js";
import { live, add, mutate } from "../extension/list.js";
import { signIn, signUp, signOut, getSession, syncNow } from "../extension/sync.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const $ = s => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  kids.flat().forEach(k => n.append(k));
  return n;
};
const safe = u => (/^https?:/i.test(u || "") ? u : "#");
const link = (href, text) => el("a", { href: safe(href), target: "_blank", rel: "noopener", textContent: text });
const btn = (text, fn, cls) => { const b = el("button", { textContent: text, className: cls || "small" }); b.onclick = fn; return b; };
const explain = e => e instanceof TypeError ? "No se pudo conectar." : e.message;

let providers = [];
const prov = id => providers.find(p => p.id === id);

async function fillProviders() {
  providers = await get("providers", []);
  const cur = $("#prov").value;
  $("#prov").replaceChildren(...providers.map(p => el("option", { value: p.id, textContent: p.name || p.id })));
  if (cur) $("#prov").value = cur;
}

async function renderList() {
  const list = live(await get("watchlist", []));
  $("#list").replaceChildren(...list.map(item => {
    const st = el("div", { className: "msg" });
    const eps = el("div", { className: "eps" });
    return el("div", { className: "card" },
      item.image ? el("img", { src: safe(item.image) }) : "",
      el("div", { className: "body" },
        el("b", { textContent: item.title }),
        el("div", { className: "hint", textContent: "Visto hasta el episodio " + (item.last || 0) }),
        el("div", { className: "actions" },
          btn("Siguiente", async () => {
            const p = prov(item.provider);
            const n = (item.last || 0) + 1;
            st.textContent = "Comprobando…";
            try {
              const r = await engine.checkEpisode(p, item.slug, n);
              st.replaceChildren(r.exists ? link(r.url, `Ep ${n} disponible ▶`) : `Ep ${n}: aún no`);
            } catch (e) { st.textContent = "Error: " + explain(e); }
          }),
          btn("Episodios", async () => {
            eps.textContent = "Cargando…";
            try {
              const l = await engine.episodes(prov(item.provider), item.slug);
              eps.replaceChildren(...(l.length ? l.map(e => link(e.link, String(e.number))) : ["Sin episodios"]));
            } catch (e) { eps.textContent = "Error: " + explain(e); }
          }),
          btn("Visto +1", async () => {
            const it = await mutate(item.provider, item.slug, x => { x.last = (x.last || 0) + 1; });
            if (it) {
              const news = await get("news", []);
              await set("news", news.filter(n => !(n.provider === it.provider && n.slug === it.slug && n.episode <= it.last)));
            }
            renderList(); requestSync();
          }),
          btn("Quitar", async () => { await mutate(item.provider, item.slug, x => { x.deleted = true; }); renderList(); requestSync(); })),
        st, eps));
  }));
}

async function renderFeed() {
  const cfg = await get("supabase");
  const token = await get("feed_token");
  $("#feedUrl").value = token && cfg?.url ? `${cfg.url.replace(/\/+$/, "")}/storage/v1/object/public/feeds/${token}.xml` : "(aún no generado por el cron)";
}

let syncing = null;
function requestSync() {
  // Deduplica: si ya hay una sync en curso, todos comparten la misma en vez de solaparse.
  if (!syncing) syncing = syncNow().finally(() => { syncing = null; });
  return syncing;
}

async function sync(quiet = true) {
  $("#cloud").textContent = "sync…";
  try {
    await requestSync();
    $("#cloud").textContent = "✓";
    await fillProviders(); await renderList(); await renderFeed();
  } catch (e) {
    $("#cloud").textContent = "⚠";
    if (!quiet) $("#authMsg").textContent = "Error de sync: " + explain(e);
  }
}

async function showMain() {
  const s = await getSession();
  $("#authView").hidden = true;
  $("#mainView").hidden = false;
  $("#who").textContent = s.user.email;
  await fillProviders(); await renderList(); await renderFeed();
  sync();
}

async function showAuth() {
  $("#mainView").hidden = true;
  $("#authView").hidden = false;
}

async function authFlow(fn) {
  const email = $("#email").value.trim(), password = $("#password").value;
  if (!email || !password) { $("#authMsg").textContent = "Escribe email y contraseña"; return; }
  $("#authMsg").textContent = "";
  try {
    const note = await fn(email, password);
    if (note) { $("#authMsg").textContent = note; return; }
    await showMain();
  } catch (e) { $("#authMsg").textContent = "Error: " + e.message; }
}

$("#login").onclick = () => authFlow(async (email, password) => { await signIn(email, password); });
$("#signup").onclick = () => authFlow(async (email, password) => {
  const r = await signUp(email, password);
  if (!r.confirmed) return "Cuenta creada. Confirma el email y vuelve a iniciar sesión.";
});
$("#logout").onclick = async () => { await signOut(); await showAuth(); };

$("#go").onclick = async () => {
  const q = $("#q").value.trim();
  const p = prov($("#prov").value);
  $("#searchMsg").textContent = "";
  if (!q || !p) { $("#searchMsg").textContent = "Elige un provider y escribe algo."; return; }
  $("#searchMsg").textContent = "Buscando…";
  try {
    const res = await engine.search(p, q);
    $("#searchMsg").textContent = res.length ? "" : "Sin resultados";
    $("#results").replaceChildren(...res.map(r => el("div", { className: "card" },
      r.image ? el("img", { src: safe(r.image) }) : "",
      el("div", { className: "body" }, el("b", { textContent: r.title }),
        el("div", { className: "actions" },
          btn("＋ Guardar", async () => { await add(r); await renderList(); requestSync(); $("#searchMsg").textContent = "Guardada"; }),
          link(r.link, "Abrir"))))));
  } catch (e) { $("#searchMsg").textContent = "Error: " + explain(e); }
};
$("#q").addEventListener("keydown", e => { if (e.key === "Enter") $("#go").click(); });

$("#all").onclick = async () => { $("#searchMsg").textContent = "Comprobando…"; await sync(false); $("#searchMsg").textContent = "Listo"; };
$("#copyFeed").onclick = async () => {
  try { await navigator.clipboard.writeText($("#feedUrl").value); $("#copyFeed").textContent = "✓"; setTimeout(() => { $("#copyFeed").textContent = "Copiar"; }, 1500); }
  catch { $("#feedUrl").select(); }
};

(async function init() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  await set("supabase", { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
  const s = await getSession();
  if (s) await showMain(); else await showAuth();
})();
