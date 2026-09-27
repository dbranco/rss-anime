import * as engine from "../engine.js";
import { get } from "../store.js";
import { live, add } from "../list.js";
import * as groups from "../groups.js";
import { $, el, btn, explain, msg } from "./dom.js";
import { providers, prov } from "./state.js";
import { ensurePermissions } from "./permissions.js";
import { requestSync } from "./sync.js";
import { renderMain } from "./main-list.js";

let draftSteps = [];
let importDraft = [];

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
  await ensurePermissions(p.id);
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
            // solo para el paso, no es media añadida a propósito (sin esto el paso apuntaría a un ítem que no existe)
            await add(r, { visible: false });
            draftSteps.push({ provider: row.provider, slug: r.slug, from: row.from, to: row.to, exclude: row.exclude });
            renderDraftSteps();
            box.remove();
          }))
        : [el("span", { className: "st", textContent: "Sin resultados" })]));
    } catch (e) { list.textContent = "Error: " + explain(e); }
  }
};

$("#newGroup").onclick = async () => {
  draftSteps = [];
  $("#groupName").value = "";
  $("#groupPublic").checked = false;
  $("#stepFrom").value = "1";
  $("#stepTo").value = "1";
  $("#stepExclude").value = "";
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

$("#saveGroupBtn").onclick = async () => {
  const name = $("#groupName").value.trim();
  if (!name) { msg("Ponle un nombre al grupo"); return; }
  if (!draftSteps.length) { msg("Añade al menos un paso: usa ＋ Añadir paso, o Buscar + elegir resultado si vienes del JSON"); return; }
  const g = await groups.addGroup(name);
  for (const s of draftSteps) await groups.addStep(g.id, s);
  if ($("#groupPublic").checked) await groups.setPublic(g.id, true);
  $("#groupForm").hidden = true;
  renderMain();
  requestSync();
};
