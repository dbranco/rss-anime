import * as tmdb from "../tmdb.js";
import { get } from "../store.js";
import { live, add } from "../list.js";
import * as groups from "../groups.js";
import { $, el, btn, explain } from "./dom.js";
import { ensurePermissions } from "./permissions.js";
import { requestSync } from "./sync.js";
import { renderMain } from "./main-list.js";

let draftSteps = [];
let importDraft = [];

function renderDraftSteps() {
  $("#groupSteps").replaceChildren(...draftSteps.map((s, i) => el("div", { className: "row" },
    el("span", { textContent:
      `${i + 1}. ${s.title} (${s.from}-${s.to}${s.exclude.length ? ", excl " + s.exclude.join(",") : ""})` }),
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
  const tmdbId = +($("#stepItem").value || 0);
  if (!tmdbId) return;
  const item = watchlistCache.find(w => w.tmdb_id === tmdbId);
  draftSteps.push({ tmdb_id: tmdbId, media_type: item?.media_type || "tv", title: item?.title || `#${tmdbId}`, ...readRange() });
  clearRange();
  renderDraftSteps();
};

// Búsqueda de TMDB reutilizable tanto para "añadir un paso nuevo" como para el asistente de
// import — un paso siempre referencia un tmdb_id, nunca un sitio de reproducción concreto.
async function searchAndPick(query, onPick) {
  await ensurePermissions(); // incluye api.themoviedb.org — ver permissions.js (Task 5)
  const lang = await get("lang_pref", "es-ES");
  const box = el("div", { textContent: "Buscando…" });
  try {
    const res = await tmdb.search(query, lang);
    box.replaceChildren(...(res.length
      ? res.map(r => btn(`${r.title}${r.year ? " (" + r.year + ")" : ""}`, () => onPick(r)))
      : ["Sin resultados"]));
  } catch (e) { box.textContent = "Error: " + explain(e); }
  return box;
}

$("#stepSearchBtn").onclick = async () => {
  const q = $("#stepSearchQ").value.trim();
  if (!q) return;
  $("#stepSearchResults").replaceChildren(await searchAndPick(q, async r => {
    await add(r, { visible: false }); // solo para el paso, no es media añadida a propósito
    draftSteps.push({ tmdb_id: r.tmdb_id, media_type: r.media_type, title: r.title, ...readRange() });
    clearRange();
    renderDraftSteps();
    $("#stepSearchResults").replaceChildren();
    $("#stepSearchQ").value = "";
  }));
};

$("#importParseBtn").onclick = () => {
  let data;
  try { data = JSON.parse($("#importJson").value); }
  catch (e) { $("#groupMsg").textContent = "JSON inválido: " + e.message; return; }
  if (data.name) $("#groupName").value = data.name;
  importDraft = (data.steps || []).map(s => ({
    title: s.title || "", from: s.from ?? 1, to: s.to ?? 1, exclude: s.exclude || []
  }));
  renderImportRows();
  $("#importAssign").hidden = false;
  $("#importResults").hidden = true;
  $("#importResults").replaceChildren();
};

function renderImportRows() {
  $("#importRows").replaceChildren(...importDraft.map(row => el("div", { className: "row" },
    el("span", { textContent: row.title }))));
}

// Busca cada título del import en TMDB directamente (ya no hace falta asignar provider por
// título primero — un paso es solo un tmdb_id).
$("#importSearchBtn").onclick = async () => {
  if (!importDraft.length) return;
  $("#importResults").hidden = false;
  $("#importResults").replaceChildren();
  for (const row of importDraft) {
    const box = el("div", { className: "card" }, el("div", { className: "body" }, el("b", { textContent: row.title })));
    $("#importResults").append(box);
    const results = await searchAndPick(row.title, async r => {
      await add(r, { visible: false });
      draftSteps.push({ tmdb_id: r.tmdb_id, media_type: r.media_type, title: r.title, from: row.from, to: row.to, exclude: row.exclude });
      renderDraftSteps();
      box.remove();
    });
    box.append(results);
  }
};

let watchlistCache = [];

$("#newGroup").onclick = async () => {
  draftSteps = [];
  $("#groupName").value = "";
  $("#groupPublic").checked = false;
  $("#stepFrom").value = "1";
  $("#stepTo").value = "1";
  $("#stepExclude").value = "";
  $("#groupMsg").textContent = "";
  renderDraftSteps();
  watchlistCache = live(await get("watchlist", []));
  $("#stepItem").replaceChildren(...watchlistCache.map(it =>
    el("option", { value: it.tmdb_id, textContent: it.title })));
  $("#stepSearchQ").value = "";
  $("#stepSearchResults").replaceChildren();
  importDraft = [];
  $("#importJson").value = "";
  $("#importAssign").hidden = true;
  $("#importResults").hidden = true;
  $("#importResults").replaceChildren();
  $("#groupForm").hidden = false;
};

$("#cancelGroupBtn").onclick = () => { $("#groupForm").hidden = true; };

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
