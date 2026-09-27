import { getSession } from "../app/sync.js";
import { $, explain } from "../app/ui/dom.js";
import { fillProviders } from "../app/ui/state.js";
import { ensurePermissions } from "../app/ui/permissions.js";
import { requestSync } from "../app/ui/sync.js";
import { renderMain, setListFilter } from "../app/ui/main-list.js";
import { renderNews } from "./ui/news.js";
import "../app/ui/search.js";
import "../app/ui/group-builder.js";
import "../app/ui/explore.js";

const msg = t => { $("#msg").textContent = t || ""; };

$("#tabAll").onclick = () => setView("all");
$("#tabExplore").onclick = () => setView("explore");

function setView(v) {
  $("#allView").hidden = v !== "all";
  $("#exploreView").hidden = v !== "explore";
  $("#tabAll").classList.toggle("active", v === "all");
  $("#tabExplore").classList.toggle("active", v === "explore");
  if (v === "all") renderMain();
}

$("#listFilter").addEventListener("change", () => {
  setListFilter(document.querySelector('input[name="listf"]:checked').value);
  renderMain();
});

// Sincroniza si hay sesión; en modo silencioso no molesta con errores.
async function sync(quiet = true) {
  if (!(await getSession())) { $("#cloud").textContent = ""; if (!quiet) msg("Inicia sesión en Opciones para sincronizar."); return; }
  $("#cloud").textContent = "sync…";
  try {
    await requestSync();
    $("#cloud").textContent = "✓";
    await fillProviders();
    if (!$("#allView").hidden) renderMain();
    if (!quiet) msg("Sincronizado");
  } catch (e) {
    $("#cloud").textContent = "⚠";
    if (!quiet) msg("Error de sync: " + explain(e));
  }
}

$("#opts").onclick = () => chrome.runtime.openOptionsPage();
$("#sync").onclick = () => sync(false);

$("#all").onclick = async () => {
  await ensurePermissions();
  msg("Sincronizando y comprobando en segundo plano…");
  try { await chrome.runtime.sendMessage({ type: "checkNow" }); await fillProviders(); renderMain(); msg("Listo"); }
  catch (e) { msg("Error: " + e.message); }
};

async function init() {
  await fillProviders();
  renderNews();
  renderMain();
  sync();
}

init();
