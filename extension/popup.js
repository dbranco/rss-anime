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
              eps.replaceChildren(...(l.length ? l.map(e => link(e.link, String(e.number))) : ["Sin episodios"]));
            } catch (e) { eps.textContent = "Error: " + explain(e); }
          }),
          btn("Visto +1", () => markSeen(item)),
          btn("Quitar", async () => { await mutate(item.provider, item.slug, x => { x.deleted = true; }); renderList(); sync(); })),
        st, eps));
  }));
}

async function renderGroups() {
  const list = groups.live(await get("groups", []));
  const watchlist = live(await get("watchlist", []));
  $("#groups").replaceChildren(...list.map(g => {
    const cur = groups.currentStep(g, watchlist);
    const st = el("div", { className: "st" });
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
                btn("Visto", async () => {
                  const it = await groups.markStepSeen(g, watchlist);
                  if (it) {
                    const news = await get("news", []);
                    await set("news", news.filter(n => !(n.provider === it.provider && n.slug === it.slug && n.episode <= it.last)));
                  }
                  renderGroups(); sync();
                }))
            : el("div", { className: "st",
                textContent: `⚠ ${cur.step.provider}/${cur.step.slug} ya no está en tu lista` }),
          st);
    return el("div", { className: "card" },
      el("div", { className: "body" },
        el("b", { textContent: g.name }),
        body,
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
        ? res.map(r => btn(r.title, () => {
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
