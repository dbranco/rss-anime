import * as engine from "./engine.js";
import { get, set } from "./store.js";
import { live, add, mutate } from "./list.js";
import * as groups from "./groups.js";
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
    if (!$("#groupsView").hidden) renderGroups();
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

$("#tabAll").onclick = () => setView("all");
$("#tabGroups").onclick = () => setView("groups");

function setView(v) {
  $("#allView").hidden = v !== "all";
  $("#groupsView").hidden = v !== "groups";
  $("#tabAll").classList.toggle("active", v === "all");
  $("#tabGroups").classList.toggle("active", v === "groups");
  if (v === "groups") renderGroups();
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
              eps.replaceChildren(...(l.length ? l.map(e => {
                const a = link(e.link, String(e.number));
                if (e.number <= (item.last || 0)) a.className = "seen";
                return a;
              }) : ["Sin episodios"]));
            } catch (e) { eps.textContent = "Error: " + explain(e); }
          }),
          btn("Visto +1", () => markSeen(item)),
          btn("Quitar", async () => { await mutate(item.provider, item.slug, x => { x.deleted = true; }); renderList(); sync(); })),
        st, eps));
  }));
}

const PALETTE = ["#2f6690", "#b8560f", "#2f7a4f", "#7a3b9e", "#a83a2c", "#5c6169"];
const ITIN_PAGE_SIZE = 25;
const itinPage = new Map(); // id de grupo -> página actual del itinerario

// Convierte un slug en un título legible (rezero-kara-... -> "Rezero Kara ...") para el ítem
// que crea "Reparar" — no es tan bonito como el título real, pero sirve para identificarlo
// y, sobre todo, ya existe en la lista y el grupo puede empezar a trackear su progreso.
const prettify = slug => slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());

function missingSteps(g, watchlist) {
  const seen = new Set();
  return g.steps.filter(s => {
    const key = `${s.provider}|${s.slug}`;
    if (seen.has(key)) return false; // no repetir el mismo ítem si aparece en varios pasos
    seen.add(key);
    return !watchlist.find(w => w.provider === s.provider && w.slug === s.slug);
  });
}

async function repairGroup(g, watchlist) {
  for (const s of missingSteps(g, watchlist)) {
    await add({ provider: s.provider, slug: s.slug, title: prettify(s.slug), link: null, image: null });
  }
}

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

function renderAvatars(g, cur, watchlist) {
  const distinct = [...new Map(g.steps.map(s => [`${s.provider}|${s.slug}`, s])).values()];
  const colors = titleColors(g.steps);
  return el("div", { className: "avatars" }, ...distinct.map(s => {
    const it = watchlist.find(w => w.provider === s.provider && w.slug === s.slug);
    const isCur = !!cur && cur.step.provider === s.provider && cur.step.slug === s.slug;
    return avatarEl(it ? it.title : s.slug, colors.get(`${s.provider}|${s.slug}`), isCur, it?.image);
  }));
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
        btn("Cerrar", () => { itinSel.delete(g.id); renderGroups(); })),
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
    badge.onclick = () => {
      itinSel.set(g.id, isSel ? null : { step: e.step, episode: e.episode, item: e.item, seen: e.seen });
      renderGroups();
    };
    return badge;
  });

  return el("div", {},
    el("div", { className: "itin" }, ...badges),
    pages > 1
      ? el("div", { className: "row st" },
          btn("◀", () => { itinPage.set(g.id, Math.max(0, page - 1)); renderGroups(); }),
          el("span", { textContent: `Página ${page + 1} de ${pages}` }),
          btn("▶", () => { itinPage.set(g.id, Math.min(pages - 1, page + 1)); renderGroups(); }))
      : "",
    sel ? renderEpisodePanel(g, sel, onChange) : "");
}

async function renderGroups() {
  const list = groups.live(await get("groups", []));
  const watchlist = live(await get("watchlist", []));
  $("#groups").replaceChildren(...list.map(g => {
    const cur = groups.currentStep(g, watchlist);
    const st = el("div", { className: "st" });
    const onMark = async (step, episode) => {
      const it = await groups.markUpTo(step, episode);
      if (it) {
        const news = await get("news", []);
        await set("news", news.filter(n => !(n.provider === it.provider && n.slug === it.slug && n.episode <= it.last)));
      }
      renderGroups(); sync();
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
            : el("div", { className: "st",
                textContent: `⚠ ${cur.step.provider}/${cur.step.slug} ya no está en tu lista` }),
          st);
    const missing = missingSteps(g, watchlist);
    return el("div", { className: "card" },
      el("div", { className: "body" },
        el("b", { textContent: g.name }),
        missing.length
          ? el("div", { className: "st" },
              `⚠ ${missing.length} título${missing.length === 1 ? "" : "s"} de este grupo no ${missing.length === 1 ? "está" : "están"} en tu lista. `,
              btn("Reparar", async () => { await repairGroup(g, watchlist); renderGroups(); sync(); }))
          : "",
        renderAvatars(g, cur, watchlist),
        body,
        renderItinerary(g, cur, watchlist, () => { renderGroups(); sync(); }),
        el("div", { className: "actions" },
          btn("Borrar grupo", async () => { await groups.removeGroup(g.id); renderGroups(); sync(); }))));
  }));
}

$("#all").onclick = async () => {
  msg("Sincronizando y comprobando en segundo plano…");
  try { await chrome.runtime.sendMessage({ type: "checkNow" }); await fillProviders(); renderList(); msg("Listo"); }
  catch (e) { msg("Error: " + e.message); }
};

let draftSteps = [];

$("#newGroup").onclick = async () => {
  draftSteps = [];
  $("#groupName").value = "";
  $("#stepFrom").value = "1";
  $("#stepTo").value = "1";
  $("#stepExclude").value = "";
  renderDraftSteps();
  const items = live(await get("watchlist", []));
  $("#stepItem").replaceChildren(...items.map(it =>
    el("option", { value: `${it.provider}|${it.slug}`, textContent: it.title })));
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

$("#addStepBtn").onclick = () => {
  const [provider, slug] = ($("#stepItem").value || "").split("|");
  if (!provider) return;
  const from = +$("#stepFrom").value || 1;
  const to = +$("#stepTo").value || 1;
  const exclude = $("#stepExclude").value.split(",").map(s => +s.trim()).filter(Boolean);
  draftSteps.push({ provider, slug, from, to, exclude });
  $("#stepFrom").value = "1";
  $("#stepTo").value = "1";
  $("#stepExclude").value = "";
  renderDraftSteps();
};

let importDraft = [];

// Paso 1: pegar el JSON de una IA (título + rango) y leerlo.
$("#importParseBtn").onclick = () => {
  let data;
  try { data = JSON.parse($("#importJson").value); }
  catch (e) { msg("JSON inválido: " + e.message); return; }
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
  msg(n ? `Provider aplicado a ${n} título${n === 1 ? "" : "s"}.` : "Marca al menos un título primero.");
};

// Paso 3: buscar cada título en su provider y dejar elegir el resultado correcto.
$("#importSearchBtn").onclick = async () => {
  if (!importDraft.length) return;
  if (importDraft.some(r => !r.provider)) { msg("Asigna un provider a todos los títulos antes de buscar"); return; }
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
            await add(r); // sin esto el paso apuntaría a un ítem que no existe en tu lista
            draftSteps.push({ provider: row.provider, slug: r.slug, from: row.from, to: row.to, exclude: row.exclude });
            renderDraftSteps();
            box.remove();
          }))
        : [el("span", { className: "st", textContent: "Sin resultados" })]));
    } catch (e) { list.textContent = "Error: " + explain(e); }
  }
};

$("#saveGroupBtn").onclick = async () => {
  const name = $("#groupName").value.trim();
  if (!name) { msg("Ponle un nombre al grupo"); return; }
  if (!draftSteps.length) { msg("Añade al menos un paso: usa ＋ Añadir paso, o Buscar + elegir resultado si vienes del JSON"); return; }
  const g = await groups.addGroup(name);
  for (const s of draftSteps) await groups.addStep(g.id, s);
  $("#groupForm").hidden = true;
  renderGroups();
  sync();
};

init();
