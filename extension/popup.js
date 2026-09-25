import * as engine from "./engine.js";
import { get, set } from "./store.js";
import { live, add, mutate } from "./list.js";
import { getSession } from "./sync.js";
import { requestSync } from "./syncClient.js";

const $ = s => document.querySelector(s);
const msg = t => { $("#msg").textContent = t || ""; };
const safe = u => (/^https?:/i.test(u || "") ? u : "#");
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  kids.flat().forEach(k => n.append(k));
  return n;
};
const link = (href, text) => el("a", { href: safe(href), target: "_blank", rel: "noopener", textContent: text });
const btn = (text, fn) => { const b = el("button", { textContent: text }); b.onclick = fn; return b; };
const explain = e => e instanceof TypeError
  ? "No se pudo conectar. ¿Diste permiso al dominio? Vuelve a guardar el provider en Opciones."
  : e.message;

let providers = [];
const prov = id => providers.find(p => p.id === id);

async function fillProviders() {
  providers = await get("providers", []);
  const cur = $("#prov").value;
  $("#prov").replaceChildren(...providers.map(p => el("option", { value: p.id, textContent: p.name || p.id })));
  if (cur) $("#prov").value = cur;
  if (!providers.length) msg("Añade un provider en Opciones (⚙).");
}

// Sincroniza si hay sesión; en modo silencioso no molesta con errores.
async function sync(quiet = true) {
  if (!(await getSession())) { $("#cloud").textContent = ""; if (!quiet) msg("Inicia sesión en Opciones para sincronizar."); return; }
  $("#cloud").textContent = "sync…";
  try {
    await requestSync();
    $("#cloud").textContent = "✓";
    await fillProviders();
    renderList();
    if (!quiet) msg("Sincronizado");
  } catch (e) {
    $("#cloud").textContent = "⚠";
    if (!quiet) msg("Error de sync: " + explain(e));
  }
}

async function init() {
  $("#opts").onclick = () => chrome.runtime.openOptionsPage();
  $("#sync").onclick = () => sync(false);
  chrome.storage.onChanged.addListener((c, a) => { if (a === "local" && c.news) renderNews(); });
  await fillProviders();
  renderNews();
  renderList();
  sync();
}

async function renderNews() {
  const news = await get("news", []);
  $("#newsBox").hidden = !news.length;
  $("#news").replaceChildren(...news.map(n => el("div", { className: "news" },
    link(n.link, n.title),
    btn("✕", async () => set("news", (await get("news", [])).filter(x => x.id !== n.id))))));
}

$("#go").onclick = async () => {
  const q = $("#q").value.trim();
  const p = prov($("#prov").value);
  if (!q || !p) return;
  msg("Buscando…");
  try {
    const res = await engine.search(p, q);
    msg(res.length ? "" : "Sin resultados");
    $("#results").replaceChildren(...res.map(r => el("div", { className: "card" },
      r.image ? el("img", { src: safe(r.image) }) : "",
      el("div", { className: "body" }, el("b", { textContent: r.title }),
        el("div", { className: "actions" },
          btn("＋ Guardar", async () => { await add(r); renderList(); msg("Guardada"); sync(); }),
          link(r.link, "Abrir"))))));
  } catch (e) { msg("Error: " + explain(e)); }
};
$("#q").addEventListener("keydown", e => { if (e.key === "Enter") $("#go").click(); });

async function checkNext(item, st) {
  const p = prov(item.provider);
  const n = (item.last || 0) + 1;
  st.textContent = "Comprobando…";
  try {
    const r = await engine.checkEpisode(p, item.slug, n);
    st.replaceChildren(r.exists ? link(r.url, `Ep ${n} disponible ▶`) : `Ep ${n}: aún no`);
  } catch (e) { st.textContent = "Error: " + explain(e); }
}

async function markSeen(item) {
  const it = await mutate(item.provider, item.slug, x => { x.last = (x.last || 0) + 1; });
  if (it) {
    const news = await get("news", []);
    await set("news", news.filter(n => !(n.provider === it.provider && n.slug === it.slug && n.episode <= it.last)));
  }
  renderList();
  sync();
}

async function renderList() {
  const list = live(await get("watchlist", []));
  $("#list").replaceChildren(...list.map(item => {
    const st = el("div", { className: "st" });
    const eps = el("div", { className: "eps" });
    return el("div", { className: "card" },
      item.image ? el("img", { src: safe(item.image) }) : "",
      el("div", { className: "body" },
        el("b", { textContent: item.title }),
        el("div", { textContent: "Visto hasta el episodio " + (item.last || 0) }),
        el("div", { className: "actions" },
          btn("Siguiente", () => checkNext(item, st)),
          btn("Episodios", async () => {
            eps.textContent = "Cargando…";
            try {
              const l = await engine.episodes(prov(item.provider), item.slug);
              eps.replaceChildren(...(l.length ? l.map(e => link(e.link, String(e.number))) : ["Sin episodios"]));
            } catch (e) { eps.textContent = "Error: " + explain(e); }
          }),
          btn("Visto +1", () => markSeen(item)),
          btn("Quitar", async () => { await mutate(item.provider, item.slug, x => { x.deleted = true; }); renderList(); sync(); })),
        st, eps));
  }));
}

$("#all").onclick = async () => {
  msg("Sincronizando y comprobando en segundo plano…");
  try { await chrome.runtime.sendMessage({ type: "checkNow" }); await fillProviders(); renderList(); msg("Listo"); }
  catch (e) { msg("Error: " + e.message); }
};

init();
