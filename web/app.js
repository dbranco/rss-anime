import "./proxy.js"; // registra globalThis.__seriesTrackerFetch antes de usar engine.js
import * as engine from "../extension/engine.js";
import { get, set } from "../extension/store.js";
import { live, add, mutate } from "../extension/list.js";
import * as groups from "../extension/groups.js";
import { signIn, signUp, signOut, getSession, syncNow, saveAppProviders, searchPublicGroups, rateGroup } from "../extension/sync.js";
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
  await renderLangFilter();
}

// Un checkbox por cada idioma distinto que declaren los providers (providers sin "language"
// caen en "?"). La selección se recuerda localmente; sin preferencia guardada, todo marcado.
async function renderLangFilter() {
  const langs = [...new Set(providers.map(p => p.language || "?"))].sort();
  const saved = await get("search_languages", null);
  $("#langFilter").replaceChildren(...langs.map(l => {
    const cb = el("input", { type: "checkbox", checked: saved ? saved.includes(l) : true });
    cb.dataset.lang = l;
    cb.onchange = () => set("search_languages", selectedLangs());
    return el("label", {}, cb, l.toUpperCase());
  }));
}

const selectedLangs = () => [...$("#langFilter").querySelectorAll("input:checked")].map(c => c.dataset.lang);

$("#tabAll").onclick = () => setView("all");
$("#tabExplore").onclick = () => setView("explore");
$("#tabConfig").onclick = () => setView("config");

function setView(v) {
  $("#allView").hidden = v !== "all";
  $("#exploreView").hidden = v !== "explore";
  $("#configView").hidden = v !== "config";
  $("#tabAll").classList.toggle("active", v === "all");
  $("#tabExplore").classList.toggle("active", v === "explore");
  $("#tabConfig").classList.toggle("active", v === "config");
  if (v === "all") renderMain();
  if (v === "config") renderConfig();
}

$("#listFilter").addEventListener("change", () => { listFilter = document.querySelector('input[name="listf"]:checked').value; listPage = 0; renderMain(); });

async function renderConfig() {
  $("#providersJson").value = JSON.stringify(await get("providers", []), null, 2);
  $("#configMsg").textContent = "";
}

$("#saveProvidersBtn").onclick = async () => {
  let arr;
  try {
    arr = JSON.parse($("#providersJson").value);
    if (!Array.isArray(arr)) throw new Error("Debe ser una lista [ ... ]");
    for (const p of arr) {
      for (const k of ["id", "base_url", "search", "episode"]) if (!p[k]) throw new Error(`Falta "${k}" en un provider`);
      if (!p.search.slug_regex) throw new Error(`Falta search.slug_regex en "${p.id}"`);
      new URL(p.base_url);
    }
  } catch (e) { $("#configMsg").textContent = "JSON no válido: " + e.message; return; }

  try { await saveAppProviders(arr); }
  catch (e) { $("#configMsg").textContent = "Error al guardar: " + explain(e); return; }
  await fillProviders();
  $("#configMsg").textContent = "Guardado.";
};

const epsSel = new Map(); // "provider|slug" -> episodio seleccionado, o null

function renderItemEpisodePanel(item, episode, seen, onChange) {
  const p = prov(item.provider);
  const url = p ? engine.episodeUrl(p, item.slug, episode) : null;
  const playerBox = el("div", {});
  return el("div", { className: "card" },
    el("div", { className: "body" },
      el("b", { textContent: `${item.title} — episodio ${episode}` }),
      el("div", { className: "actions" },
        seen
          ? btn("Desmarcar", async () => { await mutate(item.provider, item.slug, x => { x.last = Math.min(x.last || 0, episode - 1); }); onChange(); })
          : btn("Marcar visto", async () => { await mutate(item.provider, item.slug, x => { x.last = Math.max(x.last || 0, episode); }); onChange(); }),
        url ? link(url, "Abrir") : "",
        p ? btn("▶ Ver aquí", async () => {
              playerBox.textContent = "Buscando servidores…";
              try { renderPlayerPicker(playerBox, await engine.episodePlayers(p, item.slug, episode)); }
              catch (e) { playerBox.textContent = "Error: " + explain(e); }
            }) : "",
        btn("Cerrar", () => { epsSel.delete(`${item.provider}|${item.slug}`); onChange(); })),
      playerBox));
}

// Nombres de los grupos (propios o suscritos) cuyo itinerario todavía usa este título.
// Quitarlo de la lista rompería su seguimiento ahí (el paso deja de encontrar el ítem:
// pierde avatar real y el botón "Visto" desaparece), así que "Quitar" lo bloquea si hay alguno.
function groupsReferencing(item, myGroups, subGroups) {
  return [...myGroups, ...subGroups]
    .filter(g => (g.steps || []).some(s => s.provider === item.provider && s.slug === item.slug))
    .map(g => g.name);
}

function itemCard(item, myGroups, subGroups) {
  const st = el("div", { className: "msg" });
  const eps = el("div", { className: "itin" });
  const key = `${item.provider}|${item.slug}`;
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
            const renderEps = () => {
              const sel = epsSel.get(key);
              eps.replaceChildren(
                ...(l.length ? l.map(e => {
                  const seen = e.number <= (item.last || 0);
                  const badge = el("span", {
                    className: "ep" + (seen ? " seen" : "") + (sel === e.number ? " selected" : ""),
                    textContent: String(e.number)
                  });
                  badge.onclick = () => { epsSel.set(key, sel === e.number ? null : e.number); renderEps(); };
                  return badge;
                }) : ["Sin episodios"]),
                sel != null ? renderItemEpisodePanel(item, sel, sel <= (item.last || 0), renderEps) : "");
            };
            renderEps();
          } catch (e) { eps.textContent = "Error: " + explain(e); }
        }),
        btn("Visto +1", async () => {
          const it = await mutate(item.provider, item.slug, x => { x.last = (x.last || 0) + 1; });
          if (it) {
            const news = await get("news", []);
            await set("news", news.filter(n => !(n.provider === it.provider && n.slug === it.slug && n.episode <= it.last)));
          }
          renderMain(); requestSync();
        }),
        btn("Ocultar", async () => {
          // A diferencia de Quitar, esconder no borra nada ni rompe el seguimiento de ningún
          // grupo: el ítem sigue en watchlist, solo deja de mostrarse como tarjeta suelta.
          await mutate(item.provider, item.slug, x => { x.visible = false; });
          renderMain(); requestSync();
        }),
        btn("Quitar", async () => {
          const refs = groupsReferencing(item, myGroups, subGroups);
          if (refs.length) {
            $("#searchMsg").textContent = `No se puede quitar: lo usa el grupo "${refs[0]}"${refs.length > 1 ? ` y ${refs.length - 1} más` : ""}. Quita ese paso del grupo (o date de baja) primero.`;
            return;
          }
          await mutate(item.provider, item.slug, x => { x.deleted = true; }); renderMain(); requestSync();
        })),
      st, eps));
}

const PALETTE = ["#2f6690", "#b8560f", "#2f7a4f", "#7a3b9e", "#a83a2c", "#5c6169"];
const ITIN_PAGE_SIZE = 25;
const itinPage = new Map(); // id de grupo -> página actual del itinerario

function titleColors(steps) {
  const map = new Map();
  for (const s of steps) {
    const key = `${s.provider}|${s.slug}`;
    if (!map.has(key)) map.set(key, PALETTE[map.size % PALETTE.length]);
  }
  return map;
}

const itinSel = new Map(); // id de grupo -> episodio seleccionado ({step, episode, item, seen}) o null

function avatarEl(title, color, isCur, image) {
  const cls = "avatar" + (isCur ? " current" : "");
  const ph = () => el("div", { className: cls + " avatar-ph", title,
    textContent: title[0]?.toUpperCase() || "?", style: `--av:${color}` });
  if (!image) return ph();
  const img = el("img", { src: image, title, className: cls, style: `--av:${color}` });
  img.onerror = () => img.replaceWith(ph()); // portada rota/bloqueada: cae al marcador de color
  return img;
}

const avatarSel = new Map(); // id de grupo -> índice del título mostrado en el carrusel

function distinctTitles(g) {
  return [...new Map(g.steps.map(s => [`${s.provider}|${s.slug}`, s])).values()];
}

// Un carrusel real: una imagen a la vez, con flechas. Si hay un episodio seleccionado
// en el itinerario, muestra el título al que pertenece (se sincroniza desde el
// onclick de los badges, ver renderItinerary); si no, muestra el paso actual.
function renderAvatars(g, cur, watchlist, onChange) {
  const distinct = distinctTitles(g);
  if (!distinct.length) return el("div", {});
  const colors = titleColors(g.steps);
  if (!avatarSel.has(g.id)) {
    const curIdx = cur ? distinct.findIndex(s => s.provider === cur.step.provider && s.slug === cur.step.slug) : 0;
    avatarSel.set(g.id, Math.max(0, curIdx));
  }
  const idx = Math.min(avatarSel.get(g.id), distinct.length - 1);
  const s = distinct[idx];
  const it = watchlist.find(w => w.provider === s.provider && w.slug === s.slug);
  const isCur = !!cur && cur.step.provider === s.provider && cur.step.slug === s.slug;
  const move = d => { avatarSel.set(g.id, (idx + d + distinct.length) % distinct.length); onChange(); };
  return el("div", { className: "avatars" },
    distinct.length > 1 ? btn("◀", () => move(-1)) : "",
    avatarEl(it ? it.title : s.slug, colors.get(`${s.provider}|${s.slug}`), isCur, it?.image),
    distinct.length > 1 ? btn("▶", () => move(1)) : "");
}

// Pestañas SUB/DUB + botones de servidor; al elegir uno, embebe su iframe debajo.
// No todos los servidores que lista un provider sirven para esto — solo entran aquí los que
// engine.episodePlayers() ya filtró como embebibles (ver ese comentario en engine.js).
function renderPlayerPicker(box, players) {
  if (!players || (!players.SUB.length && !players.DUB.length)) {
    box.textContent = "Este provider no tiene servidores para ver aquí.";
    return;
  }
  const tracks = ["SUB", "DUB"].filter(t => players[t].length);
  const trackSel = el("select", {});
  const serverSel = el("select", {});
  const frame = el("div", {});

  const loadFrame = () => {
    const s = players[trackSel.value][serverSel.selectedIndex];
    frame.replaceChildren(el("iframe", { src: s.url, className: "player-frame", allow: "autoplay; fullscreen" }));
  };
  const fillServers = () => {
    serverSel.replaceChildren(...players[trackSel.value].map(s => el("option", { value: s.server, textContent: s.server })));
    loadFrame();
  };
  trackSel.replaceChildren(...tracks.map(t => el("option", { value: t, textContent: t })));
  trackSel.onchange = fillServers;
  serverSel.onchange = loadFrame;
  fillServers(); // carga el primer servidor del primer track sin esperar un clic más

  box.replaceChildren(el("div", { className: "row" }, trackSel, serverSel), frame);
}

// Tarjeta de acción del episodio seleccionado: marcar/desmarcar visto, abrir su página o
// verlo aquí mismo con un servidor embebible.
function renderEpisodePanel(g, sel, onChange) {
  const title = sel.item ? sel.item.title : sel.step.slug;
  const p = prov(sel.step.provider);
  const url = p ? engine.episodeUrl(p, sel.step.slug, sel.episode) : null;
  const playerBox = el("div", {});
  return el("div", { className: "card" },
    el("div", { className: "body" },
      el("b", { textContent: `${title} — episodio ${sel.episode}` }),
      el("div", { className: "actions" },
        sel.seen
          ? btn("Desmarcar", async () => { await groups.unmarkFrom(sel.step, sel.episode); itinSel.delete(g.id); onChange(); })
          : btn("Marcar visto", async () => { await groups.markUpTo(sel.step, sel.episode); itinSel.delete(g.id); onChange(); }),
        url ? link(url, "Abrir") : "",
        p ? btn("▶ Ver aquí", async () => {
              playerBox.textContent = "Buscando servidores…";
              try { renderPlayerPicker(playerBox, await engine.episodePlayers(p, sel.step.slug, sel.episode)); }
              catch (e) { playerBox.textContent = "Error: " + explain(e); }
            }) : "",
        btn("Cerrar", () => { itinSel.delete(g.id); renderMain(); })),
      playerBox));
}

function renderItinerary(g, cur, watchlist, onChange) {
  const items = groups.itinerary(g, watchlist);
  if (!items.length) return el("div", {});
  const colors = titleColors(g.steps);
  const curIdx = cur ? items.findIndex(e => e.step === cur.step && e.episode === cur.next) : -1;
  const pages = Math.max(1, Math.ceil(items.length / ITIN_PAGE_SIZE));
  if (!itinPage.has(g.id)) itinPage.set(g.id, curIdx >= 0 ? Math.floor(curIdx / ITIN_PAGE_SIZE) : 0);
  const page = Math.min(itinPage.get(g.id), pages - 1);
  const start = page * ITIN_PAGE_SIZE;
  const sel = itinSel.get(g.id);

  const badges = items.slice(start, start + ITIN_PAGE_SIZE).map((e, i) => {
    const globalIdx = start + i;
    const color = colors.get(`${e.step.provider}|${e.step.slug}`);
    const isSel = sel && sel.step === e.step && sel.episode === e.episode;
    const badge = el("span", {
      className: "ep" + (e.seen ? " seen" : "") + (globalIdx === curIdx ? " now" : "") + (isSel ? " selected" : ""),
      textContent: String(globalIdx + 1),
      title: `Episodio ${e.episode} de ${e.item ? e.item.title : e.step.slug}`,
      style: `border-color:${color}` + (e.seen ? `;background:${color}` : "")
    });
    // Un toque selecciona/abre la tarjeta de acción; toca otra vez para cerrarla.
    // También cambia el carrusel de avatares al título de este episodio.
    badge.onclick = () => {
      itinSel.set(g.id, isSel ? null : { step: e.step, episode: e.episode, item: e.item, seen: e.seen });
      const idx = distinctTitles(g).findIndex(s => s.provider === e.step.provider && s.slug === e.step.slug);
      if (idx >= 0) avatarSel.set(g.id, idx);
      renderMain();
    };
    return badge;
  });

  return el("div", {},
    el("div", { className: "itin" }, ...badges),
    pages > 1
      ? el("div", { className: "row hint" },
          btn("◀", () => { itinPage.set(g.id, Math.max(0, page - 1)); renderMain(); }),
          el("span", { textContent: `Página ${page + 1} de ${pages}` }),
          btn("▶", () => { itinPage.set(g.id, Math.min(pages - 1, page + 1)); renderMain(); }))
      : "",
    sel ? renderEpisodePanel(g, sel, onChange) : "");
}

function groupCard(g, watchlist, owned) {
  // El grupo original se despublicó o se borró, así que ya no está en subscribed_groups — pero la
  // suscripción sigue viva. Sin este hueco la tarjeta desaparecía y con ella el único botón para
  // darse de baja, dejando la suscripción imposible de quitar desde la UI.
  if (g._unavailable) {
    return el("div", { className: "card" },
      el("div", { className: "body" },
        el("div", { className: "hint", textContent: "Grupo ya no disponible." }),
        el("div", { className: "actions" },
          btn("Darse de baja", async () => { await groups.unsubscribe(g.user_id, g.id); renderMain(); sync(); }))));
  }
  const cur = groups.currentStep(g, watchlist);
  const st = el("div", { className: "msg" });
  const onMark = async (step, episode) => {
    const it = await groups.markUpTo(step, episode);
    if (it) {
      const news = await get("news", []);
      await set("news", news.filter(n => !(n.provider === it.provider && n.slug === it.slug && n.episode <= it.last)));
    }
    renderMain(); requestSync();
  };
  const body = !cur
    ? el("div", { textContent: "✓ Terminado" })
    : el("div", {},
        el("div", { textContent:
          `Paso ${g.steps.indexOf(cur.step) + 1} de ${g.steps.length}: ` +
          `${cur.item ? cur.item.title : cur.step.slug} — episodio ${cur.next}` }),
        cur.item
          ? el("div", { className: "actions" },
              btn("Siguiente", async () => {
                const p = prov(cur.step.provider);
                st.textContent = "Comprobando…";
                try {
                  const r = await engine.checkEpisode(p, cur.step.slug, cur.next);
                  st.replaceChildren(r.exists ? link(r.url, `Ep ${cur.next} disponible ▶`) : `Ep ${cur.next}: aún no`);
                } catch (e) { st.textContent = "Error: " + explain(e); }
              }),
              btn("Visto", () => onMark(cur.step, cur.next)))
          : el("div", { className: "hint",
              textContent: `⚠ ${cur.step.provider}/${cur.step.slug} ya no está en tu lista` }),
        st);
  const missing = groups.missingSteps(g, watchlist);
  return el("div", { className: "card" },
    el("div", { className: "body" },
      el("b", { textContent: g.name }),
      owned ? "" : el("div", { className: "hint", textContent: "de otra cuenta" }),
      missing.length
        ? el("div", { className: "hint" },
            `⚠ ${missing.length} título${missing.length === 1 ? "" : "s"} de este grupo no ${missing.length === 1 ? "está" : "están"} en tu lista. `,
            btn("Reparar", async () => { await groups.repairGroup(g, watchlist); renderMain(); requestSync(); }))
        : "",
      renderAvatars(g, cur, watchlist, () => { renderMain(); }),
      body,
      renderItinerary(g, cur, watchlist, () => { renderMain(); requestSync(); }),
      el("div", { className: "actions" },
        owned
          ? btn("Borrar grupo", async () => { await groups.removeGroup(g.id); renderMain(); requestSync(); })
          // sync() (no requestSync() a secas): vuelve a pintar cuando la sync termina, para que la
          // tarjeta desaparezca de verdad en cuanto refreshSubscribedGroups() deje de traerla.
          : btn("Darse de baja", async () => { await groups.unsubscribe(g.user_id, g.id); renderMain(); sync(); }))));
}

const LIST_PAGE_SIZE = 10;
let listFilter = "both";
let listPage = 0;

async function renderMain() {
  const watchlist = live(await get("watchlist", []));
  const myGroups = groups.live(await get("groups", []));
  // La fuente de verdad de "estoy suscrito" es group_subscriptions; subscribed_groups es solo la
  // caché de solo lectura del grupo original. Iteramos las suscripciones vivas para que una cuyo
  // grupo ya no esté en la caché (despublicado o borrado) siga teniendo su hueco con el botón de
  // baja. El live() sobre la caché es defensa en profundidad: una copia vieja pudo colarse antes
  // de que el filtro deleted=eq.false existiera.
  const subGroups = groups.live(await get("subscribed_groups", []));
  const subEntries = groups.liveSubscriptions(await get("group_subscriptions", [])).map(s => {
    const g = subGroups.find(x => x.user_id === s.owner_id && x.id === s.group_id);
    return g
      ? { kind: "group", data: g, owned: false, ts: g.updated_at }
      : { kind: "group", owned: false, ts: s.updated_at,
          data: { id: s.group_id, user_id: s.owner_id, name: null, steps: [], _unavailable: true } };
  });
  const entries = [];
  if (listFilter !== "groups") entries.push(...watchlist.filter(item => item.visible !== false).map(item => ({ kind: "item", data: item, ts: item.updated_at })));
  if (listFilter !== "media") {
    entries.push(...myGroups.map(g => ({ kind: "group", data: g, owned: true, ts: g.updated_at })));
    entries.push(...subEntries);
  }
  entries.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));

  const pages = Math.max(1, Math.ceil(entries.length / LIST_PAGE_SIZE));
  listPage = Math.min(listPage, pages - 1);
  const start = listPage * LIST_PAGE_SIZE;
  const page = entries.slice(start, start + LIST_PAGE_SIZE);

  $("#list").replaceChildren(...(page.length
    ? page.map(e => (e.kind === "item" ? itemCard(e.data, myGroups, subGroups) : groupCard(e.data, watchlist, e.owned)))
    : ["Nada que mostrar con este filtro."]));
  $("#listPager").replaceChildren(...(pages > 1
    ? [btn("◀", () => { listPage = Math.max(0, listPage - 1); renderMain(); }),
       el("span", { textContent: `Página ${listPage + 1} de ${pages}` }),
       btn("▶", () => { listPage = Math.min(pages - 1, listPage + 1); renderMain(); })]
    : []));
}

const EXPLORE_PAGE_SIZE = 10;
let exploreResults = [];
let explorePage = 0;

$("#exploreBtn").onclick = async () => {
  const q = $("#exploreQ").value.trim();
  $("#exploreResults").replaceChildren("Buscando…");
  try {
    exploreResults = await searchPublicGroups(q);
    explorePage = 0;
    renderExplore();
  } catch (e) { $("#exploreResults").replaceChildren("Error: " + explain(e)); }
};

function exploreCard(g) {
  const st = el("div", { className: "hint" });
  const stars = el("select", {});
  stars.replaceChildren(...[1, 2, 3, 4, 5].map(n => el("option", { value: n, textContent: `${n} ★` })));
  return el("div", { className: "card" },
    el("div", { className: "body" },
      el("b", { textContent: g.name }),
      el("div", { className: "hint", textContent:
        g.rating_count ? `${g.rating_avg.toFixed(1)} ★ (${g.rating_count})` : "Sin valoraciones" }),
      el("div", { className: "actions" },
        btn("Suscribirme", async () => {
          await groups.subscribe(g, live(await get("watchlist", [])));
          st.textContent = "Suscrito.";
          sync(); // sync() = requestSync() + repintar: la nueva suscripción aparece en la lista
        }),
        stars,
        btn("Valorar", async () => {
          try { await rateGroup(g.user_id, g.id, +stars.value); st.textContent = "Gracias por valorar."; }
          catch (e) { st.textContent = "Error: " + explain(e); }
        })),
      st));
}

function renderExplore() {
  const pages = Math.max(1, Math.ceil(exploreResults.length / EXPLORE_PAGE_SIZE));
  explorePage = Math.min(explorePage, pages - 1);
  const start = explorePage * EXPLORE_PAGE_SIZE;
  const page = exploreResults.slice(start, start + EXPLORE_PAGE_SIZE);
  $("#exploreResults").replaceChildren(...(page.length ? page.map(exploreCard) : ["Sin resultados"]));
  $("#explorePager").replaceChildren(...(pages > 1
    ? [btn("◀", () => { explorePage = Math.max(0, explorePage - 1); renderExplore(); }),
       el("span", { textContent: `Página ${explorePage + 1} de ${pages}` }),
       btn("▶", () => { explorePage = Math.min(pages - 1, explorePage + 1); renderExplore(); })]
    : []));
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

async function applyAdminVisibility() {
  const admin = await get("is_admin", false);
  $("#tabConfig").hidden = !admin;
  if (!admin && !$("#configView").hidden) setView("all"); // no lo dejamos varado si deja de ser admin
}

async function sync(quiet = true) {
  $("#cloud").textContent = "sync…";
  try {
    await requestSync();
    $("#cloud").textContent = "✓";
    await fillProviders(); await renderMain(); await renderFeed();
    await applyAdminVisibility();
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
  await fillProviders(); await renderMain(); await renderFeed();
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
  const langs = new Set(selectedLangs());
  const targets = providers.filter(p => langs.has(p.language || "?"));
  $("#searchMsg").textContent = "";
  if (!q) { $("#searchMsg").textContent = "Escribe algo para buscar."; return; }
  if (!targets.length) { $("#searchMsg").textContent = "Selecciona al menos un idioma."; return; }
  $("#searchMsg").textContent = "Buscando…";
  const settled = await Promise.allSettled(targets.map(p =>
    engine.search(p, q).then(res => res.map(r => ({ ...r, _providerName: p.name || p.id })))));
  const merged = settled.flatMap(r => (r.status === "fulfilled" ? r.value : []));
  const rejected = settled.filter(r => r.status === "rejected");
  // Si TODOS los providers fallaron, "Sin resultados" mentiría (parece "no hay nada" cuando en
  // realidad la búsqueda ni se pudo hacer) — se muestra el error real del primero.
  $("#searchMsg").textContent = merged.length
    ? (rejected.length ? `${rejected.length} provider(s) fallaron al buscar` : "")
    : (rejected.length ? "Error: " + explain(rejected[0].reason) : "Sin resultados");
  $("#results").replaceChildren(...merged.map(r => el("div", { className: "card" },
    r.image ? el("img", { src: safe(r.image) }) : "",
    el("div", { className: "body" }, el("b", { textContent: r.title }),
      el("div", { className: "hint", textContent: r._providerName }),
      el("div", { className: "actions" },
        btn("＋ Guardar", async () => { await add(r); await renderMain(); requestSync(); $("#searchMsg").textContent = "Guardada"; }),
        link(r.link, "Abrir"))))));
};
$("#q").addEventListener("keydown", e => { if (e.key === "Enter") $("#go").click(); });

$("#all").onclick = async () => { $("#searchMsg").textContent = "Comprobando…"; await sync(false); $("#searchMsg").textContent = "Listo"; };
$("#copyFeed").onclick = async () => {
  try { await navigator.clipboard.writeText($("#feedUrl").value); $("#copyFeed").textContent = "✓"; setTimeout(() => { $("#copyFeed").textContent = "Copiar"; }, 1500); }
  catch { $("#feedUrl").select(); }
};

let draftSteps = [];

$("#newGroup").onclick = async () => {
  draftSteps = [];
  $("#groupName").value = "";
  $("#groupPublic").checked = false;
  $("#stepFrom").value = "1";
  $("#stepTo").value = "1";
  $("#stepExclude").value = "";
  $("#groupMsg").textContent = "";
  renderDraftSteps();
  const items = live(await get("watchlist", []));
  $("#stepItem").replaceChildren(...items.map(it =>
    el("option", { value: `${it.provider}|${it.slug}`, textContent: it.title })));
  $("#stepSearchProv").replaceChildren(...providers.map(p =>
    el("option", { value: p.id, textContent: `${p.name || p.id} (${(p.language || "?").toUpperCase()})` })));
  $("#stepSearchQ").value = "";
  $("#stepSearchResults").replaceChildren();
  importDraft = [];
  $("#importJson").value = "";
  $("#importAssign").hidden = true;
  $("#importResults").hidden = true;
  $("#importResults").replaceChildren();
  $("#importProviderPick").replaceChildren(...providers.map(p => el("option", { value: p.id, textContent: p.name || p.id })));
  $("#groupForm").hidden = false;
};

$("#cancelGroupBtn").onclick = () => { $("#groupForm").hidden = true; };

function renderDraftSteps() {
  $("#groupSteps").replaceChildren(...draftSteps.map((s, i) => el("div", { className: "row" },
    el("span", { textContent:
      `${i + 1}. ${s.slug} (${s.from}-${s.to}${s.exclude.length ? ", excl " + s.exclude.join(",") : ""})` }),
    btn("↑", () => { if (i > 0) { [draftSteps[i - 1], draftSteps[i]] = [draftSteps[i], draftSteps[i - 1]]; renderDraftSteps(); } }),
    btn("↓", () => { if (i < draftSteps.length - 1) { [draftSteps[i + 1], draftSteps[i]] = [draftSteps[i], draftSteps[i + 1]]; renderDraftSteps(); } }),
    btn("✕", () => { draftSteps.splice(i, 1); renderDraftSteps(); }))));
}

const readRange = () => ({
  from: +$("#stepFrom").value || 1,
  to: +$("#stepTo").value || 1,
  exclude: $("#stepExclude").value.split(",").map(s => +s.trim()).filter(Boolean)
});
const clearRange = () => { $("#stepFrom").value = "1"; $("#stepTo").value = "1"; $("#stepExclude").value = ""; };

$("#addStepBtn").onclick = () => {
  const [provider, slug] = ($("#stepItem").value || "").split("|");
  if (!provider) return;
  draftSteps.push({ provider, slug, ...readRange() });
  clearRange();
  renderDraftSteps();
};

// Alternativa a "elige de tu lista": buscar directamente en un provider concreto y añadir el
// paso con ESE provider+slug, sin tocar la entrada de esa serie que ya tuvieras (si la tenías
// con otro provider). Igual que hace el asistente de import, guarda en la lista antes de
// añadir el paso — si no, el paso apuntaría a un ítem que no existe.
$("#stepSearchBtn").onclick = async () => {
  const p = prov($("#stepSearchProv").value);
  const q = $("#stepSearchQ").value.trim();
  if (!p || !q) return;
  $("#stepSearchResults").replaceChildren("Buscando…");
  try {
    const res = await engine.search(p, q);
    $("#stepSearchResults").replaceChildren(...(res.length
      ? res.map(r => btn(r.title, async () => {
          await add(r, { visible: false }); // solo para el paso, no es media añadida a propósito
          draftSteps.push({ provider: r.provider, slug: r.slug, ...readRange() });
          clearRange();
          renderDraftSteps();
          $("#stepSearchResults").replaceChildren();
          $("#stepSearchQ").value = "";
        }))
      : ["Sin resultados"]));
  } catch (e) { $("#stepSearchResults").replaceChildren("Error: " + explain(e)); }
};

let importDraft = [];

// Paso 1: pegar el JSON de una IA (título + rango) y leerlo.
$("#importParseBtn").onclick = () => {
  let data;
  try { data = JSON.parse($("#importJson").value); }
  catch (e) { $("#groupMsg").textContent = "JSON inválido: " + e.message; return; }
  if (data.name) $("#groupName").value = data.name;
  importDraft = (data.steps || []).map(s => ({
    title: s.title || "", from: s.from ?? 1, to: s.to ?? 1, exclude: s.exclude || [], provider: null
  }));
  renderImportRows();
  $("#importAssign").hidden = false;
  $("#importResults").hidden = true;
  $("#importResults").replaceChildren();
};

function renderImportRows() {
  $("#importRows").replaceChildren(...importDraft.map((row, i) => el("div", { className: "row" },
    el("input", { type: "checkbox", id: `imp${i}` }),
    el("span", { textContent: `${row.title}${row.provider ? " → " + (prov(row.provider)?.name || row.provider) : ""}` }))));
}

// Paso 2: marcar uno o varios títulos y aplicarles el provider elegido a la vez.
$("#importApplyBtn").onclick = () => {
  const p = $("#importProviderPick").value;
  if (!p) return;
  let n = 0;
  importDraft.forEach((row, i) => { if ($("#imp" + i).checked) { row.provider = p; n++; } });
  renderImportRows();
  $("#groupMsg").textContent = n ? `Provider aplicado a ${n} título${n === 1 ? "" : "s"}.` : "Marca al menos un título primero.";
};

// Paso 3: buscar cada título en su provider y dejar elegir el resultado correcto.
$("#importSearchBtn").onclick = async () => {
  if (!importDraft.length) return;
  if (importDraft.some(r => !r.provider)) { $("#groupMsg").textContent = "Asigna un provider a todos los títulos antes de buscar"; return; }
  $("#importResults").hidden = false;
  $("#importResults").replaceChildren();
  for (const row of importDraft) {
    const list = el("div", {});
    const box = el("div", { className: "card" }, el("div", { className: "body" }, el("b", { textContent: row.title }), list));
    $("#importResults").append(box);
    try {
      const res = await engine.search(prov(row.provider), row.title);
      list.replaceChildren(...(res.length
        ? res.map(r => btn(r.title, async () => {
            // solo para el paso, no es media añadida a propósito (sin esto el paso apuntaría a un ítem que no existe)
            await add(r, { visible: false });
            draftSteps.push({ provider: row.provider, slug: r.slug, from: row.from, to: row.to, exclude: row.exclude });
            renderDraftSteps();
            box.remove();
          }))
        : [el("span", { className: "hint", textContent: "Sin resultados" })]));
    } catch (e) { list.textContent = "Error: " + explain(e); }
  }
};

$("#saveGroupBtn").onclick = async () => {
  const name = $("#groupName").value.trim();
  if (!name) { $("#groupMsg").textContent = "Ponle un nombre al grupo"; return; }
  if (!draftSteps.length) { $("#groupMsg").textContent = "Añade al menos un paso: usa ＋ Añadir paso, o Buscar + elegir resultado si vienes del JSON"; return; }
  const g = await groups.addGroup(name);
  for (const s of draftSteps) await groups.addStep(g.id, s);
  if ($("#groupPublic").checked) await groups.setPublic(g.id, true);
  $("#groupForm").hidden = true;
  renderMain();
  requestSync();
};

(async function init() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  await set("supabase", { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
  const s = await getSession();
  if (s) await showMain(); else await showAuth();
})();
